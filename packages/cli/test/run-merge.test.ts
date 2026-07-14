import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { runMerge } from '../src/merge/run-merge.js';
import { hashText, writeLocalBaseSnapshot, writePublishReceipt } from '../src/receipts/publish-receipt.js';

describe('runMerge', () => {
  it('preserves a local Code language alias when the resolved remote language is unchanged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-code-'));
    const file = join(cwd, 'doc.md');
    const basePath = join(cwd, 'base.md');
    const remotePath = join(cwd, 'remote.md');
    const base = '```curl\ncurl old\n```\n';
    await writeFile(file, base, 'utf8');
    await writeFile(basePath, base, 'utf8');
    await writeFile(remotePath, '```bash\ncurl new\n```\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      remotePath,
      basePath,
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('')
    });

    expect(result.state).toBe('merged');
    await expect(readFile(file, 'utf8')).resolves.toBe('```curl\ncurl new\n```\n');
  });

  it('preserves an alias on the corresponding Code block after a remote insertion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-code-'));
    const file = join(cwd, 'doc.md');
    const basePath = join(cwd, 'base.md');
    const remotePath = join(cwd, 'remote.md');
    const base = '# Build\n\n```curl\ncurl old\n```\n';
    await writeFile(file, base, 'utf8');
    await writeFile(basePath, base, 'utf8');
    await writeFile(remotePath, '# Build\n\n```python\nprint(1)\n```\n\n```bash\ncurl old\n```\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      remotePath,
      basePath,
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('')
    });

    expect(result.state).toBe('merged');
    const merged = await readFile(file, 'utf8');
    expect(merged).toContain('```python\nprint(1)\n```');
    expect(merged).toContain('```curl\ncurl old\n```');
  });

  it('check mode canonicalizes a target Callout and reports a clean remote-only body edit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-callout-'));
    const file = join(cwd, 'doc.md');
    const base = canonicalCallout('Original body.');
    await writeFile(file, base, 'utf8');
    const basePath = await writeRemote(cwd, base);

    const result = await runMerge({
      cwd,
      filePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      basePath,
      profile: 'none',
      mode: 'check',
      adapter: mergeAdapter('<callout emoji="📘">\nNotes\nRemote body.\n</callout>\n')
    });

    expect(result.state).toBe('merged');
    expect(result.summary).toEqual({ conflicts: 0, changed: true });
    expect(result.remote).toMatchObject({
      source: 'target',
      hash: hashText(canonicalCallout('Remote body.'))
    });
    await expect(readFile(file, 'utf8')).resolves.toBe(base);
  });

  it('dry-run canonicalizes Callouts from a remote file without writing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-callout-'));
    const file = join(cwd, 'doc.md');
    const base = canonicalCallout('Original body.');
    await writeFile(file, base, 'utf8');
    const basePath = join(cwd, 'base.md');
    const remotePath = join(cwd, 'remote.md');
    await writeFile(basePath, base, 'utf8');
    await writeFile(remotePath, '<callout emoji="❗">\n警告\n远端正文。\n</callout>\n', 'utf8');

    const result = await runMerge({
      cwd,
      filePath: file,
      remotePath,
      basePath,
      profile: 'none',
      callouts: { noteTitle: '说明', warningTitle: '警告' },
      mode: 'dry-run',
      adapter: mergeAdapter('')
    });

    expect(result.state).toBe('merged');
    expect(result.remote).toMatchObject({
      source: 'remote-file',
      hash: hashText(canonicalCallout('远端正文。', 'warning'))
    });
    await expect(readFile(file, 'utf8')).resolves.toBe(base);
  });

  it('write mode stores the canonical Callout after a remote-only body edit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-callout-'));
    const file = join(cwd, 'doc.md');
    const saved = join(cwd, 'snapshots', 'remote.md');
    const base = canonicalCallout('Original body.');
    await writeFile(file, base, 'utf8');
    const basePath = await writeRemote(cwd, base);

    const result = await runMerge({
      cwd,
      filePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      basePath,
      saveRemotePath: saved,
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('<callout emoji="📘">\nNotes\nRemote body.\n</callout>\n')
    });

    expect(result.state).toBe('merged');
    await expect(readFile(file, 'utf8')).resolves.toBe(canonicalCallout('Remote body.'));
    await expect(readFile(saved, 'utf8')).resolves.toBe(canonicalCallout('Remote body.'));
  });

  it('reports a conflict when local and remote edit the same Callout body line', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-callout-'));
    const file = join(cwd, 'doc.md');
    const base = canonicalCallout('Original body.');
    await writeFile(file, canonicalCallout('Local body.'), 'utf8');
    const basePath = await writeRemote(cwd, base);

    const result = await runMerge({
      cwd,
      filePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      basePath,
      profile: 'none',
      mode: 'write',
      adapter: mergeAdapter('<callout emoji="📘">\nNotes\nRemote body.\n</callout>\n')
    });

    expect(result.state).toBe('conflict');
    expect(result.summary.conflicts).toBe(1);
    const merged = await readFile(file, 'utf8');
    expect(merged).toContain('<<<<<<< LOCAL\nLocal body.\n=======\nRemote body.\n>>>>>>> REMOTE');
    expect(merged).toContain('<div class="alert note">');
  });

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

  it('uses current local file as base when receipt has no base snapshot but local source is unchanged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-'));
    const file = join(cwd, 'doc.md');
    const local = '# Title\n\nMilvus stores vector data.\n';
    await writeFile(file, local, 'utf8');
    const target = { kind: 'docx' as const, token: 'doc_token' };
    await writePublishReceipt({
      cwd,
      receipt: {
        version: 1,
        target,
        profile: 'zilliz',
        localSourceHash: hashText(local),
        publishDraftHash: 'publish',
        remoteSnapshotHash: 'remote',
        updatedAt: '2026-07-10T00:00:00.000Z'
      }
    });

    const result = await runMerge({
      cwd,
      filePath: file,
      target,
      profile: 'milvus',
      mode: 'check',
      adapter: mergeAdapter('# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n\nRemote only.\n')
    });

    expect(result.state).toBe('merged');
    expect(result.base).toMatchObject({ source: 'current-local', hash: hashText(local) });
    expect(result.summary.conflicts).toBe(0);
    expect(result.warnings).toContain('receipt has no readable local base snapshot; using current local file as merge base because it still matches the last published source');
    await expect(readFile(file, 'utf8')).resolves.toBe(local);
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

function canonicalCallout(body: string, type: 'note' | 'warning' = 'note'): string {
  return `<div class="alert ${type}">\n\n${body}\n\n</div>\n`;
}
