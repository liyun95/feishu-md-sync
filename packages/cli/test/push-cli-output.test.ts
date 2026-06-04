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

  it('prints dry-run engine, env, transform, and render-risk diagnostics', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'block-patch',
      scope: 'FAQ section',
      risk: 'low',
      updates: 0,
      creates: 1,
      deletes: 0,
      approvalRequired: 'normal-write',
      approvalMessage: 'Run with --write to apply this plan.'
    };

    expect(pushResultSummaryLines(plan, syncResult({
      markdownEngine: { requested: 'auto', import: 'local' },
      publishTransforms: ['milvus'],
      renderRisk: {
        rawHtmlTableInSource: false,
        rawHtmlTextBlockCount: 0,
        duplicateH1: [],
        referencesHeadingLevel: 2,
        tableBlockCount: 1,
        tableSummaries: [{
          index: 1,
          rows: 2,
          columns: 4,
          headerCellCount: 4,
          headerBoldCells: 4
        }],
        risks: []
      }
    }), {
      appIdentity: 'APP_ID cli_...abcd',
      envSource: '/repo/.env'
    })).toEqual([
      'Intent: push local Markdown to Feishu',
      'Selected strategy: block-patch',
      'Scope: FAQ section',
      'Risk: low',
      '',
      'Planned Feishu changes:',
      '- update 0 blocks',
      '- create 1 blocks',
      '- delete 0 blocks',
      '',
      'Markdown engine: auto -> local',
      'App identity: APP_ID cli_...abcd',
      'Env source: /repo/.env',
      'Transforms: milvus',
      'Render risks: none detected',
      'Tables: 1 Feishu table block(s)',
      '- table 1: 2 rows x 4 columns, header bold 4/4',
      '',
      'Run with --write to apply this plan.'
    ]);
  });

  it('prints render-risk findings in dry-run output', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'document-replace',
      scope: 'entire document',
      risk: 'high',
      updates: 0,
      creates: 3,
      deletes: 3,
      approvalRequired: 'replace-all',
      approvalMessage: 'Write refused by default. Re-run with --replace-all only if a full document rewrite is intentional.'
    };

    expect(pushResultSummaryLines(plan, syncResult({
      renderRisk: {
        rawHtmlTableInSource: true,
        rawHtmlTextBlockCount: 1,
        duplicateH1: ['Title'],
        referencesHeadingLevel: 'missing',
        tableBlockCount: 0,
        tableSummaries: [],
        risks: ['source contains raw <table> HTML', 'missing H2 References']
      }
    }))).toContain('Render risks: source contains raw <table> HTML; missing H2 References');
  });

  it('prints review-draft check findings in dry-run output', () => {
    const plan: PushPlan = {
      intent: 'push local Markdown to Feishu',
      selectedStrategy: 'block-patch',
      scope: 'entire document',
      risk: 'low',
      updates: 1,
      creates: 0,
      deletes: 0,
      approvalRequired: 'normal-write',
      approvalMessage: 'Run with --write to apply this plan.'
    };

    expect(pushResultSummaryLines(plan, syncResult({
      reviewDraftChecks: {
        passed: false,
        issues: [{ kind: 'unwrapped-milvus', message: 'standalone Milvus remains outside include tags, links, and code' }]
      }
    }))).toEqual(expect.arrayContaining([
      'Review draft checks: failed',
      '- standalone Milvus remains outside include tags, links, and code'
    ]));
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
