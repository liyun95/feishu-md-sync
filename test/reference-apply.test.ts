import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyReferenceManifest } from '../src/reference/apply.js';

describe('reference apply', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('dry-runs reference actions with hashes without writing', async () => {
    const manifestPath = await writeFixtureManifest();
    const client = fakeReferenceClient();

    const report = await applyReferenceManifest(client, { manifestPath, write: false });

    expect(report.mode).toBe('dry-run');
    expect(report.createdDocs).toEqual([
      expect.objectContaining({ actionId: 'create-describe-alias', contentHash: expect.stringMatching(/^sha256:/) })
    ]);
    expect(report.copiedDocs).toEqual([
      expect.objectContaining({ actionId: 'copy-describe-collection', sourceDocToken: 'old-doc' })
    ]);
    expect(report.records).toEqual([
      expect.objectContaining({ actionId: 'create-describe-alias', operation: 'createRecord' }),
      expect.objectContaining({ actionId: 'copy-describe-collection', operation: 'updateRecord' })
    ]);
    expect(client.createDocxDocument).not.toHaveBeenCalled();
    expect(client.copyFile).not.toHaveBeenCalled();
    expect(client.createBitableRecord).not.toHaveBeenCalled();
  });

  it('writes create-doc before record and resolves created doc URL fields', async () => {
    const manifestPath = await writeFixtureManifest();
    const calls: string[] = [];
    const client = fakeReferenceClient(calls);

    const report = await applyReferenceManifest(client, { manifestPath, write: true });

    expect(calls[0]).toBe('createDoc:describeAlias()');
    expect(calls.indexOf('createDoc:describeAlias()')).toBeLessThan(calls.indexOf('createRecord:tbl'));
    expect(client.createBitableRecord.mock.calls[0][2]).toEqual({
      Docs: { text: 'describeAlias()', link: 'https://zilliverse.feishu.cn/docx/new-doc' }
    });
    expect(calls).toContain('copyFile:old-doc');
    expect(calls.indexOf('copyFile:old-doc')).toBeLessThan(calls.indexOf('patchDoc:copied-doc'));
    expect(client.updateBitableRecord.mock.calls[0][3]).toEqual({
      Docs: { text: 'describeCollection()', link: 'https://zilliverse.feishu.cn/docx/copied-doc' }
    });
    expect(report.failed).toEqual([]);
  });

  it('replaces existing document content when patching instead of appending', async () => {
    const manifestPath = await writeFixtureManifest();
    const calls: string[] = [];
    const client = fakeReferenceClient(calls);

    await applyReferenceManifest(client, { manifestPath, write: true });

    expect(calls.indexOf('deleteChildren:copied-doc:2')).toBeLessThan(calls.indexOf('patchDoc:copied-doc'));
    expect(client.deleteChildren).toHaveBeenCalledWith('copied-doc', 'copied-doc', 0, 2);
  });

  it('binds class client methods when writing a patch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-apply-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'doc.md'), '# patched\n', 'utf8');
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      kind: 'sdk-reference-publish-manifest',
      sdk: 'java',
      actions: [{
        id: 'patch-doc',
        action: 'patchDoc',
        documentId: 'doc',
        markdownFile: 'doc.md'
      }]
    }, null, 2)}\n`, 'utf8');
    const client = new ClassReferenceClient();

    const report = await applyReferenceManifest(client, { manifestPath, write: true });

    expect(report.failed).toEqual([]);
    expect(client.calls).toEqual([
      'get:doc',
      'delete:doc:1',
      'create:doc'
    ]);
  });

  it('writes tracker rows in write mode', async () => {
    const manifestPath = await writeFixtureManifest({ includeTracker: true });
    const client = fakeReferenceClient();

    const report = await applyReferenceManifest(client, { manifestPath, write: true });

    expect(client.createBitableRecord).toHaveBeenCalledWith(
      'audit-base',
      'tracker',
      expect.objectContaining({
        '文档/接口': { text: 'describeAlias()', link: 'https://zilliverse.feishu.cn/docx/new-doc' }
      })
    );
    expect(report.trackerRows).toEqual([
      expect.objectContaining({
        actionId: 'create-describe-alias',
        operation: 'createRecord',
        baseToken: 'audit-base',
        tableName: 'tracker',
        recordId: 'rec-created'
      })
    ]);
  });

  it('captures failures without hiding earlier successes', async () => {
    const manifestPath = await writeFixtureManifest();
    const calls: string[] = [];
    const client = fakeReferenceClient(calls);
    client.copyFile.mockRejectedValueOnce(new Error('copy failed'));

    const report = await applyReferenceManifest(client, { manifestPath, write: true });

    expect(report.createdDocs).toHaveLength(1);
    expect(report.failed).toEqual([
      expect.objectContaining({ actionId: 'copy-describe-collection', message: 'copy failed' })
    ]);
  });

  async function writeFixtureManifest(options: { includeTracker?: boolean } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-apply-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'reference/java'), { recursive: true });
    await writeFile(join(dir, 'reference/java/describeAlias.md'), '# describeAlias\n', 'utf8');
    await writeFile(join(dir, 'reference/java/describeCollection.md'), '# describeCollection\n', 'utf8');
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      kind: 'sdk-reference-publish-manifest',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      targets: { releaseAuditBaseToken: 'audit-base' },
      actions: [
        {
          id: 'create-describe-alias',
          action: 'createDoc',
          title: 'describeAlias()',
          folderToken: 'folder',
          markdownFile: 'reference/java/describeAlias.md',
          record: {
            bitableToken: 'base',
            tableId: 'tbl',
            fields: { Docs: { fromCreatedDoc: true, text: 'describeAlias()' } }
          },
          ...(options.includeTracker ? {
            tracker: {
              baseToken: 'audit-base',
              tableName: 'tracker',
              fields: { '文档/接口': { fromCreatedDoc: true, text: 'describeAlias()' } }
            }
          } : {})
        },
        {
          id: 'copy-describe-collection',
          action: 'copyDoc',
          sourceDocToken: 'old-doc',
          targetFolderToken: 'folder',
          title: 'describeCollection()',
          then: [
            {
              action: 'patchDoc',
              markdownFile: 'reference/java/describeCollection.md'
            },
            {
              action: 'updateRecord',
              bitableToken: 'base',
              tableId: 'tbl',
              recordId: 'rec',
              fields: { Docs: { fromCopiedDoc: true, text: 'describeCollection()' } }
            }
          ]
        }
      ]
    }, null, 2)}\n`, 'utf8');
    return manifestPath;
  }
});

