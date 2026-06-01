import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashBlocks } from '../src/core/hash.js';
import type { FeishuBlock, FeishuDriveFile } from '../src/feishu/types.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { runPublishNew, type PublishNewClient } from '../src/sync/publish-new.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'publish-new-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('publish-new runner', () => {
  it('dry-runs by default and creates nothing', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const client = fakePublishClient(markdownToFeishuBlocks('# Doc\n\nBody\n'));

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { folderToken: 'folder-token' },
      env: {}
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.title).toBe('Doc');
    expect(client.createDocxDocument).not.toHaveBeenCalled();
    await expect(readFile(result.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes, verifies readback, and stores a receipt after creating blocks', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const desired = markdownToFeishuBlocks('# Doc\n\nBody\n');
    const client = fakePublishClient(desired);

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { folderToken: 'folder-token' },
      env: {},
      write: true,
      yes: true
    });

    expect(client.createDocxDocument).toHaveBeenCalledWith('Doc', 'folder-token');
    expect(client.createChildren).toHaveBeenCalledWith('doc-created', 'page', desired);
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
      feishuDocId: string;
      verificationResult: { ok: boolean };
      publish?: {
        workflow: string;
        title: string;
        documentUrl?: string;
        destination: { kind: string; folderToken?: string };
        creationStrategy: string;
      };
    };
    expect(receipt.feishuDocId).toBe('doc-created');
    expect(receipt.verificationResult.ok).toBe(true);
    expect(receipt.publish).toEqual({
      workflow: 'publish-new',
      title: 'Doc',
      documentUrl: 'https://example.feishu.cn/docx/doc-created',
      destination: {
        kind: 'folder',
        folderToken: 'folder-token',
        source: '--folder-token'
      },
      creationStrategy: 'block-pipeline'
    });
    expect(result.document?.publishedUrl).toBe('https://example.feishu.cn/docx/doc-created');
  });

  it('creates an app-owned docx without a folder token when explicitly requested', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const desired = markdownToFeishuBlocks('# Doc\n\nBody\n');
    const client = fakePublishClient(desired);

    await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { appOwned: true },
      env: {},
      write: true,
      yes: true
    });

    expect(client.createDocxDocument).toHaveBeenCalledWith('Doc', undefined);
  });

  it('builds a docx URL from FEISHU_WEB_BASE_URL when Feishu omits one', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const desired = markdownToFeishuBlocks('# Doc\n\nBody\n');
    const client = fakePublishClient(desired, { omitCreatedUrl: true });

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { appOwned: true },
      env: { FEISHU_WEB_BASE_URL: 'https://zilliverse.feishu.cn' },
      write: true,
      yes: true
    });

    expect(result.document?.publishedUrl).toBe('https://zilliverse.feishu.cn/docx/doc-created');
  });

  it('moves the created docx into wiki before writing the receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const desired = markdownToFeishuBlocks('# Doc\n');
    const client = fakePublishClient(desired);

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: {},
      write: true,
      yes: true
    });

    expect(client.moveDocxToWiki).toHaveBeenCalledWith({
      documentId: 'doc-created',
      spaceId: 'space-id',
      parentNodeToken: 'parent-node'
    });
    expect(result.document?.publishedUrl).toBe('https://example.feishu.cn/wiki/wiki-node');
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
      publish?: { wikiUrl?: string; wikiNodeToken?: string };
    };
    expect(receipt.publish).toMatchObject({
      wikiUrl: 'https://example.feishu.cn/wiki/wiki-node',
      wikiNodeToken: 'wiki-node'
    });
  });

  it('looks up the wiki child when move succeeds without returning a node URL', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const desired = markdownToFeishuBlocks('# Doc\n');
    const client = fakePublishClient(desired, {
      moveResult: {},
      wikiNodes: [{
        title: 'Doc',
        nodeToken: 'wiki-created',
        objToken: 'doc-created'
      }]
    });

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        title: 'Wiki Fallback',
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: { FEISHU_WEB_BASE_URL: 'https://example.feishu.cn' },
      write: true,
      yes: true
    });

    expect(result.document?.publishedUrl).toBe('https://example.feishu.cn/wiki/wiki-created');
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
      publish?: { wikiUrl?: string; wikiNodeToken?: string };
    };
    expect(receipt.publish).toMatchObject({
      wikiUrl: 'https://example.feishu.cn/wiki/wiki-created',
      wikiNodeToken: 'wiki-created'
    });
  });

  it('resolves wiki space id from the wiki parent node when omitted', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const desired = markdownToFeishuBlocks('# Doc\n');
    const client = fakePublishClient(desired, {
      wikiNode: { spaceId: 'resolved-space-id' }
    });

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        wikiParent: 'https://example.feishu.cn/wiki/WikiParent123'
      },
      env: {},
      write: true,
      yes: true
    });

    expect(client.getWikiNode).toHaveBeenCalledWith('WikiParent123');
    expect(client.moveDocxToWiki).toHaveBeenCalledWith({
      documentId: 'doc-created',
      spaceId: 'resolved-space-id',
      parentNodeToken: 'WikiParent123'
    });
    expect(result.plan.destination).toMatchObject({
      kind: 'wiki',
      spaceId: 'resolved-space-id',
      parentNodeToken: 'WikiParent123'
    });
  });

  it('refuses duplicate titles before creating anything', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const client = fakePublishClient(markdownToFeishuBlocks('# Doc\n'), {
      folderFiles: [{ name: 'Doc', token: 'existing-doc', url: 'https://example.feishu.cn/docx/existing-doc', type: 'docx' }]
    });

    await expect(runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { folderToken: 'folder-token' },
      env: {},
      write: true,
      yes: true
    })).rejects.toThrow(/A document named "Doc" already exists in the destination/);

    expect(client.createDocxDocument).not.toHaveBeenCalled();
  });

  it('refuses duplicate wiki titles before creating anything', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const client = fakePublishClient(markdownToFeishuBlocks('# Doc\n'), {
      wikiNodes: [{ title: 'Doc', nodeToken: 'wiki-existing', url: 'https://example.feishu.cn/wiki/wiki-existing' }]
    });

    await expect(runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: {},
      write: true,
      yes: true
    })).rejects.toThrow(/A document named "Doc" already exists in the destination/);

    expect(client.createDocxDocument).not.toHaveBeenCalled();
  });

  it('allows duplicate titles when explicitly requested', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const desired = markdownToFeishuBlocks('# Doc\n');
    const client = fakePublishClient(desired, {
      folderFiles: [{ name: 'Doc', token: 'existing-doc', url: 'https://example.feishu.cn/docx/existing-doc', type: 'docx' }]
    });

    await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        allowDuplicateTitle: true
      },
      env: {},
      write: true,
      yes: true
    });

    expect(client.createDocxDocument).toHaveBeenCalledWith('Doc', 'folder-token');
  });

  it('reports partial failure after docx creation without writing a receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n');
    const client = fakePublishClient(markdownToFeishuBlocks('# Doc\n'), {
      moveError: new Error('wiki permission denied')
    });

    await expect(runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: {},
      write: true,
      yes: true
    })).rejects.toThrow(/Failed step: move to wiki/);
    await expect(runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: {
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParent: 'parent-node'
      },
      env: {},
      write: true,
      yes: true
    })).rejects.toThrow(/Fix the destination parent node permission/);

    await expect(readFile(path.join(dir, '.sync', 'feishu', 'doc.md.doc-created.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports readback verification failure without writing a receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nExpected\n');
    const client = fakePublishClient(markdownToFeishuBlocks('# Doc\n\nActual\n'));

    await expect(runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      options: { folderToken: 'folder-token' },
      env: {},
      write: true,
      yes: true
    })).rejects.toThrow(/Failed step: verify readback/);

    await expect(readFile(path.join(dir, '.sync', 'feishu', 'doc.md.doc-created.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function fakePublishClient(
  readbackChildren: FeishuBlock[],
  options: {
    folderFiles?: FeishuDriveFile[];
    wikiNodes?: Array<{ title?: string; url?: string; nodeToken?: string; objToken?: string }>;
    wikiNode?: { spaceId?: string };
    moveResult?: { nodeToken?: string; url?: string };
    moveError?: Error;
    omitCreatedUrl?: boolean;
  } = {}
): PublishNewClient & {
  createDocxDocument: ReturnType<typeof vi.fn>;
  createChildren: ReturnType<typeof vi.fn>;
  moveDocxToWiki: ReturnType<typeof vi.fn>;
} {
  const page = { block_id: 'page', block_type: 1, children: readbackChildren.map((_, index) => `child-${index + 1}`) };
  const childBlocks = readbackChildren.map((block, index) => ({
    ...block,
    block_id: `child-${index + 1}`,
    parent_id: 'page'
  }));
  return {
    getDocumentBlocks: vi.fn(async () => [page, ...childBlocks]),
    deleteChildren: vi.fn(),
    createChildren: vi.fn(async (_documentId: string, _parentBlockId: string, blocks: FeishuBlock[]) => blocks.map((block, index) => ({
      ...block,
      block_id: `created-${index + 1}`,
      parent_id: 'page'
    }))),
    createDocxDocument: vi.fn(async () => options.omitCreatedUrl
      ? { document_id: 'doc-created' }
      : {
        document_id: 'doc-created',
        url: 'https://example.feishu.cn/docx/doc-created'
      }),
    listFolder: vi.fn(async () => options.folderFiles ?? []),
    listWikiChildren: vi.fn(async () => options.wikiNodes ?? []),
    getWikiNode: vi.fn(async () => options.wikiNode ?? {}),
    moveDocxToWiki: vi.fn(async () => {
      if (options.moveError) throw options.moveError;
      return options.moveResult ?? {
        nodeToken: 'wiki-node',
        url: 'https://example.feishu.cn/wiki/wiki-node'
      };
    }),
    batchUpdateBlocks: vi.fn(),
    __expectedHash: hashBlocks(readbackChildren)
  } as unknown as PublishNewClient & {
    createDocxDocument: ReturnType<typeof vi.fn>;
    createChildren: ReturnType<typeof vi.fn>;
    moveDocxToWiki: ReturnType<typeof vi.fn>;
  };
}
