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

  it('includes a block-patch plan during dry-run when remote blocks are available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Milvus stores vectors.' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'page', block_type: 1, children: ['p1'] },
          {
            block_id: 'p1',
            block_type: 2,
            text: {
              elements: [{ text_run: { content: 'Milvus stores vectors.', text_element_style: {} } }]
            }
          }
        ]
      }),
      replaceDocument: async () => {}
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(result.plan.blockPatch?.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      path: [0],
      blockType: 2
    }]);
  });

  it('plans block-patch against the document body when the leading title matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '# lark-cli-test\n\nMilvus stores vector data.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '# lark-cli-test\n\nMilvus stores vectors.' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['p1'] },
          textBlock('p1', 'Milvus stores vectors.')
        ]
      }),
      replaceDocument: async () => {}
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.blockPatch?.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      path: [0],
      blockType: 2
    }]);
  });

  it('treats an empty block-patch as a no-op even when write is requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '# lark-cli-test\n\nMilvus stores vector data.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: '# lark-cli-test\n\nMilvus stores vector data.\n',
      afterMarkdown: '# lark-cli-test\n\nMilvus stores vector data.\n',
      blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['p1'] },
        textBlock('p1', 'Milvus stores vector data.')
      ]
    });

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.strategy).toBe('no-op');
    expect(result.plan.blockPatch?.operations).toEqual([]);
    expect(adapter.calls).toEqual([]);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toBeUndefined();
  });

  it('requires collaboration-risk confirmation before block-patch updates existing blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'Milvus stores vectors.',
      afterMarkdown: 'Milvus stores vector data.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        textBlock('p1', 'Milvus stores vectors.')
      ]
    });

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    })).rejects.toThrow('block-patch replacing or deleting existing blocks requires --confirm-collaboration-risk');
    expect(adapter.calls).toEqual([]);
  });

  it('writes a confirmed block-patch update and records a receipt after readback verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'Milvus stores vectors.',
      afterMarkdown: 'Milvus stores vector data.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        textBlock('p1', 'Milvus stores vectors.')
      ]
    });

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(adapter.calls).toEqual(['replace:p1:Milvus stores vector data.']);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toMatchObject({
      profile: 'none',
      target: { kind: 'docx', token: 'doc_token' }
    });
  });

  it('writes a block-patch create with the planned insert anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'First paragraph.\n\nSecond paragraph.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'First paragraph.',
      afterMarkdown: 'First paragraph.\n\nSecond paragraph.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        textBlock('p1', 'First paragraph.')
      ]
    });

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'block-patch',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(adapter.calls).toEqual(['insert-after:p1:Second paragraph.']);
  });

  it('writes a confirmed block-patch delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'First paragraph.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'First paragraph.\n\nSecond paragraph.',
      afterMarkdown: 'First paragraph.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1', 'p2'] },
        textBlock('p1', 'First paragraph.'),
        textBlock('p2', 'Second paragraph.')
      ]
    });

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'block-patch',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(adapter.calls).toEqual(['delete:p2']);
  });

  it('refuses to write a receipt when block-patch readback verification fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'Milvus stores vectors.',
      afterMarkdown: 'Unexpected remote.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        textBlock('p1', 'Milvus stores vectors.')
      ]
    });

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      confirmUntrackedRemote: true,
      adapter
    })).rejects.toThrow('block-patch readback verification failed');
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toBeUndefined();
  });

  it('falls back to document-replace planning when block fetch is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Milvus stores vectors.' }),
      fetchDocBlocks: async () => {
        throw new Error('missing docx block permission');
      },
      replaceDocument: async () => {}
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.strategy).toBe('document-replace');
    expect(result.plan.warnings).toContain('block-patch planning unavailable: missing docx block permission');
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

  it('honors explicit document-replace even when block planning is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const writes: string[] = [];
    let blockFetches = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: writes.at(-1) ?? 'Milvus stores vectors.', revision: 'rev1' }),
      fetchDocBlocks: async () => {
        blockFetches += 1;
        return { blocks: [] };
      },
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'document-replace',
      confirmDestructive: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(result.plan.strategy).toBe('document-replace');
    expect(blockFetches).toBe(0);
    expect(writes).toEqual(['Milvus stores vector data.']);
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

function textBlock(blockId: string, text: string): { block_id: string; block_type: number; text: { elements: Array<{ text_run: { content: string; text_element_style: Record<string, never> } }> } } {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: {} } }]
    }
  };
}

function blockPatchAdapter(input: {
  beforeMarkdown: string;
  afterMarkdown: string;
  blocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}): FeishuAdapter & { calls: string[] } {
  let written = false;
  const calls: string[] = [];
  return {
    calls,
    fetchDocMarkdown: async () => ({
      markdown: written ? input.afterMarkdown : input.beforeMarkdown,
      revision: written ? 'after' : 'before'
    }),
    fetchDocBlocks: async () => ({ blocks: input.blocks }),
    replaceDocument: async () => {},
    replaceBlock: async ({ blockId, markdown }) => {
      calls.push(`replace:${blockId}:${markdown}`);
      written = true;
    },
    insertBlocksAfter: async ({ blockId, markdown }) => {
      calls.push(`insert-after:${blockId}:${markdown}`);
      written = true;
    },
    deleteBlocks: async ({ blockIds }) => {
      calls.push(`delete:${blockIds.join(',')}`);
      written = true;
    }
  };
}
