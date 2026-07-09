import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { readPublishReceipt } from '../src/receipts/publish-receipt.js';
import { runPublish } from '../src/publish/run-publish.js';

describe('runPublish', () => {
  it('returns a dry-run plan without writing remotely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old remote.' }),
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.strategy).toBe('document-replace');
    expect(writes).toEqual([]);
  });

  it('refuses document replace without explicit destructive strategy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old remote.' }),
      replaceDocument: async () => {}
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    })).rejects.toThrow('document-replace requires --strategy document-replace');
  });

  it('writes guarded document replace and records a receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: writes.at(-1) ?? 'Old remote.', revision: 'rev1' }),
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: true,
      create: false,
      strategy: 'document-replace',
      confirmDestructive: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(writes).toEqual(['<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.']);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toMatchObject({
      profile: 'zilliz',
      target: { kind: 'docx', token: 'doc_token' }
    });
  });

  it('creates a new remote document under a folder target and records a receipt for the created doc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '# New Doc\n\nMilvus stores vectors.', 'utf8');
    const created: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.', revision: '2' }),
      replaceDocument: async () => {},
      createDocument: async ({ markdown, parentToken }) => {
        created.push(`${parentToken}:${markdown}`);
        return {
          documentId: 'doc_created',
          url: 'https://example.feishu.cn/docx/doc_created',
          revision: '1'
        };
      }
    };

    const dryRun = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'zilliz',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(dryRun.mode).toBe('dry-run');
    expect(dryRun.plan.strategy).toBe('create-document');
    expect(created).toEqual([]);

    const written = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'zilliz',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(written.mode).toBe('write');
    expect(written.document).toEqual({
      documentId: 'doc_created',
      url: 'https://example.feishu.cn/docx/doc_created'
    });
    expect(created).toEqual([
      'folder-token:# New Doc\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.'
    ]);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_created' } })).resolves.toMatchObject({
      target: { kind: 'docx', token: 'doc_created' },
      profile: 'zilliz'
    });
  });

  it('creates a new remote document under a wiki parent only when create mode is requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '# Wiki Child\n\nMilvus stores vectors.', 'utf8');
    const created: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.' }),
      replaceDocument: async () => {},
      createDocument: async ({ parentToken, markdown }) => {
        created.push(`${parentToken}:${markdown}`);
        return { documentId: 'doc_wiki_child', url: 'https://example.feishu.cn/wiki/wiki_child' };
      }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'wiki', token: 'wiki-parent' },
      profile: 'zilliz',
      write: true,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(result.plan.strategy).toBe('create-document');
    expect(result.document).toEqual({
      documentId: 'doc_wiki_child',
      url: 'https://example.feishu.cn/wiki/wiki_child'
    });
    expect(created).toEqual([
      'wiki-parent:# Wiki Child\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.'
    ]);
  });
});
