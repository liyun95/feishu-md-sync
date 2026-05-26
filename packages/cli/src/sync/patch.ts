import { hashBlocks } from '../core/hash.js';
import type { FeishuBlock, FeishuDocClient, WriteResult } from '../feishu/types.js';

export type PatchPlan = {
  operation: 'noop' | 'replace-all';
  deleteCount: number;
  createCount: number;
  currentHash: string;
  desiredHash: string;
};

export function planSmartPatch(currentChildren: FeishuBlock[], desiredChildren: FeishuBlock[]): PatchPlan {
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(desiredChildren);

  if (currentHash === desiredHash) {
    return {
      operation: 'noop',
      deleteCount: 0,
      createCount: 0,
      currentHash,
      desiredHash
    };
  }

  return {
    operation: 'replace-all',
    deleteCount: currentChildren.length,
    createCount: desiredChildren.length,
    currentHash,
    desiredHash
  };
}

export async function applyPatch(
  client: FeishuDocClient,
  documentId: string,
  pageBlockId: string,
  plan: PatchPlan,
  desiredChildren: FeishuBlock[]
): Promise<WriteResult> {
  if (plan.operation === 'noop') {
    return { deleted: 0, created: 0, skipped: true };
  }

  if (plan.deleteCount > 0) {
    await client.deleteChildren(documentId, pageBlockId, 0, plan.deleteCount);
  }

  const created = desiredChildren.length > 0
    ? await client.createChildren(documentId, pageBlockId, desiredChildren)
    : [];

  return { deleted: plan.deleteCount, created: created.length, skipped: false };
}
