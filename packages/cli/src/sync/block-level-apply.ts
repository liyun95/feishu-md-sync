import type { FeishuBlock, FeishuBlockUpdateRequest } from '../feishu/types.js';
import { buildTextLikeBlockUpdateRequest } from './block-update.js';
import type { BlockLevelOperation } from './block-level-plan.js';

export type BlockLevelApplyClient = {
  batchUpdateBlocks?(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
  createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[], options?: { index?: number }): Promise<FeishuBlock[]>;
  deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
};

export type BlockLevelApplyResult = {
  updated: number;
  created: number;
  deleted: number;
};

export async function applyBlockLevelSectionPatch(
  client: BlockLevelApplyClient,
  documentId: string,
  input: {
    remoteSectionBlocks: FeishuBlock[];
    desiredSectionBlocks: FeishuBlock[];
    remoteStartIndex: number;
    operations: BlockLevelOperation[];
  }
): Promise<BlockLevelApplyResult> {
  const updateRequests = buildUpdateRequests(input);
  if (updateRequests.length > 0) {
    if (!client.batchUpdateBlocks) {
      throw new Error('Feishu client does not support batchUpdateBlocks; cannot apply block-level updates.');
    }
    await client.batchUpdateBlocks(documentId, updateRequests);
  }

  let created = 0;
  let deleted = 0;

  for (const operation of input.operations) {
    if (operation.kind === 'create') {
      const result = await client.createChildren(documentId, operation.parentBlockId, operation.blocks, { index: operation.index });
      if (result.length !== operation.blocks.length) {
        throw new Error(`Feishu created ${result.length} of ${operation.blocks.length} blocks; refusing to continue block-level section patch.`);
      }
      created += result.length;
    }
    if (operation.kind === 'delete') {
      await client.deleteChildren(documentId, operation.parentBlockId, operation.startIndex, operation.endIndex);
      deleted += operation.endIndex - operation.startIndex;
    }
    if (operation.kind === 'replace-range') {
      const result = await client.createChildren(documentId, operation.parentBlockId, operation.blocks, { index: operation.endIndex });
      if (result.length !== operation.blocks.length) {
        throw new Error(`Feishu created ${result.length} of ${operation.blocks.length} replacement blocks; refusing to delete existing content.`);
      }
      await client.deleteChildren(documentId, operation.parentBlockId, operation.startIndex, operation.endIndex);
      created += result.length;
      deleted += operation.endIndex - operation.startIndex;
    }
  }

  return { updated: updateRequests.length, created, deleted };
}

function buildUpdateRequests(input: {
  remoteSectionBlocks: FeishuBlock[];
  desiredSectionBlocks: FeishuBlock[];
  remoteStartIndex: number;
  operations: BlockLevelOperation[];
}): FeishuBlockUpdateRequest[] {
  return input.operations.flatMap((operation) => {
    if (operation.kind !== 'update') return [];
    const remote = input.remoteSectionBlocks[operation.remoteIndex - input.remoteStartIndex];
    const desired = input.desiredSectionBlocks[operation.desiredIndex];
    return remote && desired ? [buildTextLikeBlockUpdateRequest(remote, desired)] : [];
  });
}
