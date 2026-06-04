import { describe, expect, it } from 'vitest';
import { reviewDraftDefaultsForCommand, resolvePublishTransformOptions, statusSummaryLines, syncResultSummaryLines } from '../src/cli/commands/sync.js';
import type { SyncRunResult } from '../src/sync/run-sync.js';
import type { SyncStatusResult } from '../src/sync/status.js';

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

  it('hides raw status hashes by default and explains verbose output', () => {
    expect(statusSummaryLines(statusResult(), { verbose: false })).toEqual([
      'state: clean',
      'local changed: false',
      'remote changed: false',
      'receipt: /tmp/receipt.json',
      'hashes: hidden (use --verbose to show source, desired, and remote hashes)'
    ]);
  });

  it('prints status hash roles in verbose output', () => {
    expect(statusSummaryLines(statusResult(), { verbose: true })).toEqual([
      'state: clean',
      'local changed: false',
      'remote changed: false',
      'receipt: /tmp/receipt.json',
      'source hash: source (transformed Markdown source)',
      'desired hash: desired (Feishu blocks generated from source)',
      'remote hash: remote (current Feishu blocks)'
    ]);
  });

  it('treats the Milvus review profile as the Milvus publish transform', () => {
    expect(resolvePublishTransformOptions({ reviewProfile: 'milvus' })).toEqual({
      publishProfile: 'milvus',
      publishTransform: { profile: 'milvus' }
    });
    expect(resolvePublishTransformOptions({ publishProfile: 'milvus', reviewProfile: 'milvus' })).toEqual({
      publishProfile: 'milvus',
      publishTransform: { profile: 'milvus' }
    });
  });

  it('defaults review-draft commands to the Milvus review profile and docs link base', () => {
    expect(reviewDraftDefaultsForCommand({})).toEqual({
      reviewProfile: 'milvus',
      linkBaseUrl: 'https://milvus.io/docs/',
      markdownEngine: 'local'
    });
    expect(reviewDraftDefaultsForCommand({
      linkBaseUrl: 'https://milvus.io/v2.6.x/docs/',
      markdownEngine: 'official'
    })).toEqual({
      reviewProfile: 'milvus',
      linkBaseUrl: 'https://milvus.io/v2.6.x/docs/',
      markdownEngine: 'official'
    });
  });

  it('includes link base URL in publish transform options', () => {
    expect(resolvePublishTransformOptions({ linkBaseUrl: 'https://milvus.io/docs/' })).toEqual({
      publishProfile: undefined,
      publishTransform: { linkBaseUrl: 'https://milvus.io/docs/' }
    });
    expect(resolvePublishTransformOptions({ reviewProfile: 'milvus', linkBaseUrl: 'https://milvus.io/docs/' })).toEqual({
      publishProfile: 'milvus',
      publishTransform: { profile: 'milvus', linkBaseUrl: 'https://milvus.io/docs/' }
    });
  });

  it('rejects conflicting publish and review profiles', () => {
    expect(() => resolvePublishTransformOptions({ publishProfile: 'other', reviewProfile: 'milvus' })).toThrow(/conflicts/);
  });
});

function statusResult(): SyncStatusResult {
  return {
    state: 'clean',
    localChanged: false,
    remoteChanged: false,
    receiptPath: '/tmp/receipt.json',
    sourceHash: 'source',
    desiredHash: 'desired',
    currentRemoteHash: 'remote',
    preflight: { kind: 'markdown-publish-preflight', version: 1, passed: true, issues: [] }
  };
}
