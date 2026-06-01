import { hashBlocks } from '../core/hash.js';
import type { FeishuBlock } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { isTextLikeBlockPairUpdateable } from './block-update.js';

export type BlockLevelOperation =
  | {
    kind: 'update';
    remoteBlockId: string;
    remoteIndex: number;
    desiredIndex: number;
    blockType: number;
  }
  | {
    kind: 'create';
    parentBlockId: string;
    index: number;
    desiredStartIndex: number;
    desiredEndIndex: number;
    blocks: FeishuBlock[];
  }
  | {
    kind: 'delete';
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
  }
  | {
    kind: 'replace-range';
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
    blocks: FeishuBlock[];
    reason: string;
  };

export type BlockLevelSectionPatch = {
  kind: 'block-level-section-patch';
  operations: BlockLevelOperation[];
  fallbackReason?: string;
  unsafeForWrite?: boolean;
};

export function planBlockLevelSectionPatch(input: {
  remoteSectionBlocks: FeishuBlock[];
  desiredSectionBlocks: FeishuBlock[];
  parentBlockId: string;
  remoteStartIndex: number;
}): BlockLevelSectionPatch {
  if (blocksEquivalent(input.remoteSectionBlocks, input.desiredSectionBlocks)) {
    return { kind: 'block-level-section-patch', operations: [] };
  }

  if (input.desiredSectionBlocks.length > Math.max(20, input.remoteSectionBlocks.length * 3)) {
    return replaceRange(input, 0, input.remoteSectionBlocks.length, input.desiredSectionBlocks.length, 'unsafe create volume');
  }

  const prefixLength = commonPrefixLength(input.remoteSectionBlocks, input.desiredSectionBlocks);
  const suffixLength = commonSuffixLength(input.remoteSectionBlocks, input.desiredSectionBlocks, prefixLength);
  const remoteMiddleEnd = input.remoteSectionBlocks.length - suffixLength;
  const desiredMiddleEnd = input.desiredSectionBlocks.length - suffixLength;
  const remoteMiddle = input.remoteSectionBlocks.slice(prefixLength, remoteMiddleEnd);
  const desiredMiddle = input.desiredSectionBlocks.slice(prefixLength, desiredMiddleEnd);

  if (remoteMiddle.length === 0 && desiredMiddle.length > 0) {
    return {
      kind: 'block-level-section-patch',
      operations: [{
        kind: 'create',
        parentBlockId: input.parentBlockId,
        index: input.remoteStartIndex + prefixLength,
        desiredStartIndex: prefixLength,
        desiredEndIndex: desiredMiddleEnd,
        blocks: desiredMiddle
      }]
    };
  }

  if (remoteMiddle.length > 0 && desiredMiddle.length === 0) {
    return {
      kind: 'block-level-section-patch',
      operations: [{
        kind: 'delete',
        parentBlockId: input.parentBlockId,
        startIndex: input.remoteStartIndex + prefixLength,
        endIndex: input.remoteStartIndex + remoteMiddleEnd
      }]
    };
  }

  if (remoteMiddle.length === desiredMiddle.length) {
    const operations: BlockLevelOperation[] = [];
    for (let index = 0; index < remoteMiddle.length; index += 1) {
      const remote = remoteMiddle[index];
      const desired = desiredMiddle[index];
      if (blocksEquivalent([remote], [desired])) continue;
      if (!isTextLikeBlockPairUpdateable(remote, desired)) {
        return replaceRange(input, prefixLength, remoteMiddleEnd, desiredMiddleEnd, 'block type or structure changed');
      }
      operations.push({
        kind: 'update',
        remoteBlockId: remote.block_id as string,
        remoteIndex: input.remoteStartIndex + prefixLength + index,
        desiredIndex: prefixLength + index,
        blockType: remote.block_type
      });
    }
    return { kind: 'block-level-section-patch', operations };
  }

  return replaceRange(input, prefixLength, remoteMiddleEnd, desiredMiddleEnd, 'block order or count changed');
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
  return hashBlocks(remote) === hashBlocks(desired) || canonicalMarkdown(remote) === canonicalMarkdown(desired);
}

function canonicalMarkdown(blocks: FeishuBlock[]): string {
  return feishuBlocksToMarkdown(blocks)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replaceRange(
  input: {
    remoteSectionBlocks: FeishuBlock[];
    desiredSectionBlocks: FeishuBlock[];
    parentBlockId: string;
    remoteStartIndex: number;
  },
  relativeStartIndex: number,
  relativeRemoteEndIndex: number,
  relativeDesiredEndIndex: number,
  reason: string
): BlockLevelSectionPatch {
  const remoteCount = relativeRemoteEndIndex - relativeStartIndex;
  const createCount = relativeDesiredEndIndex - relativeStartIndex;
  const unsafeForWrite = remoteCount > 5 || createCount > 5;

  return {
    kind: 'block-level-section-patch',
    operations: [{
      kind: 'replace-range',
      parentBlockId: input.parentBlockId,
      startIndex: input.remoteStartIndex + relativeStartIndex,
      endIndex: input.remoteStartIndex + relativeRemoteEndIndex,
      blocks: input.desiredSectionBlocks.slice(relativeStartIndex, relativeDesiredEndIndex),
      reason
    }],
    fallbackReason: reason,
    unsafeForWrite
  };
}
