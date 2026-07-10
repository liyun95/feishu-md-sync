import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { readPullReceipt } from '../src/receipts/pull-receipt.js';
import { hashText } from '../src/receipts/publish-receipt.js';
import { runPull } from '../src/pull/run-pull.js';

describe('runPull', () => {
  it('writes a profile-transformed remote snapshot and verifies the local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
        revision: '11'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'milvus',
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('# Title\n\nMilvus stores vectors.');
    expect(result).toMatchObject({
      mode: 'write',
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'milvus',
      remoteRevision: '11',
      warnings: []
    });
    expect(result.receiptPath).toBeUndefined();
  });

  it('refuses to overwrite an existing output before fetching the remote document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    await writeFile(output, 'existing local snapshot', 'utf8');
    let fetches = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        fetches += 1;
        return { markdown: 'Remote' };
      },
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    })).rejects.toThrow('Refusing to overwrite existing output without --overwrite');
    expect(fetches).toBe(0);
  });

  it('overwrites when requested and writes an independent pull snapshot receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    await writeFile(output, 'existing local snapshot', 'utf8');
    const remoteMarkdown = '# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: remoteMarkdown,
        revision: '12'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'zilliz',
      overwrite: true,
      writeReceipt: true,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('# Title\n\nZilliz Cloud stores vectors.');
    expect(result.receiptPath).toContain('/.sync/feishu-md-sync/pulls/');
    await expect(readPullReceipt({
      cwd: dir,
      outputPath: result.outputPath,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      kind: 'pull-snapshot',
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: 'doc.remote.md',
      profile: 'zilliz',
      remoteRevision: '12',
      remoteRawHash: hashText(remoteMarkdown),
      outputHash: hashText('# Title\n\nZilliz Cloud stores vectors.')
    });
  });
});
