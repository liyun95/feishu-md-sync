import { sha256, stableStringify } from '../core/hash.js';
import type { FeishuBlock } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { isTextLikeBlockPairUpdateable } from './block-update.js';

export type PublishBlockPatchOperation =
  | {
    kind: 'update';
    parentBlockId: string;
    remoteBlockId: string;
    path: number[];
    desiredPath?: number[];
    blockType: number;
  }
  | {
    kind: 'create';
    parentBlockId: string;
    insertAfterBlockId: string;
    index: number;
    path: number[];
    blocks: FeishuBlock[];
  }
  | {
    kind: 'delete';
    parentBlockId: string;
    blockIds: string[];
    startIndex: number;
    endIndex: number;
    path: number[];
  };

export type PublishBlockPatchPlan = {
  kind: 'publish-block-patch-plan';
  safeToWrite: boolean;
  requiresCollaborationRiskConfirmation: boolean;
  operations: PublishBlockPatchOperation[];
  fallbackReason?: string;
  warnings: string[];
};

export function planPublishBlockPatch(input: {
  parentBlockId: string;
  remoteBlocks: FeishuBlock[];
  desiredBlocks: FeishuBlock[];
}): PublishBlockPatchPlan {
  const state: PlanningState = {
    operations: [],
    warnings: []
  };
  const fallbackReason = planSequence({
    parentBlockId: input.parentBlockId,
    remoteBlocks: input.remoteBlocks,
    desiredBlocks: input.desiredBlocks,
    path: [],
    state
  });
  const requiresCollaborationRiskConfirmation = state.operations.some((operation) => {
    return operation.kind === 'update' || operation.kind === 'delete';
  });

  return {
    kind: 'publish-block-patch-plan',
    safeToWrite: fallbackReason === undefined,
    requiresCollaborationRiskConfirmation,
    operations: fallbackReason ? [] : state.operations,
    fallbackReason,
    warnings: state.warnings
  };
}

type PlanningState = {
  operations: PublishBlockPatchOperation[];
  warnings: string[];
};

function planSequence(input: {
  parentBlockId: string;
  remoteBlocks: FeishuBlock[];
  desiredBlocks: FeishuBlock[];
  path: number[];
  state: PlanningState;
}): string | undefined {
  if (blocksEquivalent(input.remoteBlocks, input.desiredBlocks)) return undefined;

  const prefixLength = commonPrefixLength(input.remoteBlocks, input.desiredBlocks);
  const suffixLength = commonSuffixLength(input.remoteBlocks, input.desiredBlocks, prefixLength);
  const remoteMiddleEnd = input.remoteBlocks.length - suffixLength;
  const desiredMiddleEnd = input.desiredBlocks.length - suffixLength;
  const remoteMiddle = input.remoteBlocks.slice(prefixLength, remoteMiddleEnd);
  const desiredMiddle = input.desiredBlocks.slice(prefixLength, desiredMiddleEnd);

  if (remoteMiddle.length === 0 && desiredMiddle.length > 0) {
    const unsupported = desiredMiddle.find((block) => !isWritableMarkdownBlockForPatch(block));
    if (unsupported) {
      return `create block_type ${unsupported.block_type} is unsupported at ${formatPath([...input.path, prefixLength])}`;
    }
    const insertAfterBlockId = insertAfterBlockIdForCreate(input.remoteBlocks, input.parentBlockId, prefixLength);
    if (!insertAfterBlockId) {
      return `create anchor is missing at ${formatPath([...input.path, prefixLength])}`;
    }
    input.state.operations.push({
      kind: 'create',
      parentBlockId: input.parentBlockId,
      insertAfterBlockId,
      index: prefixLength,
      path: [...input.path, prefixLength],
      blocks: desiredMiddle
    });
    return undefined;
  }

  if (remoteMiddle.length > 0 && desiredMiddle.length === 0) {
    const unsupported = remoteMiddle.find((block) => !isWritableMarkdownBlockForPatch(block));
    if (unsupported) {
      return `delete block_type ${unsupported.block_type} is unsupported at ${formatPath([...input.path, prefixLength])}`;
    }
    const blockIds = blockIdsForDelete(remoteMiddle);
    if (blockIds.length !== remoteMiddle.length) {
      return `delete block id is missing at ${formatPath([...input.path, prefixLength])}`;
    }
    input.state.operations.push({
      kind: 'delete',
      parentBlockId: input.parentBlockId,
      blockIds,
      startIndex: prefixLength,
      endIndex: remoteMiddleEnd,
      path: [...input.path, prefixLength]
    });
    return undefined;
  }

  if (remoteMiddle.length !== desiredMiddle.length) {
    return planMixedSequence({
      ...input,
      prefixLength,
      remoteMiddle,
      desiredMiddle
    });
  }

  for (let index = 0; index < remoteMiddle.length; index += 1) {
    const remote = remoteMiddle[index];
    const desired = desiredMiddle[index];
    const absoluteIndex = prefixLength + index;
    const childPath = [...input.path, absoluteIndex];
    const fallbackReason = planBlockPair({
      parentBlockId: input.parentBlockId,
      remote,
      desired,
      path: childPath,
      state: input.state
    });
    if (fallbackReason) return fallbackReason;
  }

  return undefined;
}

