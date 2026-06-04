import { describe, expect, it } from 'vitest';
import { assertRequestedPushStrategy, buildPushPlan } from '../src/sync/push-plan.js';
import type { SyncRunResult } from '../src/sync/run-sync.js';

describe('push plan', () => {
  it('selects block-patch for a safe block-level section update', () => {
    const plan = buildPushPlan(syncResult({
      patchPlan: sectionPatchPlan(),
      blockLevelSectionPatch: {
        kind: 'block-level-section-patch',
        operations: [{
          kind: 'update',
          remoteBlockId: 'blk1',
          remoteIndex: 3,
          desiredIndex: 3,
          blockType: 2
        }]
      }
    }));

    expect(plan).toMatchObject({
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'block-patch',
      scope: 'FAQ section',
      risk: 'low',
      updates: 1,
      creates: 0,
      deletes: 0,
      approvalRequired: 'normal-write'
    });
  });

  it('selects block-patch for a safe whole-document block-level update', () => {
    const plan = buildPushPlan(syncResult({
      patchPlan: {
        operation: 'replace-document',
        deleteCount: 51,
        createCount: 51,
        currentHash: 'current',
        desiredHash: 'desired'
      },
      blockLevelDocumentPatch: {
        kind: 'block-level-document-patch',
        operations: [
          { kind: 'update', remoteBlockId: 'blk1', remoteIndex: 10, desiredIndex: 10, blockType: 2 },
          { kind: 'update', remoteBlockId: 'blk2', remoteIndex: 35, desiredIndex: 35, blockType: 2 }
        ]
      }
    }));

    expect(plan).toMatchObject({
      selectedStrategy: 'block-patch',
      scope: 'entire document',
      risk: 'low',
      updates: 2,
      creates: 0,
      deletes: 0,
      approvalRequired: 'normal-write'
    });
  });

  it('selects section-replace when block-level section patch is unsafe', () => {
    const plan = buildPushPlan(syncResult({
      patchPlan: sectionPatchPlan({ deleteCount: 19, createCount: 20 }),
      blockLevelSectionPatch: {
        kind: 'block-level-section-patch',
        fallbackReason: 'block order or count changed',
        unsafeForWrite: true,
        operations: [{
          kind: 'replace-range',
          parentBlockId: 'page',
          startIndex: 30,
          endIndex: 49,
          blocks: [],
          reason: 'block order or count changed'
        }]
      }
    }));

    expect(plan).toMatchObject({
      selectedStrategy: 'section-replace',
      scope: 'FAQ section',
      risk: 'medium',
      updates: 0,
      creates: 20,
      deletes: 19,
      fallbackReason: 'block order or count changed',
      approvalRequired: 'section-replace'
    });
  });

  it('selects document-replace for whole-document replacement', () => {
    const plan = buildPushPlan(syncResult({
      patchPlan: {
        operation: 'replace-document',
        deleteCount: 121,
        createCount: 341,
        currentHash: 'current',
        desiredHash: 'desired'
      }
    }));

    expect(plan).toMatchObject({
      selectedStrategy: 'document-replace',
      scope: 'entire document',
      risk: 'high',
      updates: 0,
      creates: 341,
      deletes: 121,
      approvalRequired: 'replace-all'
    });
  });

  it('rejects requested strategy mismatches', () => {
    const plan = buildPushPlan(syncResult({ patchPlan: sectionPatchPlan() }));

    expect(() => assertRequestedPushStrategy(plan, 'document-replace')).toThrow(
      'Requested push strategy document-replace does not match selected strategy section-replace'
    );
  });
});

function sectionPatchPlan(overrides?: { deleteCount?: number; createCount?: number }): SyncRunResult['patchPlan'] {
  return {
    operation: 'replace-section',
    deleteCount: overrides?.deleteCount ?? 1,
    createCount: overrides?.createCount ?? 1,
    currentHash: 'current',
    desiredHash: 'desired',
    section: {
      title: 'FAQ',
      remoteStartIndex: 3,
      remoteEndIndex: 4,
      localStartIndex: 3,
      localEndIndex: 4
    }
  };
}

function syncResult(input: {
  patchPlan: SyncRunResult['patchPlan'];
  blockLevelSectionPatch?: SyncRunResult['blockLevelSectionPatch'];
  blockLevelDocumentPatch?: SyncRunResult['blockLevelDocumentPatch'];
}): SyncRunResult {
  return {
    mode: 'dry-run',
    receiptPath: '/tmp/receipt.json',
    patchPlan: input.patchPlan,
    blockLevelSectionPatch: input.blockLevelSectionPatch ?? null,
    blockLevelDocumentPatch: input.blockLevelDocumentPatch ?? null,
    receipt: {
      sourcePath: '/tmp/doc.md',
      sourceHash: 'source',
      feishuDocId: 'doc',
      feishuStateHash: 'current',
      timestamp: '2026-05-29T00:00:00.000Z',
      blockCounts: { source: input.patchPlan.createCount, feishuBefore: input.patchPlan.deleteCount, feishuAfter: input.patchPlan.createCount },
      warnings: [],
      writeResult: { mode: 'dry-run', deleted: 0, created: 0, skipped: false },
      verificationResult: { ok: true, expectedHash: 'desired', actualHash: 'current' }
    },
    warnings: [],
    receiptWritten: false,
    preflight: { kind: 'markdown-publish-preflight', version: 1, passed: true, issues: [] }
  };
}
