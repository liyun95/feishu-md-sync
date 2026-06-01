import { describe, expect, it } from 'vitest';
import { pushResultSummaryLines } from '../src/cli/commands/sync.js';
import type { PushPlan } from '../src/sync/push-plan.js';
import type { SyncRunResult } from '../src/sync/run-sync.js';

describe('push CLI output', () => {
  it('leads with strategy, scope, risk, and operation counts', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'block-patch',
      scope: 'FAQ section',
      risk: 'low',
      updates: 1,
      creates: 0,
      deletes: 0,
      approvalRequired: 'normal-write',
      approvalMessage: 'Run with --write to apply this plan.'
    };

    expect(pushResultSummaryLines(plan, syncResult())).toEqual([
      'Intent: push local Markdown to Feishu',
      'Selected strategy: block-patch',
      'Scope: FAQ section',
      'Risk: low',
      '',
      'Planned Feishu changes:',
      '- update 1 blocks',
      '- create 0 blocks',
      '- delete 0 blocks',
      '',
      'Run with --write to apply this plan.'
    ]);
  });

  it('prints replace-all gate for document replacement', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'document-replace',
      scope: 'entire document',
      risk: 'high',
      updates: 0,
      creates: 341,
      deletes: 121,
      approvalRequired: 'replace-all',
      approvalMessage: 'Write refused by default. Re-run with --replace-all only if a full document rewrite is intentional.'
    };

    expect(pushResultSummaryLines(plan, syncResult())).toContain(
      'Write refused by default. Re-run with --replace-all only if a full document rewrite is intentional.'
    );
  });

  it('does not print dry-run approval guidance after write', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'block-patch',
      scope: 'FAQ section',
      risk: 'low',
      updates: 1,
      creates: 0,
      deletes: 0,
      approvalRequired: 'normal-write',
      approvalMessage: 'Run with --write to apply this plan.'
    };

    expect(pushResultSummaryLines(plan, syncResult({ mode: 'write' }))).toEqual([
      'Intent: push local Markdown to Feishu',
      'Selected strategy: block-patch',
      'Scope: FAQ section',
      'Risk: low',
      '',
      'Applied Feishu changes:',
      '- update 1 blocks',
      '- create 0 blocks',
      '- delete 0 blocks',
      'Readback verification: passed'
    ]);
  });
});

function syncResult(overrides: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    mode: 'dry-run',
    receiptPath: '/tmp/receipt.json',
    patchPlan: {
      operation: 'replace-section',
      deleteCount: 1,
      createCount: 1,
      currentHash: 'current',
      desiredHash: 'desired'
    },
    blockLevelSectionPatch: null,
    receipt: {
      sourcePath: '/tmp/doc.md',
      sourceHash: 'source',
      feishuDocId: 'doc',
      feishuStateHash: 'current',
      timestamp: '2026-05-29T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 1, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'dry-run', deleted: 0, created: 0, skipped: false },
      verificationResult: { ok: true, expectedHash: 'desired', actualHash: 'current' }
    },
    warnings: [],
    receiptWritten: false,
    preflight: { kind: 'markdown-publish-preflight', version: 1, passed: true, issues: [] },
    ...overrides
  };
}