function planMixedSequence(input: {
  parentBlockId: string;
  remoteBlocks: FeishuBlock[];
  desiredBlocks: FeishuBlock[];
  path: number[];
  state: PlanningState;
  prefixLength: number;
  remoteMiddle: FeishuBlock[];
  desiredMiddle: FeishuBlock[];
}): string | undefined {
  const anchors = uniqueStableAnchors(input.remoteMiddle, input.desiredMiddle);
  if (anchors.length === 0) {
    if (hasEquivalentCrossMatch(input.remoteMiddle, input.desiredMiddle)) {
      return `block order or count changed without a unique stable anchor at ${formatPath(input.path)}`;
    }
    const hasStableBoundary = input.prefixLength > 0 ||
      input.prefixLength + input.remoteMiddle.length < input.remoteBlocks.length ||
      input.prefixLength + input.desiredMiddle.length < input.desiredBlocks.length;
    if (hasStableBoundary) {
      return planMixedGap({
        ...input,
        remoteGap: input.remoteMiddle,
        desiredGap: input.desiredMiddle,
        remoteStart: input.prefixLength,
        desiredStart: input.prefixLength
      });
    }
    return `block order or count changed without a unique stable anchor at ${formatPath(input.path)}`;
  }
  for (let index = 1; index < anchors.length; index += 1) {
    if (anchors[index]!.desiredIndex <= anchors[index - 1]!.desiredIndex) {
      return `stable block correspondence is reordered at ${formatPath(input.path)}`;
    }
  }

  let previousRemoteIndex = -1;
  let previousDesiredIndex = -1;
  for (const anchor of [...anchors, {
    remoteIndex: input.remoteMiddle.length,
    desiredIndex: input.desiredMiddle.length
  }]) {
    const remoteStart = previousRemoteIndex + 1;
    const desiredStart = previousDesiredIndex + 1;
    const remoteGap = input.remoteMiddle.slice(remoteStart, anchor.remoteIndex);
    const desiredGap = input.desiredMiddle.slice(desiredStart, anchor.desiredIndex);
    const fallbackReason = planMixedGap({
      ...input,
      remoteGap,
      desiredGap,
      remoteStart: input.prefixLength + remoteStart,
      desiredStart: input.prefixLength + desiredStart
    });
    if (fallbackReason) return fallbackReason;
    previousRemoteIndex = anchor.remoteIndex;
    previousDesiredIndex = anchor.desiredIndex;
  }
  return undefined;
}

