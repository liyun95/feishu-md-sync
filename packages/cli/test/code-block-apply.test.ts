import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import { applyCodeBlockManifest } from '../src/sync/code-block-apply.js';

describe('code-block apply', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('dry-runs mixed update and insert items without writing', async () => {
    const dir = await snippetsDir();
    const manifest = await writeManifest(dir, [
      updateItem('java-1', 'snippets/java.java'),
      insertItem('python-1', 'snippets/restful.sh')
    ]);
    const client = fakeClient();

    const report = await applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: false
    });

    expect(report.mode).toBe('dry-run');
    expect(report.updated).toEqual([
      expect.objectContaining({
        blockId: 'java-1',
        language: 'java',
        wouldUpdateBlocks: 1,
        updatedBlocks: 0,
        contentHash: expect.stringMatching(/^sha256:/)
      })
    ]);
    expect(report.inserted).toEqual([
      expect.objectContaining({
        anchorBlockId: 'python-1',
        insertAfterBlockId: 'python-1',
        language: 'restful',
        wouldInsertBlocks: 1,
        insertedBlocks: 0,
        contentHash: expect.stringMatching(/^sha256:/)
      })
    ]);
    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(manifest.items).toHaveLength(2);
  });

  it('includes remote hash, placeholder, and code previews in dry-run metadata when readback is available', async () => {
    const dir = await snippetsDir();
    await writeManifest(dir, [
      updateItem('java-1', 'snippets/java.java')
    ]);
    const client = {
      batchUpdateBlocks: vi.fn(),
      createChildren: vi.fn(),
      getDocumentBlocks: vi.fn(async () => [
        codeBlock('java-1', '// java', 29)
      ])
    };

    const report = await applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: false
    });

    expect(report.updated[0]).toEqual(expect.objectContaining({
      groupId: 'group-001',
      currentHash: expect.stringMatching(/^sha256:/),
      desiredHash: report.updated[0].contentHash,
      isPlaceholder: true,
      currentPreview: '// java',
      desiredPreview: 'System.out.println("ok");',
      wouldUpdateBlocks: 1,
      updatedBlocks: 0
    }));
    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
  });

  it('fails before writes when the manifest document does not match the expected document', async () => {
    const dir = await snippetsDir();
    await writeManifest(dir, [
      updateItem('java-1', 'snippets/java.java')
    ]);
    const client = fakeClient();

    await expect(applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: true,
      expectedDocumentId: 'other-doc'
    })).rejects.toThrow(/manifest documentId doc does not match expected document other-doc/);

    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('writes items sequentially and reports failures without hiding successes', async () => {
    const dir = await snippetsDir();
    await writeManifest(dir, [
      updateItem('java-1', 'snippets/java.java'),
      insertItem('python-1', 'snippets/restful.sh')
    ]);
    const calls: string[] = [];
    const client = {
      batchUpdateBlocks: vi.fn(async () => {
        calls.push('update');
        return [{ block_id: 'java-1', block_type: 14 }];
      }),
      createChildren: vi.fn(async () => {
        calls.push('insert');
        throw new Error('insert failed');
      })
    };

    const report = await applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: true
    });

    expect(calls).toEqual(['update', 'insert']);
    expect(report.updated).toEqual([
      expect.objectContaining({ blockId: 'java-1', wouldUpdateBlocks: 1, updatedBlocks: 1 })
    ]);
    expect(report.inserted).toEqual([]);
    expect(report.failed).toEqual([
      expect.objectContaining({
        action: 'insert',
        language: 'restful',
        message: 'insert failed'
      })
    ]);
  });

  it('inserts after the nearest processed preceding language instead of the last insert in the group', async () => {
    const dir = await snippetsDir();
    await writeManifest(dir, [
      insertItem('python-1', 'snippets/java.java', 'java', 'python-1'),
      updateItem('js-1', 'snippets/javascript.js', 'javascript'),
      updateItem('go-1', 'snippets/go.go', 'go'),
      insertItem('python-1', 'snippets/restful.sh', 'restful', 'go-1')
    ]);
    await writeFile(join(dir, 'snippets/javascript.js'), 'console.log("ok");', 'utf8');
    await writeFile(join(dir, 'snippets/go.go'), 'fmt.Println("ok")', 'utf8');
    const created = ['created-java', 'created-rest'];
    const client = {
      batchUpdateBlocks: vi.fn(async () => [{ block_type: 14 }]),
      getDocumentBlocks: vi.fn(async () => [
        { block_id: 'doc', block_type: 1, children: ['python-1', 'js-1', 'go-1'] },
        { block_id: 'python-1', block_type: 14 },
        { block_id: 'js-1', block_type: 14 },
        { block_id: 'go-1', block_type: 14 }
      ]),
      createChildren: vi.fn(async () => [{ block_id: created.shift(), block_type: 14 }])
    };

    const report = await applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: true
    });

    expect(report.failed).toEqual([]);
    expect(client.createChildren.mock.calls[0][3]).toEqual({ index: 1 });
    expect(client.createChildren.mock.calls[1][3]).toEqual({ index: 3 });
    expect(report.inserted.map((item) => item.insertAfterBlockId)).toEqual(['python-1', 'go-1']);
  });

  it('calculates insert indexes from the target parent children instead of flattened document order', async () => {
    const dir = await snippetsDir();
    await writeManifest(dir, [
      insertItem('python-1', 'snippets/restful.sh', 'restful', 'python-1', 'parent-1')
    ]);
    const client = {
      batchUpdateBlocks: vi.fn(),
      getDocumentBlocks: vi.fn(async () => [
        { block_id: 'doc', block_type: 1, children: ['intro', 'parent-1'] },
        { block_id: 'intro', block_type: 2 },
        { block_id: 'parent-1', block_type: 2, children: ['python-1', 'go-1'] },
        { block_id: 'python-1', block_type: 14 },
        { block_id: 'go-1', block_type: 14 }
      ]),
      createChildren: vi.fn(async () => [{ block_id: 'created-rest', block_type: 14 }])
    };

    await applyCodeBlockManifest(client, {
      manifestPath: join(dir, 'manifest.json'),
      write: true
    });

    expect(client.createChildren.mock.calls[0][1]).toBe('parent-1');
    expect(client.createChildren.mock.calls[0][3]).toEqual({ index: 1 });
  });
});

