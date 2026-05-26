import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planReferenceManifestFromImpact } from '../src/reference/plan.js';
import { auditReferenceManifest } from '../src/reference/audit.js';

describe('reference plan and audit', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('plans only actionable impact rows and preserves tracker evidence', () => {
    const manifest = planReferenceManifestFromImpact({
      kind: 'sdk-reference-impact-matrix',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      targets: { driveRootFolderToken: 'folder', releaseAuditBaseToken: 'audit-base' },
      items: [
        { id: 'create-a', action: 'CREATE', title: 'a()', markdownFile: 'a.md', evidence: 'compile passed' },
        { id: 'update-b', action: 'UPDATE', title: 'b()', documentId: 'doc-b', markdownFile: 'b.md', recordId: 'rec-b' },
        { id: 'deprecate-c', action: 'DEPRECATE', title: 'c()', recordId: 'rec-c', evidence: 'removed in source' },
        { id: 'noop-d', action: 'NO ACTION', title: 'd()' }
      ]
    });

    expect(manifest.actions.map((action) => action.id)).toEqual(['create-a', 'update-b', 'deprecate-c']);
    expect(manifest.actions[0].tracker?.fields).toMatchObject({ '验证证据': 'compile passed' });
  });

  it('rejects no-action plans without source freshness evidence', () => {
    expect(() => planReferenceManifestFromImpact({
      kind: 'sdk-reference-impact-matrix',
      sdk: 'java',
      versionRange: 'v3.0.x',
      items: [
        { id: 'noop-java', action: 'NO ACTION', title: 'Java SDK v3.0.x' }
      ]
    })).toThrow(/source freshness/i);
  });

  it('requires diff evidence when no-action source freshness sees a newer tag', () => {
    expect(() => planReferenceManifestFromImpact({
      kind: 'sdk-reference-impact-matrix',
      sdk: 'java',
      versionRange: 'v3.0.x',
      source: {
        baselineTag: 'v3.0.0',
        latestTag: 'v3.0.1'
      },
      items: [
        { id: 'noop-java', action: 'NO ACTION', title: 'Java SDK v3.0.x' }
      ]
    })).toThrow(/diff evidence/i);
  });

  it('allows no-action plans with source freshness and explicit diff evidence', () => {
    const manifest = planReferenceManifestFromImpact({
      kind: 'sdk-reference-impact-matrix',
      sdk: 'java',
      versionRange: 'v3.0.0 -> v3.0.1',
      source: {
        baselineTag: 'v3.0.0',
        latestTag: 'v3.0.1',
        diffRange: 'v3.0.0..v3.0.1',
        changedPaths: []
      },
      items: [
        {
          id: 'noop-java',
          action: 'NO ACTION',
          title: 'sdk-core/src/main/java',
          evidence: 'git diff --name-status v3.0.0..v3.0.1 -- sdk-core/src/main/java returned no files.'
        }
      ]
    });

    expect(manifest.actions).toEqual([]);
  });

  it('passes readback when Drive docs, records, URL fields, and tracker schema exist', async () => {
    const manifestPath = await writeAuditManifest();
    const client = {
      listFolder: vi.fn().mockResolvedValue([{ token: 'doc-a' }]),
      listBitableRecords: vi.fn().mockResolvedValue([{
        record_id: 'rec-a',
        fields: { Docs: { link: 'https://zilliverse.feishu.cn/docx/doc-a' } }
      }]),
      listBitableFields: vi.fn().mockResolvedValue([{ field_name: '文档/接口' }, { field_name: '当前状态' }])
    };

    const report = await auditReferenceManifest(client, { manifestPath });

    expect(report.passed).toBe(true);
    expect(report.checked).toEqual({ driveDocs: 1, bitableRecords: 1, trackerRows: 1, postActions: 0 });
  });

  it('uses manifest release audit targets when tracker rows omit base token', async () => {
    const manifestPath = await writeAuditManifest({ trackerUsesTargets: true });
    const client = {
      listFolder: vi.fn().mockResolvedValue([{ token: 'doc-a' }]),
      listBitableRecords: vi.fn().mockResolvedValue([{
        record_id: 'rec-a',
        fields: { Docs: { link: 'https://zilliverse.feishu.cn/docx/doc-a' } }
      }]),
      listBitableFields: vi.fn().mockResolvedValue([{ field_name: '文档/接口' }, { field_name: '当前状态' }])
    };

    const report = await auditReferenceManifest(client, { manifestPath });

    expect(report.passed).toBe(true);
    expect(client.listBitableFields).toHaveBeenCalledWith('audit-base', 'Java SDK v3.0.x');
  });

  it('fails on missing docs, stale links, and tracker schema drift', async () => {
    const manifestPath = await writeAuditManifest();
    const client = {
      listFolder: vi.fn().mockResolvedValue([]),
      listBitableRecords: vi.fn().mockResolvedValue([{
        record_id: 'rec-a',
        fields: { Docs: { link: 'https://zilliverse.feishu.cn/docx/stale' } }
      }]),
      listBitableFields: vi.fn().mockResolvedValue([{ field_name: '文档/接口' }])
    };

    const report = await auditReferenceManifest(client, { manifestPath });

    expect(report.passed).toBe(false);
    expect(report.missingDocs).toEqual([expect.objectContaining({ documentId: 'doc-a' })]);
    expect(report.staleLinks).toEqual([expect.objectContaining({ recordId: 'rec-a' })]);
    expect(report.schemaIssues).toEqual([expect.objectContaining({ missingField: '当前状态' })]);
  });

  async function writeAuditManifest(options: { trackerUsesTargets?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-audit-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      kind: 'sdk-reference-publish-manifest',
      sdk: 'java',
      targets: {
        driveRootFolderToken: 'folder',
        sdkReferenceBitableToken: 'base',
        releaseAuditBaseToken: 'audit-base',
        releaseAuditTableName: 'Java SDK v3.0.x'
      },
      actions: [{
        id: 'patch-a',
        action: 'patchDoc',
        documentId: 'doc-a',
        recordId: 'rec-a',
        bitableToken: 'base',
        tableId: 'tbl',
        fields: { Docs: { text: 'a()', link: 'https://zilliverse.feishu.cn/docx/doc-a' } },
        tracker: options.trackerUsesTargets
          ? { fields: { '文档/接口': { text: 'a()', link: 'https://zilliverse.feishu.cn/docx/doc-a' } } }
          : { tableName: 'tracker', fields: { '文档/接口': { text: 'a()', link: 'https://zilliverse.feishu.cn/docx/doc-a' } } }
      }]
    }, null, 2)}\n`, 'utf8');
    return manifestPath;
  }
});