function planMixedGap(input: {
  parentBlockId: string;
  remoteBlocks: FeishuBlock[];
  desiredBlocks: FeishuBlock[];
  path: number[];
  state: PlanningState;
  remoteGap: FeishuBlock[];
  desiredGap: FeishuBlock[];
  remoteStart: number;
  desiredStart: number;
}): string | undefined {
  if (input.remoteGap.length === 0 && input.desiredGap.length === 0) return undefined;
  if (input.remoteGap.length === 1 && input.desiredGap.length === 1) {
    return planBlockPair({
      parentBlockId: input.parentBlockId,
      remote: input.remoteGap[0]!,
      desired: input.desiredGap[0]!,
      path: [...input.path, input.remoteStart],
      desiredPath: [...input.path, input.desiredStart],
      state: input.state
    });
  }

  if (hasEquivalentCrossMatch(input.remoteGap, input.desiredGap)) {
    return `mixed block correspondence is ambiguous at ${formatPath([...input.path, input.remoteStart])}`;
  }
  const unsupportedCreate = input.desiredGap.find((block) => !isWritableMarkdownBlockForPatch(block));
  if (unsupportedCreate) {
    return `create block_type ${unsupportedCreate.block_type} is unsupported at ${formatPath([...input.path, input.desiredStart])}`;
  }
  const unsupportedDelete = input.remoteGap.find((block) => !isWritableMarkdownBlockForPatch(block));
  if (unsupportedDelete) {
    return `delete block_type ${unsupportedDelete.block_type} is unsupported at ${formatPath([...input.path, input.remoteStart])}`;
  }
  const blockIds = blockIdsForDelete(input.remoteGap);
  if (blockIds.length !== input.remoteGap.length) {
    return `delete block id is missing at ${formatPath([...input.path, input.remoteStart])}`;
  }
  const insertAfterBlockId = insertAfterBlockIdForCreate(
    input.remoteBlocks,
    input.parentBlockId,
    input.remoteStart
  );
  if (!insertAfterBlockId) {
    return `create anchor is missing at ${formatPath([...input.path, input.remoteStart])}`;
  }
  if (input.desiredGap.length > 0) {
    input.state.operations.push({
      kind: 'create',
      parentBlockId: input.parentBlockId,
      insertAfterBlockId,
      index: input.desiredStart,
      path: [...input.path, input.desiredStart],
      blocks: input.desiredGap
    });
  }
  if (input.remoteGap.length > 0) {
    input.state.operations.push({
      kind: 'delete',
      parentBlockId: input.parentBlockId,
      blockIds,
      startIndex: input.remoteStart,
      endIndex: input.remoteStart + input.remoteGap.length,
      path: [...input.path, input.remoteStart]
    });
  }
  return undefined;
}

function uniqueStableAnchors(
  remoteBlocks: FeishuBlock[],
  desiredBlocks: FeishuBlock[]
): Array<{ remoteIndex: number; desiredIndex: number }> {
  const remoteByKey = indexesByMatchKey(remoteBlocks);
  const desiredByKey = indexesByMatchKey(desiredBlocks);
  return [...remoteByKey.entries()].flatMap(([key, remoteIndexes]) => {
    const desiredIndexes = desiredByKey.get(key);
    if (remoteIndexes.length !== 1 || desiredIndexes?.length !== 1) return [];
    const remoteIndex = remoteIndexes[0]!;
    const desiredIndex = desiredIndexes[0]!;
    const remote = remoteBlocks[remoteIndex];
    const desired = desiredBlocks[desiredIndex];
    return remote?.block_id && remote && desired && blocksEquivalent([remote], [desired])
      ? [{ remoteIndex, desiredIndex }]
      : [];
  }).sort((left, right) => left.remoteIndex - right.remoteIndex);
}

function indexesByMatchKey(blocks: FeishuBlock[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    const key = blockMatchKey(block);
    result.set(key, [...(result.get(key) ?? []), index]);
  });
  return result;
}

function blockMatchKey(block: FeishuBlock): string {
  return canUseCanonicalMarkdown([block])
    ? `markdown:${canonicalMarkdown([block])}`
    : `block:${hashComparableBlocks([block])}`;
}

function hasEquivalentCrossMatch(remoteBlocks: FeishuBlock[], desiredBlocks: FeishuBlock[]): boolean {
  return remoteBlocks.some((remote) => desiredBlocks.some((desired) => {
    return blocksEquivalent([remote], [desired]);
  }));
}

function planBlockPair(input: {
  parentBlockId: string;
  remote: FeishuBlock;
  desired: FeishuBlock;
  path: number[];
  desiredPath?: number[];
  state: PlanningState;
}): string | undefined {
  if (blocksEquivalent([input.remote], [input.desired])) return undefined;
  if (isWhiteboardBlock(input.remote) || isWhiteboardBlock(input.desired)) {
    return `whiteboard block changed at ${formatPath(input.path)}`;
  }

  if (hasBlockChildren(input.remote) || hasBlockChildren(input.desired)) {
    if (!input.remote.block_id) return `container block is missing block id at ${formatPath(input.path)}`;
    if (input.remote.block_type !== input.desired.block_type) {
      return `container block type changed at ${formatPath(input.path)}`;
    }
    if (!hasBlockChildren(input.remote) || !hasBlockChildren(input.desired)) {
      return `container block structure changed at ${formatPath(input.path)}`;
    }
    if (!containerShellEquivalent(input.remote, input.desired)) {
      return `container block shell changed at ${formatPath(input.path)}`;
    }
    return planSequence({
      parentBlockId: input.remote.block_id,
      remoteBlocks: input.remote.children,
      desiredBlocks: input.desired.children,
      path: input.path,
      state: input.state
    });
  }

  if (!isTextLikeBlockPairUpdateable(input.remote, input.desired)) {
    return `unsupported block change at ${formatPath(input.path)}`;
  }

  input.state.operations.push({
    kind: 'update',
    parentBlockId: input.parentBlockId,
    remoteBlockId: input.remote.block_id as string,
    path: input.path,
    ...(input.desiredPath && input.desiredPath.some((part, index) => part !== input.path[index])
      ? { desiredPath: input.desiredPath }
      : {}),
    blockType: input.remote.block_type
  });
  return undefined;
}

