import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../src/markdown/from-blocks.js';
import {
  hashText,
  readLocalBaseSnapshot,
  readPublishReceipt,
  writeLocalBaseSnapshot,
  writePublishReceipt
} from '../src/receipts/publish-receipt.js';
import { writeRemoteSemanticSnapshot } from '../src/receipts/semantic-snapshot.js';
import { runPublish, textCreatePlacementMatches } from '../src/publish/run-publish.js';
import { semanticHash } from '../src/semantic/normalize.js';
import { canonicalizeMarkdownSemantics } from '../src/semantic/markdown-equivalence.js';
import { remoteSemanticDocument } from '../src/semantic/remote-document.js';
import { whiteboardRemoteStateHash } from '../src/whiteboards/remote-state.js';

describe('runPublish', () => {
  it('checks text creation placement against cross-kind direct-child order', () => {
    const misplaced = [
      { block_id: 'doc', block_type: 1, children: ['p1', 'p2', 'code1'] },
      textBlock('p1', 'Before.'),
      textBlock('p2', 'After.'),
      codeBlock('code1', 'print(1)', 49)
    ];
    const placed = [
      { block_id: 'doc', block_type: 1, children: ['p1', 'code1', 'p2'] },
      textBlock('p1', 'Before.'),
      codeBlock('code1', 'print(1)', 49),
      textBlock('p2', 'After.')
    ];

    expect(textCreatePlacementMatches(misplaced, 'doc', 'p2', 'code1')).toBe(false);
    expect(textCreatePlacementMatches(placed, 'doc', 'p2', 'code1')).toBe(true);
  });

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

  it('plans an untracked Callout body update with both safety confirmations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-plan-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '<div class="alert note">\n\nLocal body.\n\n</div>', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '<div class="alert note">\n\nRemote body.\n\n</div>' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
          { block_id: 'callout1', block_type: 19, callout: { emoji_id: '📘' }, children: ['title1', 'body1'] },
          textBlock('title1', 'Notes'),
          textBlock('body1', 'Remote body.')
        ]
      }),
      replaceDocument: async () => {},
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

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({
      kind: 'callout-child-update',
      remoteBlockId: 'body1',
      desiredMarkdown: 'Local body.'
    }));
    expect(result.plan.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('requires both confirmations when adopting a matching untracked Callout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-plan-'));
    const markdownPath = join(dir, 'doc.md');
    const markdown = '<div class="alert note">\n\nMatching body.\n\n</div>';
    await writeFile(markdownPath, markdown, 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
          { block_id: 'callout1', block_type: 19, callout: { emoji_id: '📘' }, children: ['title1', 'body1'] },
          textBlock('title1', 'Notes'),
          textBlock('body1', 'Matching body.')
        ]
      }),
      replaceDocument: async () => {},
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
    expect(result.plan.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.safeToWrite).toBe(false);
  });

  it('plans creation of a new Callout after a stable text anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-plan-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, `Previous text.

<div class="alert warning">

New warning.

</div>

Next text.`, 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Previous text.\n\nNext text.' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['previous', 'next'] },
          textBlock('previous', 'Previous text.'),
          textBlock('next', 'Next text.')
        ]
      }),
      replaceDocument: async () => {},
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

    expect(result.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({
      kind: 'callout-create',
      insertAfterBlockId: 'previous',
      desiredCallout: expect.objectContaining({ calloutType: 'warning' })
    }));
  });

  it('accepts Feishu emoji aliases when verifying a managed Callout create', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-create-readback-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      '<div class="alert note" data-fms-callout-title="Billing">\n\nManaged body.\n\n</div>',
      'utf8'
    );
    let created = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: created
          ? '<div class="alert note" data-fms-callout-title="Billing">\n\nManaged body.\n\n</div>'
          : ''
      }),
      fetchDocBlocks: async () => ({
        blocks: created
          ? [
              { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
              {
                block_id: 'callout1',
                block_type: 19,
                callout: { emoji_id: 'blue_book', background_color: 2, border_color: 2 },
                children: ['title1', 'body1']
              },
              textBlock('title1', 'Billing'),
              textBlock('body1', 'Managed body.')
            ]
          : [{ block_id: 'doc_token', block_type: 1, children: [] }]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => { created = true; },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

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
    expect(created).toBe(true);
  });

  it('writes a Callout body update without replacing the container', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-write-'));
    const markdownPath = join(dir, 'doc.md');
    const local = '<div class="alert note">\n\nLocal body.\n\n</div>';
    await writeFile(markdownPath, local, 'utf8');
    let body = 'Remote body.';
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: `<div class="alert note">\n\n${body}\n\n</div>`
      }),
      fetchDocBlocks: async () => ({ blocks: calloutBlocks(body) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}:${content}`);
        body = content;
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

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
      confirmCollaborationRisk: true,
      adapter
    });

    expect(calls).toEqual(['replace:body1:Local body.']);
    expect(calloutBlocks(body).find((block) => block.block_type === 19)?.block_id).toBe('callout1');
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({ version: 4, resolvedDocumentId: 'doc_token' });
  });

  it('uses the tracked Callout type when the remote presentation title is customized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-custom-title-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = canonicalCallout(['Base body.']);
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, canonicalCallout(['Local body.']), 'utf8');
    await writeTrackedPureCalloutReceipt({ cwd: dir, target, base, bodies: ['Base body.'] });
    const title = 'Team convention';
    let body = 'Base body.';
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: `<callout emoji="📘">\n${title}\n${body}\n</callout>`
      }),
      fetchDocBlocks: async () => ({ blocks: calloutBlocks(body, title) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}:${content}`);
        body = content;
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target,
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(result.plan.remoteChanged).toBe(false);
    expect(calls).toEqual(['replace:body1:Local body.']);
    expect(calloutBlocks(body, title).find((block) => block.block_id === 'title1')).toEqual(
      textBlock('title1', title)
    );
    await expect(readPublishReceipt({ cwd: dir, target })).resolves.toMatchObject({
      version: 4,
      remoteSnapshotHash: hashText(canonicalCallout(['Local body.']))
    });
  });

  it('writes and verifies a tracked Zdoc-managed Callout title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-managed-title-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const managed = (title: string) =>
      `<div class="alert note" data-fms-callout-title="${title}">\n\nBody.\n\n</div>`;
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, managed('Costs'), 'utf8');
    await writeTrackedPureCalloutReceipt({
      cwd: dir,
      target,
      base: managed('Billing'),
      bodies: ['Body.'],
      title: 'Billing'
    });
    let title = 'Billing';
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: `<callout emoji="📘">\n${title}\nBody.\n</callout>`
      }),
      fetchDocBlocks: async () => ({ blocks: calloutBlocks('Body.', title) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}:${content}`);
        if (blockId === 'title1') title = content;
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPublish({
      cwd: dir,
      file: markdownPath,
      target,
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(calls).toEqual(['replace:title1:Costs']);
    expect(title).toBe('Costs');
  });

  it('creates a Callout with configured presentation through XML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-write-'));
    const markdownPath = join(dir, 'doc.md');
    const local = `Previous text.

<div class="alert note">

中文正文。

</div>`;
    await writeFile(markdownPath, local, 'utf8');
    let created = false;
    let insertedXml = '';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: created ? local : 'Previous text.' }),
      fetchDocBlocks: async () => ({
        blocks: created
          ? [
            { block_id: 'doc_token', block_type: 1, children: ['previous', 'callout1'] },
            textBlock('previous', 'Previous text.'),
            ...calloutBlocks('中文正文。', '说明').slice(1)
          ]
          : [
            { block_id: 'doc_token', block_type: 1, children: ['previous'] },
            textBlock('previous', 'Previous text.')
          ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async ({ content, format }) => {
        insertedXml = content;
        expect(format).toBe('xml');
        created = true;
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

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
      callouts: { noteTitle: '说明', warningTitle: '警告' },
      adapter
    });

    expect(insertedXml).toContain('<callout emoji="📘" background-color="light-orange" border-color="orange">');
    expect(insertedXml).toContain('<p>说明</p><p>中文正文。</p>');
  });

  it('executes destructive Callout deletion after text updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-order-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = 'Old text.\n\n<div class="alert note">\n\nBody.\n\n</div>';
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'New text.', 'utf8');
    await writeTrackedCalloutReceipt({ cwd: dir, target, localBase: base, remoteMarkdown: base });
    let text = 'Old text.';
    let calloutPresent = true;
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: calloutPresent
          ? `${text}\n\n<div class="alert note">\n\nBody.\n\n</div>`
          : text
      }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: calloutPresent ? ['p1', 'callout1'] : ['p1'] },
          textBlock('p1', text),
          ...(calloutPresent ? calloutBlocks('Body.').slice(1) : [])
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}`);
        text = content;
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async ({ blockIds }) => {
        calls.push(`delete:${blockIds.join(',')}`);
        calloutPresent = false;
      },
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPublish({
      cwd: dir,
      file: markdownPath,
      target,
      profile: 'none',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(calls).toEqual(['replace:p1', 'delete:callout1']);
  });

  it('reports pending Callout writes and replans from partial remote state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-callout-partial-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const baseBodies = ['A', 'B', 'C'];
    const desiredBodies = ['A2', 'B2', 'C2'];
    const base = canonicalCallout(baseBodies);
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, canonicalCallout(desiredBodies), 'utf8');
    await writeTrackedPureCalloutReceipt({ cwd: dir, target, base, bodies: baseBodies });
    const remoteBodies = [...baseBodies];
    let failSecond = true;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: canonicalCallout(remoteBodies) }),
      fetchDocBlocks: async () => ({ blocks: calloutBlocks(remoteBodies) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        const index = Number(blockId.replace('body', '')) - 1;
        if (index === 1 && failSecond) {
          failSecond = false;
          throw new Error('network failed');
        }
        remoteBodies[index] = content;
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
        target,
        profile: 'none',
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmCollaborationRisk: true,
        adapter
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'callout-child-update' })],
      failedOperation: expect.objectContaining({ kind: 'callout-child-update' }),
      pendingOperations: [expect.objectContaining({ kind: 'callout-child-update' })],
      receiptWritten: false
    });
    expect(remoteBodies).toEqual(['A2', 'B', 'C']);

    const retryPlan = await runPublish({
      cwd: dir,
      file: markdownPath,
      target,
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(retryPlan.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'callout-child-update', childOrdinal: 1 }),
      expect.objectContaining({ kind: 'callout-child-update', childOrdinal: 2 })
    ]);
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

  it('writes a Code block body update through caption-preserving XML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '```python\nprint("new")\n```', 'utf8');
    let updated = false;
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: updated ? '```python\nprint("new")\n```' : '```python\nprint("old")\n```' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['code1'] },
          {
            ...codeBlock('code1', updated ? 'print("new")' : 'print("old")', 49),
            code: {
              ...(codeBlock('code1', '', 49).code as object),
              elements: [{ text_run: { content: updated ? 'print("new")' : 'print("old")', text_element_style: {} } }],
              style: { language: 49, caption: 'Example' }
            }
          }
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content, format }) => {
        calls.push(`replace:${blockId}:${format}:${content}`);
        updated = true;
      },
      insertBlocksAfter: async () => {},
      moveBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

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
      confirmCollaborationRisk: true,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(calls).toEqual([
      'replace:code1:xml:<pre lang="python" caption="Example"><code>print("new")</code></pre>'
    ]);
  });

  it('reports a partial write when the first Code mutation fails readback verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-code-readback-partial-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '```python\nprint("new")\n```', 'utf8');
    let writes = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: writes ? '```python\nprint("new")\n```' : '```python\nprint("old")\n```' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['code1'] },
        codeBlock('code1', 'print("old")', 49)
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => { writes += 1; },
      insertBlocksAfter: async () => {},
      moveBlocksAfter: async () => {},
      deleteBlocks: async () => {}
    };

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
      confirmCollaborationRisk: true,
      adapter
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'code-update' })],
      failedOperation: expect.objectContaining({ kind: 'code-readback' }),
      receiptWritten: false
    });
  });

  it('plans a language repair when the remote Code language is missing', async () => {
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

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({ kind: 'code-update' }));
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
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

  it('creates Procedures tokens without rewriting ordinary text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-procedures-create-'));
    const markdownPath = join(dir, 'doc.md');
    const local = 'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.';
    await writeFile(markdownPath, local, 'utf8');
    const order = ['intro', 'step', 'after'];
    const content = new Map([
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: order.map((id) => content.get(id)).join('\n\n') }),
      fetchDocBlocks: async () => ({ blocks: proceduresBlocks(order, content) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId }) => { calls.push(`replace:${blockId}`); },
      insertBlocksAfter: async ({ blockId, content: rendered }) => {
        const token = rendered === '<p>&lt;Procedures&gt;</p>'
          ? '<Procedures>'
          : '</Procedures>';
        const id = token === '<Procedures>' ? 'open' : 'close';
        content.set(id, token);
        order.splice(order.indexOf(blockId) + 1, 0, id);
        calls.push(`insert:${id}:after:${blockId}`);
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(calls).toEqual([
      'insert:open:after:intro',
      'insert:close:after:step'
    ]);
    expect(order).toEqual(['intro', 'open', 'step', 'close', 'after']);
    expect(result.plan.zdocRoundTrip).toMatchObject({ safeToPublish: true });
    expect(result.plan.zdocRoundTrip?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'procedures-create' })
    ]));
  });

  it('writes Procedures tokens as escaped XML text instead of Markdown tags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-procedures-xml-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const order = ['intro', 'step', 'after'];
    const content = new Map([
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: order.map((id) => content.get(id)).join('\n\n') }),
      fetchDocBlocks: async () => ({ blocks: proceduresBlocks(order, content) }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async ({ blockId, content: rendered, format }) => {
        const token = rendered === '<p>&lt;Procedures&gt;</p>'
          ? '<Procedures>'
          : rendered === '<p>&lt;/Procedures&gt;</p>'
            ? '</Procedures>'
            : undefined;
        if (format !== 'xml' || !token) return;
        const id = token === '<Procedures>' ? 'open' : 'close';
        content.set(id, token);
        order.splice(order.indexOf(blockId) + 1, 0, id);
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(order).toEqual(['intro', 'open', 'step', 'close', 'after']);
  });

  it('reports Procedures mutation readback failure as a partial write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-procedures-readback-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const order = ['intro', 'step', 'after'];
    const content = new Map([
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    let writes = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: order.map((id) => content.get(id)).join('\n\n') }),
      fetchDocBlocks: async () => ({ blocks: proceduresBlocks(order, content) }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => { writes += 1; },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'authoring-token-create' })],
      failedOperation: expect.objectContaining({ kind: 'authoring-token-readback' }),
      pendingOperations: [expect.objectContaining({ kind: 'authoring-token-create' })],
      receiptWritten: false
    });
    expect(writes).toBe(1);
  });

  it('moves a Procedures token and preserves its block identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-procedures-move-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const order = ['open', 'intro', 'step', 'close', 'after'];
    const content = new Map([
      ['open', '<Procedures>'],
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['close', '</Procedures>'],
      ['after', 'After.']
    ]);
    const moves: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: order.map((id) => content.get(id)).join('\n\n') }),
      fetchDocBlocks: async () => ({ blocks: proceduresBlocks(order, content) }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      moveBlocksAfter: async ({ blockId, sourceBlockIds }) => {
        const source = sourceBlockIds[0]!;
        order.splice(order.indexOf(source), 1);
        order.splice(order.indexOf(blockId) + 1, 0, source);
        moves.push(`${source}:after:${blockId}`);
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(moves).toEqual(['open:after:intro']);
    expect(order).toEqual(['intro', 'open', 'step', 'close', 'after']);
  });

  it('adopts a unique Supademo resource without rewriting it and records receipt V5', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-supademo-adopt-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      '# Demo\n\n<Supademo id="demo-id" title="" />\n\nAfter.',
      'utf8'
    );
    let writes = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '# Demo\n\n<readonly-block type="isv"></readonly-block>\n\nAfter.'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['isv1', 'after'] },
        {
          block_id: 'isv1',
          block_type: 40,
          add_ons: {
            component_type_id: 'blk_682093ba9580c002363b9dc3',
            record: '{"id":"demo-id","isShowcase":false}'
          }
        },
        textBlock('after', 'After.')
      ] }),
      replaceDocument: async () => { writes += 1; },
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.plan.strategy).toBe('no-op');
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'supademo-adopt',
      remoteBlockId: 'isv1'
    }));
    expect(writes).toBe(0);
    await expect(readPublishReceipt({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      version: 5,
      protectedResources: [expect.objectContaining({
        componentId: 'demo-id',
        blockId: 'isv1'
      })]
    });

    const rerun = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });
    expect(rerun.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'supademo-protected',
      remoteBlockId: 'isv1'
    }));

    await writeFile(markdownPath, '# Demo\n\nAfter.', 'utf8');
    const removal = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });
    expect(removal.plan.zdocRoundTrip).toMatchObject({ safeToPublish: false });
    expect(removal.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'supademo-removed',
      severity: 'blocker'
    }));
    await expect(readPublishReceipt({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      version: 5,
      protectedResources: [expect.objectContaining({ componentId: 'demo-id' })]
    });
  });

  it('plans revision 790 as Procedures creates plus Supademo adoption only', async () => {
    const remote = await incidentCreateSection('revision-790.md');
    const local = canonicalIncidentCreateSection(remote);
    const dir = await mkdtemp(join(tmpdir(), 'fms-revision-790-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, local, 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: remote }),
      fetchDocBlocks: async () => ({ blocks: incidentSectionBlocks(remote) }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'authoring-token-create', token: '<Procedures>' }),
      expect.objectContaining({ kind: 'authoring-token-create', token: '</Procedures>' })
    ]);
    expect(result.plan.zdocRoundTrip).toMatchObject({ safeToPublish: true });
    expect(result.plan.zdocRoundTrip?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'supademo-adopt' }),
      expect.objectContaining({ code: 'procedures-create' })
    ]));
  });

  it('plans revision 799 as one canonical opening-token move', async () => {
    const remote = await incidentCreateSection('revision-799.md');
    const local = canonicalIncidentCreateSection(
      await incidentCreateSection('revision-790.md')
    );
    const dir = await mkdtemp(join(tmpdir(), 'fms-revision-799-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, local, 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: remote }),
      fetchDocBlocks: async () => ({ blocks: incidentSectionBlocks(remote) }),
      replaceDocument: async () => {},
      moveBlocksAfter: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({
        kind: 'authoring-token-move',
        token: '<Procedures>'
      })
    ]);
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'procedures-move'
    }));
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

  it('replaces only a matched HTML table and records a version 4 receipt', async () => {
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
      version: 4,
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

  it('reports required Procedures token creation during Zdoc create dry-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-create-dry-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '' }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.zdocRoundTrip?.items.filter((item) => {
      return item.code === 'procedures-create';
    })).toHaveLength(2);
    expect(result.plan.zdocRoundTrip?.items).not.toContainEqual(expect.objectContaining({
      code: 'procedures-preserved'
    }));
  });

  it('finishes Zdoc Callout and Procedures structures before recording a create receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-create-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, `# Showcase

