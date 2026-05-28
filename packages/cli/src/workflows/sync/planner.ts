import { hashBlocks } from '../../core/hash.js';
import type { FeishuBlock } from '../../feishu/types.js';

const DEFAULT_MAX_CONTIGUOUS_REPLACE_BLOCKS = 12;

export type SyncPatchOperation =
  | {
    kind: 'noop';
    reason: string;
  }
  | {
    kind: 'replace-document';
    deleteCount: number;
    createCount: number;
  }
  | {
    kind: 'replace-section';
    title: string;
    remoteStartIndex: number;
    remoteEndIndex: number;
    localStartIndex: number;
    localEndIndex: number;
    deleteCount: number;
    createCount: number;
  }
  | {
    kind: 'replace-contiguous-blocks';
    remoteStartIndex: number;
    remoteEndIndex: number;
    localStartIndex: number;
    localEndIndex: number;
    deleteCount: number;
    createCount: number;
  };

export type SyncPatchPlanV2 = {
  kind: 'feishu-sync-patch-plan';
  version: 2;
  currentHash: string;
  desiredHash: string;
  operation: SyncPatchOperation;
  currentChildren: FeishuBlock[];
  replacementBlocks: FeishuBlock[];
  expectedChildren: FeishuBlock[];
  warnings: string[];
};

export function planSyncPatch(input: {
  currentChildren: FeishuBlock[];
  desiredChildren: FeishuBlock[];
  maxContiguousReplaceBlocks?: number;
}): SyncPatchPlanV2 {
  const currentHash = hashBlocks(input.currentChildren);
  const desiredHash = hashBlocks(input.desiredChildren);

  if (currentHash === desiredHash) {
    return {
      kind: 'feishu-sync-patch-plan',
      version: 2,
      currentHash,
      desiredHash,
      operation: { kind: 'noop', reason: 'current and desired block hashes match' },
      currentChildren: input.currentChildren,
      replacementBlocks: [],
      expectedChildren: input.currentChildren,
      warnings: []
    };
  }

  const window = changedWindow(input.currentChildren, input.desiredChildren);
  const maxBlocks = input.maxContiguousReplaceBlocks ?? DEFAULT_MAX_CONTIGUOUS_REPLACE_BLOCKS;
  const changedCount = Math.max(window.remoteEndIndex - window.remoteStartIndex, window.localEndIndex - window.localStartIndex);
  if (
    window.remoteStartIndex > 0 &&
    window.remoteEndIndex < input.currentChildren.length &&
    changedCount <= maxBlocks
  ) {
    const replacementBlocks = input.desiredChildren.slice(window.localStartIndex, window.localEndIndex);
    return {
      kind: 'feishu-sync-patch-plan',
      version: 2,
      currentHash,
      desiredHash,
      operation: {
        kind: 'replace-contiguous-blocks',
        ...window,
        deleteCount: window.remoteEndIndex - window.remoteStartIndex,
        createCount: replacementBlocks.length
      },
      currentChildren: input.currentChildren,
      replacementBlocks,
      expectedChildren: input.desiredChildren,
      warnings: []
    };
  }

  return {
    kind: 'feishu-sync-patch-plan',
    version: 2,
    currentHash,
    desiredHash,
    operation: {
      kind: 'replace-document',
      deleteCount: input.currentChildren.length,
      createCount: input.desiredChildren.length
    },
    currentChildren: input.currentChildren,
    replacementBlocks: input.desiredChildren,
    expectedChildren: input.desiredChildren,
    warnings: changedCount > maxBlocks
      ? [`Changed block window ${changedCount} exceeds ${maxBlocks}; using replace-document.`]
      : []
  };
}

function changedWindow(currentChildren: FeishuBlock[], desiredChildren: FeishuBlock[]): {
  remoteStartIndex: number;
  remoteEndIndex: number;
  localStartIndex: number;
  localEndIndex: number;
} {
  const currentHashes = currentChildren.map((block) => hashBlocks([block]));
  const desiredHashes = desiredChildren.map((block) => hashBlocks([block]));
  let prefix = 0;
  while (
    prefix < currentHashes.length &&
    prefix < desiredHashes.length &&
    currentHashes[prefix] === desiredHashes[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < currentHashes.length - prefix &&
    suffix < desiredHashes.length - prefix &&
    currentHashes[currentHashes.length - 1 - suffix] === desiredHashes[desiredHashes.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    remoteStartIndex: prefix,
    remoteEndIndex: currentHashes.length - suffix,
    localStartIndex: prefix,
    localEndIndex: desiredHashes.length - suffix
  };
}
