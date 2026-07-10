import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { runMerge } from '../src/merge/run-merge.js';
import { hashText, writeLocalBaseSnapshot, writePublishReceipt } from '../src/receipts/publish-receipt.js';

describe('runMerge', () => {
  it('fetches target, applies pull profile, and merges into local file using receipt base', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, '# Title\n\nMilvus stores vector data.\n\nLocal only.\n', 'utf8');
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = '# Title\n\nMilvus stores vector data.\n';
    const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd, target, markdown: base });
    await writePublishReceipt({
      cwd,
      receipt: {
        version: 1,
        target,
        profile: 'zilliz',
        localSourceHash: hashText(base),
        publishDraftHash: 'publish',
        remoteSnapshotHash: 'remote',
        localBaseSnapshot,
        updatedAt: '2026-07-10T00:00:00.000Z'
      }
    });

    const result = await runMerge({
      cwd,
      filePath: file,
      target,
      profile: 'milvus',
      mode: 'write',
      adapter: mergeAdapter('# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n\nRemote only.\n')
    });

    expect(result.state).toBe('merged');
    expect(result.base).toMatchObject({ source: 'receipt', hash: hashText(base) });
    expect(result.remote).toMatchObject({ source: 'target', revision: 'rev1' });
    expect(result.summary.conflicts).toBe(0);
    await expect(readFile(file, 'utf8')).resolves.toBe('# Title\n\nMilvus stores vector data.\n\nLocal only.\nRemote only.\n');
  });

  it('without base writes diff-region conflict markers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, '# Title\n\nLocal paragraph.\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      remotePath: await writeRemote(cwd, '# Title\n\nRemote paragraph.\n'),
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('')
    });

    expect(result.state).toBe('conflict');
    expect(result.base).toEqual({ source: 'none' });
    expect(result.summary.conflicts).toBe(1);
    await expect(readFile(file, 'utf8')).resolves.toContain('<<<<<<< LOCAL');
  });

  it('check mode reports conflict without writing the local file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, 'Local\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      remotePath: await writeRemote(cwd, 'Remote\n'),
      profile: 'none',
      mode: 'check',
      adapter: mergeAdapter('')
    });

    expect(result.mode).toBe('check');
    expect(result.state).toBe('conflict');
    await expect(readFile(file, 'utf8')).resolves.toBe('Local\n');
  });

  it('aborts a previous in-place merge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, 'Local\n', 'utf8');
    await runMerge({
      cwd,
      filePath: file,
      remotePath: await writeRemote(cwd, 'Remote\n'),
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('')
    });

    const result = await runMerge({
      cwd,
      filePath: file,
      profile: 'none',
      mode: 'abort',
      adapter: mergeAdapter('')
    });

    expect(result.state).toBe('aborted');
    await expect(readFile(file, 'utf8')).resolves.toBe('Local\n');
  });

  it('refuses to merge files with unresolved conflict markers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, '<<<<<<< LOCAL\nx\n=======\ny\n>>>>>>> REMOTE\n', 'utf8');

    await expect(runMerge({
      cwd,
      filePath: file,
      remotePath: await writeRemote(cwd, 'Remote\n'),
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('')
    })).rejects.toThrow('unresolved conflict markers');
  });

  it('saves fetched remote snapshots when requested', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    const saved = join(cwd, 'snapshots', 'remote.md');
    await writeFile(file, 'Milvus\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      saveRemotePath: saved,
      profile: 'milvus',
      mode: 'dry-run',
      adapter: mergeAdapter('<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>\n')
    });

    expect(result.remote).toMatchObject({ source: 'target', savedPath: saved });
    await expect(readFile(saved, 'utf8')).resolves.toBe('Milvus\n');
    await expect(readFile(file, 'utf8')).resolves.toBe('Milvus\n');
  });
});

function mergeAdapter(markdown: string): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown, revision: 'rev1' }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

async function writeRemote(cwd: string, markdown: string): Promise<string> {
  const path = join(cwd, 'doc.remote.md');
  await writeFile(path, markdown, 'utf8');
  return path;
}
