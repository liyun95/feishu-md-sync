import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { hashText, writePublishReceipt } from '../src/receipts/publish-receipt.js';
import { runDiff } from '../src/diff/run-diff.js';

describe('runDiff', () => {
  it('reports no diff when canonical publish draft and remote match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.\n', 'utf8');

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: diffAdapter('Milvus stores vectors.\n\n')
    });

    expect(result.hasDiff).toBe(false);
    expect(result.diff).toBe('');
    expect(result.status.contentMatchesRemote).toBe(true);
  });

  it('shows publish additions as plus lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'New local sentence.', 'utf8');

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: diffAdapter('Old remote sentence.')
    });

    expect(result.hasDiff).toBe(true);
    expect(result.diff).toContain('--- remote-current');
    expect(result.diff).toContain('+++ publish-draft');
    expect(result.diff).toContain('-Old remote sentence.');
    expect(result.diff).toContain('+New local sentence.');
  });

  it('compares the transformed zilliz publish draft with remote current', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vector data.', 'utf8');
    const remote = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n';

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      adapter: diffAdapter(remote)
    });

    expect(result.hasDiff).toBe(false);
    expect(result.status.state).toBe('untracked');
    expect(result.status.contentMatchesRemote).toBe(true);
  });

  it('still returns a diff when status is diverged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'New local sentence.', 'utf8');
    await writePublishReceipt({
      cwd: dir,
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'none',
        localSourceHash: 'old-source',
        publishDraftHash: hashText('Old sentence.'),
        remoteSnapshotHash: hashText('Old sentence.'),
        updatedAt: '2026-07-09T00:00:00.000Z'
      }
    });

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: diffAdapter('Remote teammate sentence.')
    });

    expect(result.status.state).toBe('diverged');
    expect(result.hasDiff).toBe(true);
    expect(result.diff).toContain('-Remote teammate sentence.');
    expect(result.diff).toContain('+New local sentence.');
  });
});

function diffAdapter(markdown: string): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown, revision: 'rev1' }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}