function commonPrefixLength(remote: FeishuBlock[], desired: FeishuBlock[]): number {
  const maxLength = Math.min(remote.length, desired.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (!blocksEquivalent([remote[index]], [desired[index]])) return index;
  }
  return maxLength;
}

function commonSuffixLength(remote: FeishuBlock[], desired: FeishuBlock[], prefixLength: number): number {
  const maxLength = Math.min(remote.length, desired.length) - prefixLength;
  for (let offset = 0; offset < maxLength; offset += 1) {
    const remoteIndex = remote.length - 1 - offset;
    const desiredIndex = desired.length - 1 - offset;
    if (!blocksEquivalent([remote[remoteIndex]], [desired[desiredIndex]])) return offset;
  }
  return maxLength;
}

function blocksEquivalent(remote: FeishuBlock[], desired: FeishuBlock[]): boolean {
  return hashComparableBlocks(remote) === hashComparableBlocks(desired) ||
    (canUseCanonicalMarkdown(remote) && canUseCanonicalMarkdown(desired) && canonicalMarkdown(remote) === canonicalMarkdown(desired));
}

function containerShellEquivalent(remote: FeishuBlock, desired: FeishuBlock): boolean {
  return hashComparableBlocks([stripContainerChildren(remote)]) === hashComparableBlocks([stripContainerChildren(desired)]);
}

function hashComparableBlocks(blocks: FeishuBlock[]): string {
  return sha256(stableStringify(blocks.map(normalizeBlockForPatch)));
}

function normalizeBlockForPatch(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeBlockForPatch);
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'block_id') continue;
      if (key === 'parent_id') continue;
      if (key === 'merge_info') continue;
      normalized[key] = normalizeBlockForPatch(child);
    }
    return normalized;
  }

  return value;
}

function canonicalMarkdown(blocks: FeishuBlock[]): string {
  return feishuBlocksToMarkdown(blocks)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function canUseCanonicalMarkdown(blocks: FeishuBlock[]): boolean {
  return blocks.every((block) => isWritableMarkdownBlockForPatch(block) && block.block_type !== 31);
}

function stripContainerChildren(block: FeishuBlock): FeishuBlock {
  const { children: _children, block_id: _blockId, parent_id: _parentId, ...rest } = block;
  return rest;
}

function hasBlockChildren(block: FeishuBlock): block is FeishuBlock & { children: FeishuBlock[] } {
  return Array.isArray(block.children) && block.children.every(isFeishuBlock);
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}

function isWhiteboardBlock(block: FeishuBlock): boolean {
  return 'whiteboard' in block;
}

function insertAfterBlockIdForCreate(remoteBlocks: FeishuBlock[], parentBlockId: string, index: number): string | undefined {
  if (index === 0) return parentBlockId;
  const previous = remoteBlocks[index - 1];
  return previous?.block_id;
}

function blockIdsForDelete(blocks: FeishuBlock[]): string[] {
  return blocks.flatMap((block) => block.block_id ? [block.block_id] : []);
}

function isWritableMarkdownBlockForPatch(block: FeishuBlock): boolean {
  const writableType = block.block_type === 2 || (block.block_type >= 3 && block.block_type <= 8) || block.block_type === 12 || block.block_type === 13 || block.block_type === 14 || block.block_type === 31;
  if (!writableType) return false;
  if (Array.isArray(block.children) && block.children.length > 0) {
    return (block.block_type === 12 || block.block_type === 13) &&
      block.children.every((child) => isFeishuBlock(child) && isWritableMarkdownBlockForPatch(child));
  }
  if (block.block_type !== 31) return true;
  const cells = (block.table as { cells?: unknown[] } | undefined)?.cells ?? [];
  return cells.every((cell) => isFeishuBlock(cell) && cell.block_type === 2 && (!Array.isArray(cell.children) || cell.children.length === 0));
}

function formatPath(path: number[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}
