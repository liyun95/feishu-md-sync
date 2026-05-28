import { describe, expect, it } from 'vitest';
import { syncResultSummaryLines } from '../src/cli/commands/sync.js';
import type { SyncRunResult } from '../src/sync/run-sync.js';

describe('sync CLI output', () => {
  it('prints block-level fallback details in pretty output', () => {
    const result: SyncRunResult = {
      mode: 'dry-run',
      receiptPath: '/tmp/receipt.json',
      patchPlan: {
        operation: 'replace-section',
        deleteCount: 2,
        createCount: 31,
        currentHash: 'current',
        desiredHash: 'desired',
        section: {
          title: 'FAQ',
          remoteStartIndex: 0,
          remoteEndIndex: 2,
          localStartIndex: 0,
          localEndIndex: 31
        }
      },
      blockLevelSectionPatch: {
        kind: 'block-level-section-patch',
        fallbackReason: 'unsafe create volume',
        unsafeForWrite: true,
        operations: [{
          kind: 'replace-range',
          parentBlockId: 'page',
          startIndex: 0,
          endIndex: 2,
          blocks: [],
          reason: 'unsafe create volume'
        }]
      },
      receipt: {
        sourcePath: '/tmp/doc.md',
        sourceHash: 'source',
        feishuDocId: 'doc',
        feishuStateHash: 'current',
        timestamp: '2026-05-28T00:00:00.000Z',
        blockCounts: { source: 31, feishuBefore: 2, feishuAfter: 31 },
        warnings: [],
        writeResult: { mode: 'dry-run', deleted: 0, created: 0, skipped: false },
        verificationResult: { ok: true, expectedHash: 'desired', actualHash: 'current' }
      },
      warnings: [],
      receiptWritten: false,
      preflight: { kind: 'markdown-publish-preflight', version: 1, passed: true, issues: [] }
    };

    expect(syncResultSummaryLines(result)).toEqual(expect.arrayContaining([
      'patch mode: block-level',
      'block fallback: unsafe create volume',
      'block fallback write: unsafe'
    ]));
  });
});
