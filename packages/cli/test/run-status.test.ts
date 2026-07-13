import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { hashText, writePublishReceipt } from '../src/receipts/publish-receipt.js';
import { runStatus } from '../src/status/run-status.js';

describe('runStatus', () => {
  it('reports untracked when no publish receipt exists even if content matches remote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Milvus stores vectors.')
    });

    expect(result.state).toBe('untracked');
    expect(result.hasReceipt).toBe(false);
    expect(result.contentMatchesRemote).toBe(true);
    expect(result.recommendation.action).toBe('publish-dry-run');
  });

  it('reports untracked mismatch without calling block APIs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Local draft.', 'utf8');
    const adapter = statusAdapter('Remote draft.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter
    });

    expect(result.state).toBe('untracked');
    expect(result.contentMatchesRemote).toBe(false);
    expect(result.recommendation.action).toBe('adopt-or-replace');
    expect(adapter.blockFetches).toBe(0);
  });

  it('reports clean when local draft and remote match the publish receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');
    await seedPublishReceipt(dir, 'Milvus stores vectors.', 'Milvus stores vectors.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Milvus stores vectors.')
    });

    expect(result.state).toBe('clean');
    expect(result.localChanged).toBe(false);
    expect(result.remoteChanged).toBe(false);
    expect(result.recommendation.action).toBe('no-action');
  });

  it('reports local-changed when only the local publish draft changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'New local draft.', 'utf8');
    await seedPublishReceipt(dir, 'Old draft.', 'Old draft.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Old draft.')
    });

    expect(result.state).toBe('local-changed');
    expect(result.localChanged).toBe(true);
    expect(result.remoteChanged).toBe(false);
    expect(result.recommendation.action).toBe('publish-dry-run');
  });

  it('reports remote-changed when only the remote changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Old draft.', 'utf8');
    await seedPublishReceipt(dir, 'Old draft.', 'Old draft.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Teammate remote edit.')
    });

    expect(result.state).toBe('remote-changed');
    expect(result.localChanged).toBe(false);
    expect(result.remoteChanged).toBe(true);
    expect(result.recommendation.action).toBe('pull-review');
  });

  it('reports diverged when local and remote both changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'New local draft.', 'utf8');
    await seedPublishReceipt(dir, 'Old draft.', 'Old draft.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Teammate remote edit.')
    });

    expect(result.state).toBe('diverged');
    expect(result.localChanged).toBe(true);
    expect(result.remoteChanged).toBe(true);
    expect(result.recommendation.action).toBe('resolve-divergence');
  });

  it('recommends publish dry-run when local and remote match but the receipt is stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Merged content.', 'utf8');
    await seedPublishReceipt(dir, 'Old draft.', 'Old draft.');

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: statusAdapter('Merged content.')
    });

    expect(result.state).toBe('diverged');
    expect(result.contentMatchesRemote).toBe(true);
    expect(result.recommendation).toEqual({
      action: 'publish-dry-run',
      reason: 'content matches remote, but the publish receipt is stale'
    });
  });

  it('compares the transformed zilliz publish draft with the remote content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vector data.', 'utf8');
    const remote = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n';

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      adapter: statusAdapter(remote)
    });

    expect(result.state).toBe('untracked');
    expect(result.contentMatchesRemote).toBe(true);
    expect(result.publishDraftHash).not.toBe(result.remoteSnapshotHash);
    expect(result.publishDraftCanonicalHash).toBe(result.remoteCanonicalHash);
  });

  it('reports table scopes for untracked HTML table changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-table-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, '<table><tr><th>Parameter</th><th>Description</th></tr><tr><td><code>ef</code></td><td>New value.</td></tr></table>', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '| Parameter | Description |\n|-|-|\n| `ef` | Old value. |' }),
      fetchDocBlocks: async () => ({ blocks: statusTableBlocks('Old value.') }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runStatus({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter
    });

    expect(result.scopeSummary.localChanged).toContainEqual({
      sectionPath: [],
      kind: 'table',
      ordinal: 0
    });
  });
});

function statusTableBlocks(description: string) {
  return [
    { block_id: 'doc_token', block_type: 1, children: ['table1'] },
    { block_id: 'table1', block_type: 31, table: { property: { row_size: 2, column_size: 2 }, cells: ['c1', 'c2', 'c3', 'c4'] } },
    { block_id: 'c1', block_type: 32, children: ['p1'] },
    { block_id: 'p1', block_type: 2, text: { elements: [{ text_run: { content: 'Parameter', text_element_style: {} } }] } },
    { block_id: 'c2', block_type: 32, children: ['p2'] },
    { block_id: 'p2', block_type: 2, text: { elements: [{ text_run: { content: 'Description', text_element_style: {} } }] } },
    { block_id: 'c3', block_type: 32, children: ['p3'] },
    { block_id: 'p3', block_type: 2, text: { elements: [{ text_run: { content: 'ef', text_element_style: { inline_code: true } } }] } },
    { block_id: 'c4', block_type: 32, children: ['p4'] },
    { block_id: 'p4', block_type: 2, text: { elements: [{ text_run: { content: description, text_element_style: {} } }] } }
  ];
}

function statusAdapter(markdown: string): FeishuAdapter & { blockFetches: number } {
  return {
    blockFetches: 0,
    fetchDocMarkdown: async () => ({ markdown, revision: 'rev1' }),
    fetchDocBlocks: async function fetchDocBlocks() {
      this.blockFetches += 1;
      return { blocks: [] };
    },
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

async function seedPublishReceipt(cwd: string, publishDraft: string, remoteSnapshot: string): Promise<void> {
  await writePublishReceipt({
    cwd,
    receipt: {
      version: 1,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSourceHash: 'source',
      publishDraftHash: hashText(publishDraft),
      remoteSnapshotHash: hashText(remoteSnapshot),
      updatedAt: '2026-07-09T00:00:00.000Z'
    }
  });
}
