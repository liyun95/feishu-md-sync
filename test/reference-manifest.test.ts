import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadReferenceManifest } from '../src/reference/manifest.js';

describe('reference manifest validation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('accepts a valid SDK reference publish manifest', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    await writeManifest(manifestPath, validManifest());

    const manifest = await loadReferenceManifest(manifestPath);

    expect(manifest.kind).toBe('sdk-reference-publish-manifest');
    expect(manifest.actions.map((action) => action.action)).toEqual([
      'createDoc',
      'patchDoc',
      'copyDoc',
      'updateRecord'
    ]);
  });

  it('rejects Slug fields anywhere under fields objects', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    manifest.actions[0].record = {
      bitableToken: 'base',
      tableId: 'tbl',
      fields: { Slug: 'describe-alias' }
    };
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/Slug/);
  });

  it('rejects actions without stable IDs', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    delete manifest.actions[0].id;
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/stable id/);
  });

  it('rejects actions that V1 apply does not implement instead of accepting no-ops', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    manifest.actions[0].action = 'moveFile';
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/Unsupported reference action: moveFile/);
  });

  it('rejects missing markdown files before writes', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    manifest.actions[0].markdownFile = 'missing.md';
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/markdownFile/);
  });

  it('requires a pre-existing release audit base token for tracker rows', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    delete manifest.targets.releaseAuditBaseToken;
    manifest.actions[0].tracker = {
      tableName: 'Java SDK v3.0.x',
      fields: { '文档/接口': { fromCreatedDoc: true, text: 'describeAlias()' } }
    };
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/releaseAuditBaseToken/);
  });

  it('validates explicit URL field objects', async () => {
    const dir = await fixtureDir();
    const manifestPath = join(dir, 'manifest.json');
    const manifest = validManifest();
    manifest.actions[3].fields = {
      Docs: { text: 'bad' }
    };
    await writeManifest(manifestPath, manifest);

    await expect(loadReferenceManifest(manifestPath)).rejects.toThrow(/URL field/);
  });

  async function fixtureDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-manifest-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'reference/java'), { recursive: true });
    await writeFile(join(dir, 'reference/java/describeAlias.md'), '# describeAlias\n', 'utf8');
    await writeFile(join(dir, 'reference/java/describeCollection.md'), '# describeCollection\n', 'utf8');
    return dir;
  }
});

async function writeManifest(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validManifest(): any {
  return {
    kind: 'sdk-reference-publish-manifest',
    sdk: 'java',
    versionRange: 'v2.6.19 -> v3.0.0',
    targets: {
      driveRootFolderToken: 'folder',
      sdkReferenceBitableToken: 'base',
      releaseAuditBaseToken: 'audit-base'
    },
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
        }
      },
      {
        id: 'patch-describe-alias',
        action: 'patchDoc',
        documentId: 'doc',
        markdownFile: 'reference/java/describeAlias.md'
      },
      {
        id: 'copy-describe-collection',
        action: 'copyDoc',
        sourceDocToken: 'old-doc',
        targetFolderToken: 'folder',
        title: 'describeCollection()',
        then: [{
          action: 'updateRecord',
          bitableToken: 'base',
          tableId: 'tbl',
          recordId: 'rec',
          fields: { Docs: { fromCopiedDoc: true, text: 'describeCollection()' } }
        }]
      },
      {
        id: 'update-record',
        action: 'updateRecord',
        bitableToken: 'base',
        tableId: 'tbl',
        recordId: 'rec',
        fields: { Docs: { text: 'describeAlias()', link: 'https://zilliverse.feishu.cn/docx/doc' } }
      }
    ]
  };
}