async function snippetsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-code-apply-'));
  tempDirsGlobal.push(dir);
  await mkdir(join(dir, 'snippets'), { recursive: true });
  await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");', 'utf8');
  await writeFile(join(dir, 'snippets/restful.sh'), 'curl http://localhost:19530/v2/vectordb/entities/search', 'utf8');
  return dir;
}

const tempDirsGlobal: string[] = [];
const tempDirs = tempDirsGlobal;

async function writeManifest(
  dir: string,
  items: CodeBlockManifest['items']
): Promise<CodeBlockManifest> {
  const manifest: CodeBlockManifest = {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function updateItem(
  blockId: string,
  file: string,
  language: 'java' | 'javascript' | 'go' | 'restful' = 'java'
): CodeBlockManifest['items'][number] {
  return {
    action: 'update',
    groupId: 'group-001',
    blockId,
    language,
    file
  };
}

function insertItem(
  anchorBlockId: string,
  file: string,
  language: 'java' | 'javascript' | 'go' | 'restful' = 'restful',
  insertAfterBlockId = anchorBlockId,
  parentBlockId = 'doc'
): CodeBlockManifest['items'][number] {
  return {
    action: 'insert',
    groupId: 'group-001',
    anchorBlockId,
    insertAfterBlockId,
    parentBlockId,
    language,
    file
  };
}

function fakeClient() {
  return {
    batchUpdateBlocks: vi.fn(),
    createChildren: vi.fn()
  };
}

function codeBlock(blockId: string, text: string, language: number) {
  return {
    block_id: blockId,
    block_type: 14,
    code: {
      elements: [{
        text_run: {
          content: text,
          text_element_style: {}
        }
      }],
      style: { language }
    }
  };
}