function fakeReferenceClient(calls: string[] = []) {
  return {
    getDocumentBlocks: vi.fn(async (doc: string) => [
      { block_id: doc, block_type: 1, children: ['old-1', 'old-2'] },
      { block_id: 'old-1', block_type: 2 },
      { block_id: 'old-2', block_type: 2 }
    ]),
    deleteChildren: vi.fn(async (doc: string, _parent: string, _start: number, end: number) => {
      calls.push(`deleteChildren:${doc}:${end}`);
    }),
    createDocxDocument: vi.fn(async (title: string) => {
      calls.push(`createDoc:${title}`);
      return { document_id: 'new-doc' };
    }),
    createChildren: vi.fn(async (doc: string) => {
      calls.push(`patchDoc:${doc}`);
      return [];
    }),
    copyFile: vi.fn(async (token: string) => {
      calls.push(`copyFile:${token}`);
      return { token: 'copied-doc', url: 'https://zilliverse.feishu.cn/docx/copied-doc' };
    }),
    createBitableRecord: vi.fn(async (_app: string, table: string) => {
      calls.push(`createRecord:${table}`);
      return { record_id: 'rec-created' };
    }),
    updateBitableRecord: vi.fn(async (_app: string, table: string) => {
      calls.push(`updateRecord:${table}`);
      return { record_id: 'rec-updated' };
    })
  };
}

class ClassReferenceClient {
  calls: string[] = [];

  async getDocumentBlocks(documentId: string) {
    this.calls.push(`get:${documentId}`);
    return [
      { block_id: documentId, block_type: 1, children: ['old-1'] },
      { block_id: 'old-1', block_type: 2 }
    ];
  }

  async deleteChildren(documentId: string, _parentBlockId: string, _startIndex: number, endIndex: number) {
    this.calls.push(`delete:${documentId}:${endIndex}`);
  }

  async createChildren(documentId: string) {
    this.calls.push(`create:${documentId}`);
    return [];
  }
}
