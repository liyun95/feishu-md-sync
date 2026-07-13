import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import {
  hashText,
  readLocalBaseSnapshot,
  readPublishReceipt,
  writeLocalBaseSnapshot,
  writePublishReceipt
} from '../src/receipts/publish-receipt.js';
import { writeRemoteSemanticSnapshot } from '../src/receipts/semantic-snapshot.js';
import { runPublish } from '../src/publish/run-publish.js';
import { semanticHash } from '../src/semantic/normalize.js';
import { whiteboardRemoteStateHash } from '../src/whiteboards/remote-state.js';

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
    expect(result.plan.strategy).toBe('blocked');
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
    expect(result.plan.scopedPatch?.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      locator: { sectionPath: [], kind: 'text', ordinal: 0 },
      desiredMarkdown: 'Milvus stores vector data.'
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
    expect(result.plan.scopedPatch?.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      locator: { sectionPath: [], kind: 'text', ordinal: 0 },
      desiredMarkdown: 'Milvus stores vector data.'
    }]);
  });

  it('finds the leading title after YAML frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '---\ntitle: GPU_CAGRA\n---\n\n# GPU_CAGRA\n\nMilvus stores vector data.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '# GPU_CAGRA\n\nMilvus stores vectors.' }),
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
    expect(result.plan.scopedPatch?.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      locator: { sectionPath: [], kind: 'text', ordinal: 0 },
      desiredMarkdown: 'Milvus stores vector data.'
    }]);
  });

  it('refreshes the publish receipt on no-op when write is requested', async () => {
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
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(result.plan.strategy).toBe('no-op');
    expect(result.plan.scopedPatch?.operations).toEqual([]);
    expect(adapter.calls).toEqual([]);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toMatchObject({
      profile: 'none',
      localSourceHash: hashText('# lark-cli-test\n\nMilvus stores vector data.'),
      publishDraftHash: hashText('# lark-cli-test\n\nMilvus stores vector data.')
    });
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

  it('blocks code block body updates until language-preserving IO is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '```python\nprint("new")\n```', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '```python\nprint("old")\n```' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['code1'] },
          codeBlock('code1', 'print("old")', 49)
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
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

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.scopedPatch?.operations).toEqual([]);
    expect(result.plan.scopedPatch?.blockers).toContainEqual(expect.objectContaining({
      code: 'unsupported-local-change',
      message: 'code block updates are unsupported until language-preserving IO is available'
    }));
  });

  it('adopts a missing remote code language when the body is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '```python\nprint("same")\n```', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '```python\nprint("same")\n```' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['code1'] },
          codeBlock('code1', 'print("same")')
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
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

    expect(result.plan.strategy).toBe('no-op');
    expect(result.plan.scopedPatch?.operations).toEqual([]);
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.warnings).toContain('adopting text representation difference at text:[]:0');
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
    })).rejects.toThrow('scoped readback verification failed');
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toBeUndefined();
  });

  it('replaces only a matched HTML table and records a version 2 receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, htmlParameterTable([
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ]), 'utf8');
    const adapter = tablePatchAdapter({
      before: [['ef', 'Accuracy trade-off.']],
      after: [
        ['ef', 'Accuracy trade-off.'],
        ['num_random_samplings', 'Initial random seed iterations.']
      ]
    });

    const dryRun = await runPublish({
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

    expect(dryRun.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({
      kind: 'table-replace',
      diff: expect.objectContaining({ additions: [{ key: 'num_random_samplings', index: 1 }], updates: [], blockers: [] })
    }));

    await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(adapter.calls[0]).toMatch(/^replace:table1:xml:<table>/);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toMatchObject({
      version: 2,
      resolvedDocumentId: 'doc_token'
    });
  });

  it('reports a partial write and preserves the prior receipt when a later table write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-partial-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, `New paragraph.\n\n${htmlParameterTable([
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ])}`, 'utf8');
    const beforeTable = feishuTableBlocks([['ef', 'Accuracy trade-off.']], 'table1');
    let textWritten = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old paragraph.\n\n| Parameter | Description |\n|-|-|\n| `ef` | Accuracy trade-off. |' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['p1', 'table1'] },
          textBlock('p1', textWritten ? 'New paragraph.' : 'Old paragraph.'),
          ...beforeTable
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ format }) => {
        if (format === 'xml') throw new Error('network failed');
        textWritten = true;
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    let thrown: unknown;
    try {
      await runPublish({
        cwd: dir,
        file: markdownPath,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'none',
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmUntrackedRemote: true,
        confirmCollaborationRisk: true,
        adapter
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'update' })],
      failedOperation: expect.objectContaining({ kind: 'table-replace' }),
      receiptWritten: false
    });
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toBeUndefined();
  });

  it('refuses block-patch writes when the remote changed since the last receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    await writePublishReceipt({
      cwd: dir,
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'none',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: hashText('Milvus stores vectors.'),
        updatedAt: '2026-07-09T00:00:00.000Z'
      }
    });
    const adapter = blockPatchAdapter({
      beforeMarkdown: 'Teammate changed the remote.',
      afterMarkdown: 'Milvus stores vector data.',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        textBlock('p1', 'Teammate changed the remote.')
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
      adapter
    })).rejects.toThrow('remote changed since last publish receipt');
    expect(adapter.calls).toEqual([]);
  });

  it('blocks auto planning when block fetch is unavailable', async () => {
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

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.warnings).toContain('block-patch planning unavailable: missing docx block permission');
  });

  it('refuses auto writes when scoped planning is blocked', async () => {
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
    })).rejects.toThrow('Scoped publish is blocked');
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

  it('saves local source markdown as merge base after successful publish write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-publish-base-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vector data.', 'utf8');
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: writes.at(-1) ?? 'Old remote.', revision: 'rev1' }),
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    await runPublish({
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

    const receipt = await readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } });
    expect(receipt?.localBaseSnapshot?.hash).toBe(hashText('Milvus stores vector data.'));
    await expect(readLocalBaseSnapshot({ cwd: dir, snapshot: receipt!.localBaseSnapshot! }))
      .resolves.toBe('Milvus stores vector data.');
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
    expect(blockFetches).toBe(1);
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

  it('plans a Whiteboard image replacement during dry-run', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
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

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.whiteboards?.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-create',
      assetKey: 'assets/cagra.png',
      remoteImageBlockId: 'image_block'
    })]);
  });

  it('combines text and Whiteboard changes in one dry-run plan', async () => {
    const fixture = await createWhiteboardFixture('New paragraph.\n\n![CAGRA](./assets/cagra.png)');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old paragraph.\n\n![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['p1', 'image_block'] },
        textBlock('p1', 'Old paragraph.'),
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: { nodes: [{ text: 'CAGRA' }] } }),
      updateWhiteboard: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      adapter
    });

    expect(result.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({ kind: 'update' }));
    expect(result.plan.whiteboards?.operations).toContainEqual(expect.objectContaining({ kind: 'whiteboard-create' }));
  });

  it('blocks Whiteboard sync before writing when SVG validation fails', async () => {
    const fixture = await createWhiteboardFixture(
      '![CAGRA](./assets/cagra.png)',
      '<svg viewBox="0 0 10 10"><filter id="shadow"></filter></svg>'
    );
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => {
        writes.push('create');
        return { blockId: 'wb_block', whiteboardToken: 'wb_token' };
      },
      queryWhiteboard: async () => ({ raw: { nodes: [] } }),
      updateWhiteboard: async () => { writes.push('update'); },
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      adapter
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({ code: 'invalid-svg' }));
    expect(writes).toEqual([]);
  });

  it('preserves current behavior and skips Whiteboard adapter calls when opt-in is false', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
    let queries = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      queryWhiteboard: async () => {
        queries += 1;
        return { raw: { nodes: [] } };
      },
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: false,
      adapter
    });

    expect(result.plan.whiteboards).toBeUndefined();
    expect(queries).toBe(0);
  });

  it('returns a blocked dry-run when the adapter lacks Whiteboard capabilities', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      adapter
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-adapter-unavailable' }));
  });

  it('creates and verifies a Whiteboard before writing a version 3 receipt', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
    let created = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)', revision: created ? '2' : '1' }),
      fetchDocBlocks: async () => ({ blocks: created ? [
        { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
        { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
      ] : [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      replaceImageWithWhiteboard: async () => {
        created = true;
        return { blockId: 'wb_block', whiteboardToken: 'wb_token' };
      },
      queryWhiteboard: async () => ({ raw: { nodes: [{ text: 'CAGRA' }] } }),
      updateWhiteboard: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(created).toBe(true);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 3,
        whiteboards: [{
          assetKey: 'assets/cagra.png',
          blockId: 'wb_block',
          whiteboardToken: 'wb_token',
          svgHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          remoteStateHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        }]
      });
  });

  it('preserves adapter method context during verified Whiteboard writes', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');

    class StatefulWhiteboardAdapter implements FeishuAdapter {
      private created = false;

      async fetchDocMarkdown() {
        return { markdown: '![CAGRA](remote-image)', revision: this.created ? '2' : '1' };
      }

      async fetchDocBlocks() {
        return { blocks: this.created ? [
          { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
          { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
        ] : [
          { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
          { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
        ] };
      }

      async replaceDocument() {}
      async replaceBlock() {}
      async insertBlocksAfter() {}
      async deleteBlocks() {}

      async replaceImageWithWhiteboard() {
        this.created = true;
        return { blockId: 'wb_block', whiteboardToken: 'wb_token' };
      }

      async queryWhiteboard() {
        return { raw: { nodes: [{ text: this.created ? 'CAGRA' : 'missing' }] } };
      }

      async updateWhiteboard() {}
    }

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter: new StatefulWhiteboardAdapter()
    });

    expect(result.mode).toBe('write');
  });

  it('updates a tracked Whiteboard in place with an idempotency token', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture(
      '![CAGRA](./assets/cagra.png)',
      updatedSvg
    );
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>'),
      remoteRaw: { nodes: [{ text: 'CAGRA v1' }] }
    });
    let remoteRaw: unknown = { nodes: [{ text: 'CAGRA v1' }] };
    const updates: Array<{ token: string; svg: string; idempotencyToken: string }> = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '2' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
        { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: remoteRaw }),
      updateWhiteboard: async ({ whiteboardToken, svg, idempotencyToken }) => {
        updates.push({ token: whiteboardToken, svg, idempotencyToken });
        remoteRaw = { nodes: [{ text: 'CAGRA v2' }] };
      },
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter
    });

    expect(updates).toEqual([expect.objectContaining({
      token: 'wb_token',
      svg: expect.stringContaining('CAGRA v2'),
      idempotencyToken: `fms-${semanticHash({
        whiteboardToken: 'wb_token',
        svgHash: hashText(updatedSvg)
      }).slice(0, 32)}`
    })]);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 3,
        whiteboards: [{ blockId: 'wb_block', whiteboardToken: 'wb_token' }]
      });
  });

  it('keeps the previous receipt when Whiteboard readback is missing expected text', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
    let created = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '![CAGRA](remote-image)' }),
      fetchDocBlocks: async () => ({ blocks: created ? [
        { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
        { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
      ] : [
        { block_id: 'doc_token', block_type: 1, children: ['image_block'] },
        { block_id: 'image_block', block_type: 27, image: { token: 'image_token' } }
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      replaceImageWithWhiteboard: async () => {
        created = true;
        return { blockId: 'wb_block', whiteboardToken: 'wb_token' };
      },
      queryWhiteboard: async () => ({ raw: { nodes: [{ text: 'Different' }] } }),
      updateWhiteboard: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter
    })).rejects.toThrow('Whiteboard readback is missing expected text: CAGRA');

    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toBeUndefined();
  });
});

async function createWhiteboardFixture(markdown: string, svg = '<svg viewBox="0 0 10 10"><text>CAGRA</text></svg>') {
  const dir = await mkdtemp(join(tmpdir(), 'fms-whiteboard-run-'));
  const assets = join(dir, 'assets');
  const markdownPath = join(dir, 'doc.md');
  await mkdir(assets);
  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(join(assets, 'cagra.png'), 'png', 'utf8');
  await writeFile(join(assets, 'cagra.svg'), svg, 'utf8');
  return { dir, markdownPath };
}

async function writeTrackedWhiteboardReceipt(input: {
  cwd: string;
  markdown: string;
  remoteMarkdown: string;
  svgHash: string;
  remoteRaw: unknown;
}): Promise<void> {
  const target = { kind: 'docx' as const, token: 'doc_token' };
  const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: input.cwd, target, markdown: input.markdown });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: input.cwd,
    target,
    document: { nodes: [{
      kind: 'asset',
      locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
      representation: 'whiteboard',
      remoteBlockId: 'wb_block',
      remoteToken: 'wb_token'
    }] }
  });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(input.markdown),
      publishDraftHash: hashText(input.markdown),
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [{
        assetKey: 'assets/cagra.png',
        pngPath: 'assets/cagra.png',
        svgPath: 'assets/cagra.svg',
        svgHash: input.svgHash,
        whiteboardToken: 'wb_token',
        blockId: 'wb_block',
        remoteStateHash: whiteboardRemoteStateHash(input.remoteRaw),
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-13T00:00:00.000Z'
    }
  });
}

function textBlock(blockId: string, text: string): { block_id: string; block_type: number; text: { elements: Array<{ text_run: { content: string; text_element_style: Record<string, never> } }> } } {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: {} } }]
    }
  };
}

function codeBlock(blockId: string, content: string, language?: number) {
  return {
    block_id: blockId,
    block_type: 14,
    code: {
      elements: [{ text_run: { content, text_element_style: {} } }],
      style: language === undefined ? {} : { language }
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
    fetchDocBlocks: async () => ({
      blocks: written ? blocksForMarkdown(input.afterMarkdown, input.blocks) : input.blocks
    }),
    replaceDocument: async () => {},
    replaceBlock: async ({ blockId, content }) => {
      calls.push(`replace:${blockId}:${content}`);
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

function blocksForMarkdown(markdown: string, previous: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks']) {
  const page = previous.find((block) => block.block_type === 1);
  const parsed = markdownToFeishuBlocks(markdown);
  const body = parsed[0]?.block_type === 3 ? parsed.slice(1) : parsed;
  const withIds = body.map((block, index) => ({ ...block, block_id: `after-${index}` }));
  return [
    { ...(page ?? { block_id: 'page', block_type: 1 }), children: withIds.map((block) => block.block_id as string) },
    ...withIds
  ];
}

function htmlParameterTable(rows: Array<[string, string]>): string {
  return `<table>\n  <tr><th><p>Parameter</p></th><th><p>Description</p></th></tr>\n${rows.map(([key, description]) => {
    return `  <tr><td><p><code>${key}</code></p></td><td><p>${description}</p></td></tr>`;
  }).join('\n')}\n</table>`;
}

function tablePatchAdapter(input: {
  before: Array<[string, string]>;
  after: Array<[string, string]>;
}): FeishuAdapter & { calls: string[] } {
  let written = false;
  const calls: string[] = [];
  return {
    calls,
    fetchDocMarkdown: async () => ({
      markdown: markdownParameterTable(written ? input.after : input.before),
      revision: written ? 'after' : 'before'
    }),
    fetchDocBlocks: async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: [written ? 'table2' : 'table1'] },
      ...feishuTableBlocks(written ? input.after : input.before, written ? 'table2' : 'table1')
    ] }),
    replaceDocument: async () => {},
    replaceBlock: async ({ blockId, content, format }) => {
      calls.push(`replace:${blockId}:${format}:${content}`);
      written = true;
    },
    insertBlocksAfter: async () => {},
    deleteBlocks: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

function markdownParameterTable(rows: Array<[string, string]>): string {
  return `| Parameter | Description |\n|-|-|\n${rows.map(([key, description]) => `| \`${key}\` | ${description} |`).join('\n')}`;
}

function feishuTableBlocks(rows: Array<[string, string]>, tableId: string) {
  const values = [['Parameter', 'Description'] as [string, string], ...rows];
  const cellIds = values.flatMap((_, row) => [`${tableId}-c${row}-0`, `${tableId}-c${row}-1`]);
  const blocks: Array<Record<string, unknown>> = [{
    block_id: tableId,
    block_type: 31,
    table: { property: { row_size: values.length, column_size: 2 }, cells: cellIds }
  }];
  values.forEach(([first, second], row) => {
    [first, second].forEach((value, column) => {
      const cellId = `${tableId}-c${row}-${column}`;
      const textId = `${cellId}-p`;
      blocks.push({ block_id: cellId, block_type: 32, children: [textId] });
      blocks.push({
        block_id: textId,
        block_type: 2,
        text: {
          elements: [{ text_run: {
            content: value,
            text_element_style: column === 0 && row > 0 ? { inline_code: true } : {}
          } }]
        }
      });
    });
  });
  return blocks as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}
