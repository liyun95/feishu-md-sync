import type { FeishuBlock, FeishuDocClient, WriteResult } from '../feishu/types.js';
import { planSyncPatch } from '../workflows/sync/planner.js';

export type PatchPlan = {
  operation: 'noop' | 'replace-document' | 'replace-section' | 'replace-contiguous-blocks';
  deleteCount: number;
  createCount: number;
  currentHash: string;
  desiredHash: string;
  remoteStartIndex?: number;
  remoteEndIndex?: number;
  localStartIndex?: number;
  localEndIndex?: number;
  section?: {
    title: string;
    remoteStartIndex: number;
    remoteEndIndex: number;
    localStartIndex: number;
    localEndIndex: number;
  };
};

export function planSmartPatch(currentChildren: FeishuBlock[], desiredChildren: FeishuBlock[]): PatchPlan {
  const plan = planSyncPatch({ currentChildren, desiredChildren });
  const currentHash = plan.currentHash;
  const desiredHash = plan.desiredHash;

  if (plan.operation.kind === 'noop') {
    return {
      operation: 'noop',
      deleteCount: 0,
      createCount: 0,
      currentHash,
      desiredHash
    };
  }

  if (plan.operation.kind === 'replace-contiguous-blocks') {
    return {
      operation: 'replace-contiguous-blocks',
      deleteCount: plan.operation.deleteCount,
      createCount: plan.operation.createCount,
      currentHash,
      desiredHash,
      remoteStartIndex: plan.operation.remoteStartIndex,
      remoteEndIndex: plan.operation.remoteEndIndex,
      localStartIndex: plan.operation.localStartIndex,
      localEndIndex: plan.operation.localEndIndex
    };
  }

  return {
    operation: 'replace-document',
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

  if (plan.operation === 'replace-contiguous-blocks') {
    if (
      plan.remoteStartIndex === undefined ||
      plan.remoteEndIndex === undefined ||
      plan.localStartIndex === undefined ||
      plan.localEndIndex === undefined
    ) {
      throw new Error('Contiguous block patch plan is missing range metadata.');
    }
    const created = desiredChildren.length > 0
      ? await createDesiredChildren(client, documentId, pageBlockId, desiredChildren, {
        index: plan.remoteEndIndex
      })
      : [];
    await client.deleteChildren(documentId, pageBlockId, plan.remoteStartIndex, plan.remoteEndIndex);
    return { deleted: plan.deleteCount, created: created.length, skipped: false };
  }

  if (plan.operation === 'replace-section') {
    if (!plan.section) {
      throw new Error('Section patch plan is missing section range metadata.');
    }
    const created = desiredChildren.length > 0
      ? await createDesiredChildren(client, documentId, pageBlockId, desiredChildren, {
        index: plan.section.remoteEndIndex
      })
      : [];
    await client.deleteChildren(documentId, pageBlockId, plan.section.remoteStartIndex, plan.section.remoteEndIndex);
    return { deleted: plan.deleteCount, created: created.length, skipped: false };
  }

  if (plan.deleteCount > 0 && desiredChildren.length > 0) {
    const created = await createDesiredChildren(client, documentId, pageBlockId, desiredChildren, {
      index: plan.deleteCount
    });
    await client.deleteChildren(documentId, pageBlockId, 0, plan.deleteCount);
    return { deleted: plan.deleteCount, created: created.length, skipped: false };
  }

  if (plan.deleteCount > 0) {
    await client.deleteChildren(documentId, pageBlockId, 0, plan.deleteCount);
  }

  const created = desiredChildren.length > 0
    ? await createDesiredChildren(client, documentId, pageBlockId, desiredChildren)
    : [];
  return { deleted: plan.deleteCount, created: created.length, skipped: false };
}

async function createDesiredChildren(
  client: FeishuDocClient,
  documentId: string,
  pageBlockId: string,
  desiredChildren: FeishuBlock[],
  options?: { index?: number }
): Promise<FeishuBlock[]> {
  const created = options === undefined
    ? await client.createChildren(documentId, pageBlockId, desiredChildren)
    : await client.createChildren(documentId, pageBlockId, desiredChildren, options);
  if (created.length !== desiredChildren.length) {
    throw new Error(
      `Feishu created ${created.length} of ${desiredChildren.length} replacement blocks; refusing to delete existing content.`
    );
  }
  return created;
}