## Native callout

<Admonition type="info" title="Billing">

Managed body.

</Admonition>

## Procedures

Intro.

<Procedures>

1. Step.

</Procedures>

After.`, 'utf8');
    const order = ['h1', 'callout-heading', 'procedures-heading', 'intro', 'step', 'after'];
    const text = new Map([
      ['h1', '# Showcase'],
      ['callout-heading', '## Native callout'],
      ['procedures-heading', '## Procedures'],
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    let calloutCreated = false;
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: `<title>Showcase</title>\n\n${order.map((id) => id === 'callout'
          ? '<div class="alert note" data-fms-callout-title="Billing">\n\nManaged body.\n\n</div>'
          : text.get(id)).filter(Boolean).join('\n\n')}`,
        revision: '2'
      }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_created', block_type: 1, children: [...order] },
          ...order.flatMap((id) => {
            if (id === 'callout') {
              return [
                {
                  block_id: 'callout',
                  block_type: 19,
                  callout: { emoji_id: 'blue_book', background_color: 2, border_color: 2 },
                  children: ['callout-title', 'callout-body']
                },
                textBlock('callout-title', 'Billing'),
                textBlock('callout-body', 'Managed body.')
              ];
            }
            const rendered = markdownToFeishuBlocks(text.get(id) ?? '')[0];
            return rendered ? [{ ...rendered, block_id: id }] : [];
          })
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async ({ blockId, content, format }) => {
        writes.push(`${format}:${content}`);
        let id: string | undefined;
        if (format === 'xml' && content.startsWith('<callout ')) {
          id = 'callout';
          calloutCreated = true;
        } else if (content === '<p>&lt;Procedures&gt;</p>') {
          id = 'open';
          text.set(id, '<Procedures>');
        } else if (content === '<p>&lt;/Procedures&gt;</p>') {
          id = 'close';
          text.set(id, '</Procedures>');
        }
        if (id) order.splice(order.indexOf(blockId) + 1, 0, id);
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created',
        revision: '1'
      })
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(calloutCreated).toBe(true);
    expect(order).toEqual([
      'h1',
      'callout-heading',
      'callout',
      'procedures-heading',
      'intro',
      'open',
      'step',
      'close',
      'after'
    ]);
    expect(writes).toEqual(expect.arrayContaining([
      expect.stringContaining('xml:<callout '),
      'xml:<p>&lt;Procedures&gt;</p>',
      'xml:<p>&lt;/Procedures&gt;</p>'
    ]));
    await expect(readPublishReceipt({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_created' }
    })).resolves.toMatchObject({ dialect: 'zdoc-authoring' });
  });

  it('reports the created document when Zdoc post-create planning fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-create-plan-failure-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, '# Showcase', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '<title>Showcase</title>\n\n# Showcase\n\nUnexpected remote paragraph.',
        revision: '2'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_created', block_type: 1, children: ['h1', 'unexpected'] },
        { ...markdownToFeishuBlocks('# Showcase')[0]!, block_id: 'h1' },
        textBlock('unexpected', 'Unexpected remote paragraph.')
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {},
      createDocument: async () => ({
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created',
        revision: '1'
      })
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      document: {
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created'
      },
      completedOperations: [expect.objectContaining({ kind: 'document-create' })],
      failedOperation: expect.objectContaining({ kind: 'created-document-planning' }),
      receiptWritten: false
    });
    await expect(readPublishReceipt({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_created' }
    })).resolves.toBeUndefined();
  });

  it('reports the created document when a Zdoc post-create mutation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-create-mutation-failure-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      '# Showcase\n\nIntro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const order = ['h1', 'intro', 'step', 'after'];
    const content = new Map([
      ['h1', '# Showcase'],
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: `<title>Showcase</title>\n\n${order.map((id) => content.get(id)).join('\n\n')}`,
        revision: '2'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_created', block_type: 1, children: [...order] },
        ...order.flatMap((id) => {
          const rendered = markdownToFeishuBlocks(content.get(id) ?? '')[0];
          return rendered ? [{ ...rendered, block_id: id }] : [];
        })
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => { throw new Error('network failed'); },
      deleteBlocks: async () => {},
      createDocument: async () => ({
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created',
        revision: '1'
      })
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      document: { documentId: 'doc_created' },
      completedOperations: [expect.objectContaining({ kind: 'document-create' })],
      failedOperation: expect.objectContaining({ kind: 'authoring-token-create' }),
      pendingOperations: [expect.objectContaining({ kind: 'authoring-token-create' })],
      receiptWritten: false
    });
  });

  it('reports the created document when final Zdoc create readback regresses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-create-readback-failure-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(
      markdownPath,
      '# Showcase\n\nIntro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.',
      'utf8'
    );
    const order = ['h1', 'intro', 'step', 'after'];
    const content = new Map([
      ['h1', '# Showcase'],
      ['intro', 'Intro.'],
      ['step', '1. Step.'],
      ['after', 'After.']
    ]);
    let markdownFetches = 0;
    const visibleOrder = () => markdownFetches > 1
      ? order.filter((id) => id !== 'close')
      : order;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        markdownFetches += 1;
        return {
          markdown: `<title>Showcase</title>\n\n${visibleOrder().map((id) => content.get(id)).join('\n\n')}`,
          revision: String(markdownFetches + 1)
        };
      },
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_created', block_type: 1, children: [...visibleOrder()] },
        ...visibleOrder().flatMap((id) => {
          const rendered = markdownToFeishuBlocks(content.get(id) ?? '')[0];
          return rendered ? [{ ...rendered, block_id: id }] : [];
        })
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async ({ blockId, content: rendered }) => {
        const token = rendered === '<p>&lt;Procedures&gt;</p>'
          ? '<Procedures>'
          : '</Procedures>';
        const id = token === '<Procedures>' ? 'open' : 'close';
        content.set(id, token);
        order.splice(order.indexOf(blockId) + 1, 0, id);
      },
      deleteBlocks: async () => {},
      createDocument: async () => ({
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created',
        revision: '1'
      })
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'folder', token: 'folder-token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      document: { documentId: 'doc_created' },
      completedOperations: [
        expect.objectContaining({ kind: 'document-create' }),
        expect.objectContaining({ kind: 'authoring-token-create' }),
        expect.objectContaining({ kind: 'authoring-token-create' })
      ],
      failedOperation: expect.objectContaining({ kind: 'created-document-readback' }),
      receiptWritten: false
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
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('CAGRA') }),
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

  it('blocks untracked Whiteboard creation when adjacent text also changes', async () => {
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
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('CAGRA') }),
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
    expect(result.plan.whiteboards?.operations).toEqual([]);
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({ code: 'whiteboard-placement-mismatch' }));
    expect(result.plan.strategy).toBe('blocked');
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

  it('creates and verifies a Whiteboard before writing a version 4 receipt', async () => {
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
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('CAGRA') }),
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
        version: 4,
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
        return { raw: whiteboardTextRaw(this.created ? 'CAGRA' : 'missing') };
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
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let remoteRaw: unknown = whiteboardTextRaw('CAGRA v1');
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
        remoteRaw = whiteboardTextRaw('CAGRA v2');
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
        svgHash: hashText(updatedSvg),
        remoteStateHash: whiteboardRemoteStateHash(whiteboardTextRaw('CAGRA v1'))
      }).slice(0, 32)}`
    })]);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 4,
        whiteboards: [{ blockId: 'wb_block', whiteboardToken: 'wb_token' }]
      });
  });

  it('retries an applying Whiteboard readback without repeating the update', async () => {
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)');
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    let updated = false;
    let updates = 0;
    let postUpdateQueries = 0;
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
      queryWhiteboard: async () => {
        if (!updated) return { raw: whiteboardTextRaw('Existing') };
        postUpdateQueries += 1;
        if (postUpdateQueries <= 2) {
          throw new Error(JSON.stringify({
            ok: false,
            error: {
              code: 4003101,
              message: 'doc is applying doc data is not ready resource error whiteboard'
            }
          }));
        }
        return { raw: whiteboardTextRaw('CAGRA') };
      },
      updateWhiteboard: async () => {
        updates += 1;
        updated = true;
      },
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
    expect(updates).toBe(1);
    expect(postUpdateQueries).toBe(3);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 4,
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
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Different') }),
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

function whiteboardTextRaw(text: string): { nodes: Array<{ id: string; type: string; text: { text: string } }> } {
  return { nodes: [{ id: 'text-1', type: 'text_shape', text: { text } }] };
}

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

function proceduresBlocks(order: string[], content: Map<string, string>) {
  return [
    { block_id: 'doc_token', block_type: 1, children: [...order] },
    ...order.map((blockId) => blockId === 'step'
      ? {
          block_id: blockId,
          block_type: 13,
          ordered: {
            elements: [{ text_run: { content: 'Step.', text_element_style: {} } }]
          }
        }
      : textBlock(blockId, content.get(blockId) ?? ''))
  ];
}

async function incidentCreateSection(name: string): Promise<string> {
  const markdown = await readFile(new URL(
    `./fixtures/zdoc/model-providers/${name}`,
    import.meta.url
  ), 'utf8');
  const start = markdown.indexOf('## Create an integration in the Zilliz Cloud console');
  const end = markdown.indexOf('\n## Manage integrations', start);
  return `${markdown.slice(start, end).trim()}\n`;
}

function canonicalIncidentCreateSection(revision790: string): string {
  return revision790
    .replace(
      '<readonly-block type="isv"></readonly-block>',
      '<Supademo id="cmj9f3j6u0johf6zpk5kdyx3u" title="" />'
    )
    .replace(
      'To create a model provider integration:\n\n1. Log in',
      'To create a model provider integration:\n\n<Procedures>\n\n1. Log in'
    )
    .replace(
      '\n\nOnce created, the integration becomes available',
      '\n\n</Procedures>\n\nOnce created, the integration becomes available'
    );
}

function incidentSectionBlocks(markdown: string) {
  const blocks = markdownToFeishuBlocks(canonicalizeMarkdownSemantics(markdown)).map((block, index) => {
    const rendered = feishuBlocksToMarkdown([block]).trim();
    if (rendered === '<readonly-block type="isv"></readonly-block>') {
      return {
        block_id: 'XViWdTKb4ouwFJxEeepcSNQInLf',
        block_type: 40,
        add_ons: {
          component_type_id: 'blk_682093ba9580c002363b9dc3',
          record: '{"id":"cmj9f3j6u0johf6zpk5kdyx3u","isShowcase":false}'
        }
      };
    }
    const blockId = rendered === '<Procedures>'
      ? 'X4O9dWlMVoZXyrxdiFycqfc3nyf'
      : rendered === '</Procedures>'
        ? 'Qfrud6flEoIqN7xLDLEcMUcUn5c'
        : `incident-${index}`;
    return { ...block, block_id: blockId };
  });
  return [
    {
      block_id: 'doc_token',
      block_type: 1,
      children: blocks.map((block) => block.block_id)
    },
    ...blocks
  ];
}

function calloutBlocks(body: string | string[], title = 'Notes') {
  const bodies = Array.isArray(body) ? body : [body];
  const bodyIds = bodies.map((_, index) => `body${index + 1}`);
  return [
    { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
    { block_id: 'callout1', block_type: 19, callout: { emoji_id: '📘' }, children: ['title1', ...bodyIds] },
    textBlock('title1', title),
    ...bodies.map((value, index) => textBlock(`body${index + 1}`, value))
  ];
}

function canonicalCallout(bodies: string[]): string {
  return `<div class="alert note">\n\n${bodies.join('\n\n')}\n\n</div>`;
}

async function writeTrackedPureCalloutReceipt(input: {
  cwd: string;
  target: { kind: 'docx'; token: string };
  base: string;
  bodies: string[];
  title?: string;
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.base
  });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: input.cwd,
    target: input.target,
    document: remoteSemanticDocument(calloutBlocks(input.bodies, input.title), 'doc_token')
  });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 2,
      target: input.target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(input.base),
      publishDraftHash: hashText(input.base),
      remoteSnapshotHash: hashText(input.base),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      updatedAt: '2026-07-14T00:00:00.000Z'
    }
  });
}

