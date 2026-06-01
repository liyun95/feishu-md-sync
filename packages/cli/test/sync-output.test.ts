import { describe, expect, it } from 'vitest';
import { buildAuthDoctorReport, type CliEnvLoadReport } from '../src/cli/env.js';
import { buildSyncOutputContext, formatSyncResultPretty } from '../src/cli/sync-output.js';
import type { SyncRunResult } from '../src/sync/run-sync.js';

describe('sync CLI output context', () => {
  it('summarizes auth identity, env source, host, and active transforms without secrets', () => {
    const envLoadReport: CliEnvLoadReport = {
      cwd: '/repo',
      explicitEnvFile: '/repo/lark.env',
      attemptedFiles: ['/repo/lark.env', '/repo/.env'],
      loadedFiles: ['/repo/lark.env']
    };
    const auth = buildAuthDoctorReport(envLoadReport, {
      APP_ID: 'cli_1234567890abcdef',
      APP_SECRET: 'secret-value',
      FEISHU_HOST: 'https://open.feishu.test'
    });

    const context = buildSyncOutputContext({
      auth,
      publishTransform: { profile: 'milvus' }
    });

    expect(context).toEqual({
      appId: {
        present: true,
        preview: 'cli_...cdef'
      },
      envFiles: [
        { path: '/repo/lark.env', loaded: true, explicit: true },
        { path: '/repo/.env', loaded: false, explicit: false }
      ],
      feishuHost: 'https://open.feishu.test',
      activeTransforms: ['publish-profile:milvus']
    });
    expect(JSON.stringify(context)).not.toContain('secret-value');
  });

  it('prints sync dry-run context before the patch plan', () => {
    const output = formatSyncResultPretty(syncResultFixture(), {
      appId: { present: true, preview: 'cli_...cdef' },
      envFiles: [{ path: '/repo/lark.env', loaded: true, explicit: true }],
      feishuHost: 'https://open.feishu.test',
      activeTransforms: ['publish-profile:milvus']
    });

    expect(output.split('\n').slice(0, 5)).toEqual([
      'dry-run: replace-document',
      'app id: cli_...cdef',
      'env files: /repo/lark.env (loaded, explicit)',
      'feishu host: https://open.feishu.test',
      'active transforms: publish-profile:milvus'
    ]);
  });

  it('prints missing identity and absent transforms explicitly', () => {
    const output = formatSyncResultPretty(syncResultFixture(), {
      appId: { present: false },
      envFiles: [],
      feishuHost: 'https://open.feishu.cn',
      activeTransforms: []
    });

    expect(output).toContain('app id: missing');
    expect(output).toContain('env files: none loaded');
    expect(output).toContain('active transforms: none');
  });
});

function syncResultFixture(): SyncRunResult {
  return {
    mode: 'dry-run',
    receiptPath: '/repo/.sync/feishu/doc.doc123.json',
    patchPlan: {
      operation: 'replace-document',
      currentHash: 'current',
      desiredHash: 'desired',
      deleteCount: 0,
      createCount: 1
    },
    receipt: {
      sourcePath: '/repo/doc.md',
      sourceHash: 'source',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: 'current',
      timestamp: '2026-06-01T00:00:00.000Z',
      blockCounts: {
        source: 1,
        feishuBefore: 0,
        feishuAfter: 1
      },
      warnings: [],
      writeResult: {
        mode: 'dry-run',
        deleted: 0,
        created: 1,
        skipped: false
      },
      verificationResult: {
        ok: true,
        expectedHash: 'desired',
        actualHash: 'current'
      }
    },
    warnings: [],
    receiptWritten: false,
    preflight: {
      warnings: []
    }
  };
}
