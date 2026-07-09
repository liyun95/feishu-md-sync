import { sha256, stableStringify } from '../core/hash.js';
import type { FeishuBlock } from '../feishu/types.js';
import { isTextLikeBlockPairUpdateable } from '../sync/block-update.js';

export type PublishBlockPatchOperation =
  | {
    kind: 'update';
    remoteBlockId: string;
    path: number[];
    blockType: number;
  }
  | {
    kind: 'create';
    parentBlockId: string;
    index: number;
    path: number[];
    blocks: FeishuBlock[];
  }
  | {
    kind: 'delete';
    parentBlockId: string;
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
    input.state.operations.push({
      kind: 'create',
      parentBlockId: input.parentBlockId,
      index: prefixLength,
      path: [...input.path, prefixLength],
      blocks: desiredMiddle
    });
    return undefined;
  }

  if (remoteMiddle.length > 0 && desiredMiddle.length === 0) {
    input.state.operations.push({
      kind: 'delete',
      parentBlockId: input.parentBlockId,
      startIndex: prefixLength,
      endIndex: remoteMiddleEnd,
      path: [...input.path, prefixLength]
    });
    return undefined;
  }

  if (remoteMiddle.length !== desiredMiddle.length) {
    return `block order or count changed at ${formatPath(input.path)}`;
  }

  for (let index = 0; index < remoteMiddle.length; index += 1) {
    const remote = remoteMiddle[index];
    const desired = desiredMiddle[index];
    const absoluteIndex = prefixLength + index;
    const childPath = [...input.path, absoluteIndex];
    const fallbackReason = planBlockPair({
      remote,
      desired,
      path: childPath,
      state: input.state
    });
    if (fallbackReason) return fallbackReason;
  }

  return undefined;
}

function planBlockPair(input: {
  remote: FeishuBlock;
  desired: FeishuBlock;
  path: number[];
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
    remoteBlockId: input.remote.block_id as string,
    path: input.path,
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
  return hashComparableBlocks(remote) === hashComparableBlocks(desired);
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

function formatPath(path: number[]): string {
  return path.length === 0 ? '<root>' : path.join('.');
}
