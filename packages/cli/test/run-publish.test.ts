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
});
