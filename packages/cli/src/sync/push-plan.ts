import type { SyncRunResult } from './run-sync.js';
import type { BlockLevelOperation } from './block-level-plan.js';

export type PushStrategy = 'auto' | 'block-patch' | 'section-replace' | 'document-replace';

export type SelectedPushStrategy = Exclude<PushStrategy, 'auto'>;

export type PushRisk = 'low' | 'medium' | 'high';

export type PushPlan = {
  intent: 'push local Markdown to Feishu';
  selectedStrategy: SelectedPushStrategy;
  scope: string;
  risk: PushRisk;
  updates: number;
  creates: number;
  deletes: number;
  fallbackReason?: string;
  approvalRequired: 'normal-write' | 'section-replace' | 'replace-all';
  approvalMessage: string;
};

export function buildPushPlan(result: SyncRunResult): PushPlan {
  const sectionTitle = result.patchPlan.section?.title;
  const scope = sectionTitle ? `${sectionTitle} section` : 'entire document';

  if (result.patchPlan.operation === 'replace-document') {
    return {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'document-replace',
      scope,
      risk: 'high',
      updates: 0,
      creates: result.patchPlan.createCount,
      deletes: result.patchPlan.deleteCount,
      approvalRequired: 'replace-all',
      approvalMessage: 'Write refused by default. Re-run with --replace-all only if a full document rewrite is intentional.'
    };
  }

  if (result.patchPlan.operation === 'replace-section' && shouldUseSectionReplace(result)) {
    const section = result.patchPlan.section?.title ?? 'selected section';
    return {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'section-replace',
      scope,
      risk: 'medium',
      updates: 0,
      creates: result.patchPlan.createCount,
      deletes: result.patchPlan.deleteCount,
      fallbackReason: result.blockLevelSectionPatch?.fallbackReason,
      approvalRequired: 'section-replace',
      approvalMessage: `Approval required: confirm section replacement for "${section}".`
    };
  }

  const counts = blockPatchCounts(result);
  return {
    intent: 'push local Markdown to Feishu',
    selectedStrategy: 'block-patch',
    scope,
    risk: 'low',
    updates: counts.updates,
    creates: counts.creates,
    deletes: counts.deletes,
    fallbackReason: result.blockLevelSectionPatch?.fallbackReason,
    approvalRequired: 'normal-write',
    approvalMessage: result.patchPlan.operation === 'noop' ? 'No Feishu write is needed.' : 'Run with --write to apply this plan.'
  };
}

export function assertRequestedPushStrategy(plan: PushPlan, requested: PushStrategy): void {
  if (requested === 'auto' || requested === plan.selectedStrategy) return;
  throw new Error(
    `Requested push strategy ${requested} does not match selected strategy ${plan.selectedStrategy}. ` +
    `Use --strategy auto or review the dry-run plan before forcing a different strategy.`
  );
}

function shouldUseSectionReplace(result: SyncRunResult): boolean {
  if (!result.patchPlan.section) return false;
  if (!result.blockLevelSectionPatch) return true;
  return result.blockLevelSectionPatch.unsafeForWrite === true;
}

function blockPatchCounts(result: SyncRunResult): { updates: number; creates: number; deletes: number } {
  const blockPatch = result.blockLevelSectionPatch;
  if (blockPatch) {
    return blockPatch.operations.reduce((counts, operation) => addOperationCounts(counts, operation), {
      updates: 0,
      creates: 0,
      deletes: 0
    });
  }

  if (result.patchPlan.operation === 'noop') {
    return { updates: 0, creates: 0, deletes: 0 };
  }

  return {
    updates: 0,
    creates: result.patchPlan.createCount,
    deletes: result.patchPlan.deleteCount
  };
}

function addOperationCounts(
  counts: { updates: number; creates: number; deletes: number },
  operation: BlockLevelOperation
): { updates: number; creates: number; deletes: number } {
  if (operation.kind === 'update') {
    return { ...counts, updates: counts.updates + 1 };
  }
  if (operation.kind === 'create') {
    return { ...counts, creates: counts.creates + operation.blocks.length };
  }
  if (operation.kind === 'delete') {
    return { ...counts, deletes: counts.deletes + operation.endIndex - operation.startIndex };
  }
  return {
    ...counts,
    creates: counts.creates + operation.blocks.length,
    deletes: counts.deletes + operation.endIndex - operation.startIndex
  };
}