async function writeTrackedCalloutReceipt(input: {
  cwd: string;
  target: { kind: 'docx'; token: string };
  localBase: string;
  remoteMarkdown: string;
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.localBase
  });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: input.cwd,
    target: input.target,
    document: remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['p1', 'callout1'] },
      textBlock('p1', 'Old text.'),
      ...calloutBlocks('Body.').slice(1)
    ], 'doc_token')
  });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 2,
      target: input.target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(input.localBase),
      publishDraftHash: hashText(input.localBase),
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      updatedAt: '2026-07-14T00:00:00.000Z'
    }
  });
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
    insertBlocksAfter: async ({ blockId, content }) => {
      calls.push(`insert-after:${blockId}:${content}`);
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
  const usedPreviousIds = new Set<string>();
  const withIds = body.map((block, index) => {
    const rendered = feishuBlocksToMarkdown([block]).trim();
    const preserved = previous.find((candidate) => {
      return candidate.block_id && !usedPreviousIds.has(candidate.block_id) &&
        candidate.block_type === block.block_type &&
        feishuBlocksToMarkdown([candidate]).trim() === rendered;
    });
    if (preserved?.block_id) usedPreviousIds.add(preserved.block_id);
    return { ...block, block_id: preserved?.block_id ?? `after-${index}` };
  });
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
