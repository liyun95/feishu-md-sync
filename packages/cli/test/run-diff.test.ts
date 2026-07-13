import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

  it('reports HTML table row additions as structured scoped diffs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-table-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, htmlTable([
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ]), 'utf8');

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      adapter: tableAdapter([['ef', 'Accuracy trade-off.']])
    });

    expect(result.scoped.tables).toEqual([expect.objectContaining({
      additions: [{ key: 'num_random_samplings', index: 1 }]
    })]);
  });

  it('reports an asset-level Whiteboard creation diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-whiteboard-'));
    const assets = join(dir, 'assets');
    const file = join(dir, 'doc.md');
    const markdown = '![CAGRA](./assets/cagra.png)';
    await mkdir(assets);
    await writeFile(file, markdown, 'utf8');
    await writeFile(join(assets, 'cagra.png'), 'png', 'utf8');
    await writeFile(join(assets, 'cagra.svg'), '<svg viewBox="0 0 10 10"><text>CAGRA</text></svg>', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: { nodes: [{ text: 'CAGRA' }] } }),
      updateWhiteboard: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      syncWhiteboards: true,
      adapter
    });

    expect(result.scoped.whiteboards).toEqual([expect.objectContaining({
      assetKey: 'assets/cagra.png',
      state: 'untracked',
      local: 'changed',
      remote: 'untracked',
      action: 'replace remote image with whiteboard'
    })]);
    expect(result.hasDiff).toBe(true);
  });

  it('includes Whiteboard discovery blockers in scoped diff output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-whiteboard-blocker-'));
    const assets = join(dir, 'assets');
    const file = join(dir, 'doc.md');
    await mkdir(assets);
    await writeFile(file, '![CAGRA](./assets/cagra.png)', 'utf8');
    await writeFile(join(assets, 'cagra.png'), 'png', 'utf8');
    await writeFile(join(assets, 'cagra.svg'), '<svg viewBox="0 0 10 10"><filter id="shadow"></filter></svg>', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: { nodes: [{ text: 'CAGRA' }] } }),
      updateWhiteboard: async () => {}
    };

    const result = await runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      syncWhiteboards: true,
      adapter
    });

    expect(result.scoped.blockers).toContainEqual(expect.objectContaining({ code: 'invalid-svg' }));
  });

  it('fails closed when explicit Whiteboard analysis throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-whiteboard-error-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Milvus stores vectors.' }),
      resolveDocumentId: async () => { throw new Error('block analysis unavailable'); },
      replaceDocument: async () => {}
    };

    await expect(runDiff({
      cwd: dir,
      sourcePath: file,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      syncWhiteboards: true,
      adapter
    })).rejects.toThrow('block analysis unavailable');
  });
});

function diffAdapter(markdown: string): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown, revision: 'rev1' }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

function tableAdapter(rows: Array<[string, string]>): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown: '| Parameter | Description |\n|-|-|\n| `ef` | Accuracy trade-off. |' }),
    fetchDocBlocks: async () => ({ blocks: tableBlocks(rows) }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

function htmlTable(rows: Array<[string, string]>): string {
  return `<table><tr><th>Parameter</th><th>Description</th></tr>${rows.map(([key, value]) => {
    return `<tr><td><code>${key}</code></td><td>${value}</td></tr>`;
  }).join('')}</table>`;
}

function tableBlocks(rows: Array<[string, string]>) {
  const values = [['Parameter', 'Description'] as [string, string], ...rows];
  const cellIds = values.flatMap((_, row) => [`c${row}-0`, `c${row}-1`]);
  const blocks: Array<Record<string, unknown>> = [
    { block_id: 'doc_token', block_type: 1, children: ['table1'] },
    { block_id: 'table1', block_type: 31, table: { property: { row_size: values.length, column_size: 2 }, cells: cellIds } }
  ];
  values.forEach(([first, second], row) => {
    [first, second].forEach((value, column) => {
      const cellId = `c${row}-${column}`;
      blocks.push({ block_id: cellId, block_type: 32, children: [`${cellId}-p`] });
      blocks.push({
        block_id: `${cellId}-p`,
        block_type: 2,
        text: { elements: [{ text_run: { content: value, text_element_style: column === 0 && row > 0 ? { inline_code: true } : {} } }] }
      });
    });
  });
  return blocks as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}
