import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import type { FeishuBlock } from '../src/feishu/types.js';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { CliFailure } from '../src/core/cli-failure.js';
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
import { writePublishBaselineBundle } from '../src/receipts/publish-baseline-bundle.js';
import {
  applyScopedOperations,
  assertCheckpointHasNoUnrelatedChanges,
  codeReadbackMatches,
  runPublish,
  textCreatePlacementMatches
} from '../src/publish/run-publish.js';
import type { ScopedPatchOperation } from '../src/publish/scoped-patch-plan.js';
import { runStatus } from '../src/status/run-status.js';
import { runDiff } from '../src/diff/run-diff.js';
import { normalizeCliFailure } from '../src/core/cli-failure.js';
import { semanticHash } from '../src/semantic/normalize.js';
import { canonicalizeMarkdownSemantics } from '../src/semantic/markdown-equivalence.js';
import { remoteSemanticDocument } from '../src/semantic/remote-document.js';
import type { SemanticCallout, SemanticCodeBlock, SemanticDocument } from '../src/semantic/types.js';
import { whiteboardRemoteStateHash } from '../src/whiteboards/remote-state.js';

describe('runPublish', () => {
  it('requires replacement Code caption absence to match exactly', () => {
    const desired: SemanticCodeBlock = {
      kind: 'code',
      locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      content: 'print(1)',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      issues: []
    };

    expect(codeReadbackMatches({ ...desired, remoteBlockId: 'code-2' }, desired)).toBe(true);
    expect(codeReadbackMatches({ ...desired, caption: 'Unexpected', remoteBlockId: 'code-2' }, desired)).toBe(false);
  });

  it('treats a moved Code block as the same verified checkpoint scope', () => {
    const buildLocator = { sectionPath: ['Build'], kind: 'code' as const, ordinal: 0 };
    const searchLocator = { sectionPath: ['Search'], kind: 'code' as const, ordinal: 0 };
    const baselineCode: SemanticCodeBlock = {
      kind: 'code',
      locator: buildLocator,
      content: 'print(1)\n',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      remoteBlockId: 'code-1',
      issues: []
    };
    const currentCode: SemanticCodeBlock = { ...baselineCode, locator: searchLocator };
    const stationaryCode: SemanticCodeBlock = {
      ...baselineCode,
      locator: searchLocator,
      content: 'print(2)\n',
      remoteBlockId: 'code-2'
    };
    const shiftedStationaryCode: SemanticCodeBlock = {
      ...stationaryCode,
      locator: { ...searchLocator, ordinal: 1 }
    };
    const stableText = {
      kind: 'text' as const,
      locator: { sectionPath: [], kind: 'text' as const, ordinal: 0 },
      blockType: 2,
      markdown: 'Stable.',
      remoteBlockId: 'p1'
    };
    const baseline: SemanticDocument = { nodes: [baselineCode, stationaryCode, stableText] };
    const current: SemanticDocument = { nodes: [currentCode, shiftedStationaryCode, stableText] };
    const operation: Extract<ScopedPatchOperation, { kind: 'code-move' }> = {
      kind: 'code-move',
      locator: searchLocator,
      sourceLocator: buildLocator,
      remoteBlockId: 'code-1',
      desiredCode: currentCode
    };

    expect(() => assertCheckpointHasNoUnrelatedChanges(baseline, current, [operation])).not.toThrow();
    expect(() => assertCheckpointHasNoUnrelatedChanges(baseline, {
      nodes: [
        currentCode,
        { ...shiftedStationaryCode, content: 'print("teammate")\n' },
        stableText
      ]
    }, [operation])).toThrow('Remote changed outside the verified partial-write scopes');
  });

  it('normalizes remaining Callout ordinals after a verified Callout delete', () => {
    const note: SemanticCallout = {
      kind: 'callout',
      locator: { sectionPath: [], kind: 'callout', ordinal: 0 },
      calloutType: 'note',
      children: [{ ordinal: 0, blockType: 2, markdown: 'Note.', remoteBlockId: 'note-child' }],
      remoteBlockId: 'note'
    };
    const warning: SemanticCallout = {
      kind: 'callout',
      locator: { sectionPath: [], kind: 'callout', ordinal: 1 },
      calloutType: 'warning',
      children: [{ ordinal: 0, blockType: 2, markdown: 'Warning.', remoteBlockId: 'warning-child' }],
      remoteBlockId: 'warning'
    };
    const remaining = {
      ...warning,
      locator: { ...warning.locator, ordinal: 0 }
    };
    const operation: Extract<ScopedPatchOperation, { kind: 'callout-delete' }> = {
      kind: 'callout-delete',
      locator: note.locator,
      blockIds: ['note']
    };

    expect(() => assertCheckpointHasNoUnrelatedChanges(
      { nodes: [note, warning] },
      { nodes: [remaining] },
      [operation]
    )).not.toThrow();
    expect(() => assertCheckpointHasNoUnrelatedChanges(
      { nodes: [note, warning] },
      { nodes: [{
        ...remaining,
        children: [{ ...remaining.children[0]!, markdown: 'Teammate changed warning.' }]
      }] },
      [operation]
    )).toThrow('Remote changed outside the verified partial-write scopes');
  });

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
      parentBlockId: 'page',
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

  it('re-resolves a create anchor after an earlier update replaces its block ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-create-anchor-refresh-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = 'First.\n\nOld anchor.';
    const desired = 'First.\n\nUpdated anchor.\n\nNew tail.';
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    const localBaseSnapshot = await writeLocalBaseSnapshot({
      cwd: dir,
      target,
      markdown: base
    });
    const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
      cwd: dir,
      target,
      document: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['first', 'anchor-old'] },
        textBlock('first', 'First.'),
        textBlock('anchor-old', 'Old anchor.')
      ], 'doc_token')
    });
    await writePublishReceipt({
      cwd: dir,
      receipt: {
        version: 3,
        target,
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(base),
        remoteRevision: '1',
        localBaseSnapshot,
        remoteSemanticSnapshot,
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });

    let anchorId = 'anchor-old';
    let anchorUpdated = false;
    let tailCreated = false;
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: tailCreated
          ? desired
          : anchorUpdated
            ? 'First.\n\nUpdated anchor.'
            : base,
        revision: tailCreated ? '3' : anchorUpdated ? '2' : '1'
      }),
      fetchDocBlocks: async () => ({
        blocks: [
          {
            block_id: 'doc_token',
            block_type: 1,
            children: ['first', anchorId, ...(tailCreated ? ['tail'] : [])]
          },
          textBlock('first', 'First.'),
          textBlock(anchorId, anchorUpdated ? 'Updated anchor.' : 'Old anchor.'),
          ...(tailCreated ? [textBlock('tail', 'New tail.')] : [])
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId }) => {
        calls.push(`replace:${blockId}`);
        anchorUpdated = true;
        anchorId = 'anchor-new';
      },
      insertBlocksAfter: async ({ blockId }) => {
        calls.push(`insert:${blockId}`);
        if (blockId !== anchorId) throw new Error(`stale create anchor: ${blockId}`);
        tailCreated = true;
      },
      deleteBlocks: async () => {}
    };

    await expect(runPublish({
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
    })).resolves.toMatchObject({ mode: 'write' });

    expect(calls).toEqual(['replace:anchor-old', 'insert:anchor-new']);
  });

  it('checkpoints ten verified writes so a 16-operation publish replans only the remaining six', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-partial-checkpoint-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const baseParagraphs = Array.from({ length: 9 }, (_, index) => `Old paragraph ${index + 1}.`);
    const desiredParagraphs = Array.from({ length: 9 }, (_, index) => `Updated paragraph ${index + 1}.`);
    const tableKeys = ['alpha', 'beta', 'gamma', 'delta'];
    const base = partialCheckpointMarkdown({
      paragraphs: baseParagraphs,
      calloutBody: 'Old Callout body.',
      includeNewTail: false,
      includeNewCallout: false,
      updatedTables: new Set()
    });
    const desired = partialCheckpointMarkdown({
      paragraphs: desiredParagraphs,
      calloutBody: 'Updated Callout body.',
      includeNewTail: true,
      includeNewCallout: true,
      updatedTables: new Set(tableKeys)
    });
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    const initialBlocks = partialCheckpointBlocks({
      paragraphs: baseParagraphs,
      paragraphIds: baseParagraphs.map((_, index) => `p${index + 1}`),
      calloutBody: 'Old Callout body.',
      calloutBodyId: 'callout-body',
      includeNewTail: false,
      includeNewCallout: false,
      updatedTables: new Set()
    });
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument(initialBlocks, 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(base),
        remoteRevision: '1',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });

    const paragraphs = [...baseParagraphs];
    const paragraphIds = baseParagraphs.map((_, index) => `p${index + 1}`);
    let calloutBody = 'Old Callout body.';
    let calloutBodyId = 'callout-body';
    const updatedTables = new Set<string>();
    let revision = 1;
    let failCreate = true;
    let checkpointApplyingReads = 1;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        if (revision > 1 && checkpointApplyingReads > 0) {
          checkpointApplyingReads -= 1;
          throw new CliFailure({
            type: 'internal',
            subtype: 'unknown',
            message: 'An error occurred during processing. Check the input and retry',
            retryable: false,
            providerCode: 12330102
          });
        }
        return {
          markdown: partialCheckpointMarkdown({
            paragraphs,
            calloutBody,
            includeNewTail: false,
            includeNewCallout: false,
            updatedTables
          }),
          revision: String(revision)
        };
      },
      fetchDocBlocks: async () => ({
        blocks: partialCheckpointBlocks({
          paragraphs,
          paragraphIds,
          calloutBody,
          calloutBodyId,
          includeNewTail: false,
          includeNewCallout: false,
          updatedTables
        })
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content, format }) => {
        if (format === 'xml') {
          const key = tableKeys.find((candidate) => blockId === `table-${candidate}`);
          if (!key) throw new Error(`unexpected table block: ${blockId}`);
          updatedTables.add(key);
          revision += 1;
          return;
        }
        const paragraphIndex = paragraphIds.indexOf(blockId);
        if (paragraphIndex >= 0) {
          paragraphs[paragraphIndex] = content;
          paragraphIds[paragraphIndex] = `${blockId}-new`;
          revision += 1;
          return;
        }
        if (blockId === calloutBodyId) {
          calloutBody = content;
          calloutBodyId = `${blockId}-new`;
          revision += 1;
          return;
        }
        throw new Error(`unexpected replace block: ${blockId}`);
      },
      insertBlocksAfter: async ({ blockId }) => {
        expect(blockId).toBe(paragraphIds[8]);
        if (failCreate) throw new Error('simulated create failure');
      },
      deleteBlocks: async () => {}
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
      completedOperations: expect.arrayContaining([
        ...Array.from({ length: 9 }, () => expect.objectContaining({ kind: 'update' })),
        expect.objectContaining({ kind: 'callout-child-update' })
      ]),
      failedOperation: expect.objectContaining({ kind: 'create' }),
      recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '11'
    });
    expect(revision).toBe(11);
    expect(checkpointApplyingReads).toBe(0);
    const checkpoint = await readPublishReceipt({ cwd: dir, target });
    expect(checkpoint).toMatchObject({
      version: 4,
      localSourceHash: hashText(base),
      publishDraftHash: hashText(base),
      remoteRevision: '11',
      partialWriteCheckpoint: {
        completedOperations: expect.arrayContaining([
          ...Array.from({ length: 9 }, () => expect.objectContaining({ kind: 'update' })),
          expect.objectContaining({ kind: 'callout-child-update' })
        ])
      }
    });

    const status = await runStatus({
      cwd: dir,
      sourcePath: markdownPath,
      target,
      profile: 'none',
      dialect: 'gfm',
      adapter
    });
    expect(status).toMatchObject({
      state: 'local-changed',
      localChanged: true,
      remoteChanged: false,
      partialWriteCheckpoint: { remoteRevision: '11' }
    });

    const diff = await runDiff({
      cwd: dir,
      sourcePath: markdownPath,
      target,
      profile: 'none',
      dialect: 'gfm',
      adapter
    });
    expect([
      ...diff.scoped.text.map((operation) => operation.kind),
      ...diff.scoped.callouts.map((operation) => operation.action),
      ...diff.scoped.tables.map(() => 'table-replace')
    ]).toEqual([
      'create',
      'create',
      'table-replace',
      'table-replace',
      'table-replace',
      'table-replace'
    ]);

    failCreate = false;
    const retry = await runPublish({
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
    expect(retry.plan.remoteChanged).toBe(false);
    expect(retry.plan.scopedPatch?.operations.map((operation) => operation.kind)).toEqual([
      'create',
      'callout-create',
      'table-replace',
      'table-replace',
      'table-replace',
      'table-replace'
    ]);
  });

  it('does not recreate tracked text and Callout additions that already reached the remote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-applied-additions-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = 'Anchor.';
    const desired = 'Anchor.\n\nNew tail.\n\n<div class="alert warning">\n\nNew warning.\n\n</div>';
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['anchor'] },
        textBlock('anchor', 'Anchor.')
      ], 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(base),
        remoteRevision: '1',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: desired, revision: '3' }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['anchor', 'tail', 'warning'] },
        textBlock('anchor', 'Anchor.'),
        textBlock('tail', 'New tail.'),
        {
          block_id: 'warning',
          block_type: 19,
          callout: { emoji_id: '❗' },
          children: ['warning-title', 'warning-body']
        },
        textBlock('warning-title', 'Warning'),
        textBlock('warning-body', 'New warning.')
      ] }),
      replaceDocument: async () => {}
    };

    const result = await runPublish({
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

    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.scopedPatch?.operations).toEqual([]);
  });

  it('refuses to checkpoint when an unrelated remote scope changes during the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-checkpoint-drift-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = 'A.\n\nB.';
    const desired = 'A2.\n\nB.';
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['a', 'b'] },
        textBlock('a', 'A.'),
        textBlock('b', 'B.')
      ], 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(base),
        remoteRevision: '1',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });
    let written = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: written ? 'A2.\n\nRemote collaborator changed B.' : base,
        revision: written ? '3' : '1'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: [written ? 'a-new' : 'a', 'b'] },
        textBlock(written ? 'a-new' : 'a', written ? 'A2.' : 'A.'),
        textBlock('b', written ? 'Remote collaborator changed B.' : 'B.')
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => { written = true; },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {}
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
      failedOperation: { kind: 'receipt-write' },
      recoveryCheckpointWritten: false
    });
    expect(normalizeCliFailure(thrown).details.partialWrite)
      .not.toHaveProperty('recoveryCheckpointRevision');
    const receipt = await readPublishReceipt({ cwd: dir, target });
    expect(receipt).toMatchObject({ remoteRevision: '1' });
    expect(receipt && 'partialWriteCheckpoint' in receipt).toBe(false);
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
      parentBlockId: 'doc_token',
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
      parentBlockId: 'doc_token',
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

  it('accepts a text replacement with a new block ID when the exact parent slot and content match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-text-replace-id-'));
    const markdownPath = join(dir, 'doc.md');
    const beforeMarkdown = 'Before.\n\nOld paragraph.\n\nAfter.';
    const afterMarkdown = 'Before.\n\nNew paragraph.\n\nAfter.';
    await writeFile(markdownPath, afterMarkdown, 'utf8');
    let written = false;
    const calls: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: written ? afterMarkdown : beforeMarkdown }),
      fetchDocBlocks: async () => ({
        blocks: written
          ? [
              { block_id: 'page', block_type: 1, children: ['before', 'replacement', 'after'] },
              textBlock('before', 'Before.'),
              textBlock('replacement', 'New paragraph.'),
              textBlock('after', 'After.')
            ]
          : [
              { block_id: 'page', block_type: 1, children: ['before', 'original', 'after'] },
              textBlock('before', 'Before.'),
              textBlock('original', 'Old paragraph.'),
              textBlock('after', 'After.')
            ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}:${content}`);
        written = true;
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
      confirmCollaborationRisk: true,
      confirmUntrackedRemote: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(calls).toEqual(['replace:original:New paragraph.']);
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

  it('accepts a replacement Code block ID at the same locator without repeating the verified mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-code-replacement-id-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const base = '```python\nprint("old")\n```';
    const local = '```python\nprint("local")\n```';
    const remote = '```go\nprint("old")\n```';
    const merged = '```go\nprint("local")\n```';
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, local, 'utf8');
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['code1'] },
        codeBlock('code1', 'print("old")', 49)
      ], 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(base),
        remoteRevision: '1',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });
    let mutated = false;
    let mutationCount = 0;
    let metadataFetches = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: mutated ? merged : remote,
        revision: mutated ? '3' : '2'
      }),
      fetchDocBlocks: async () => {
        return { blocks: [
          { block_id: 'doc_token', block_type: 1, children: [mutated ? 'code2' : 'code1'] },
          {
            block_id: mutated ? 'code2' : 'code1',
            block_type: 14,
            code: {
              elements: [{ text_run: {
                content: mutated ? 'print("local")' : 'print("old")',
                text_element_style: {}
              } }],
              style: { language: 'go' }
            }
          }
        ] };
      },
      fetchDocCodeMetadata: async () => {
        metadataFetches += 1;
        return [{ blockId: 'code1', language: mutated ? 'python' : 'go' }];
      },
      replaceDocument: async () => {},
      replaceBlock: async ({ content, format }) => {
        expect(format).toBe('xml');
        expect(content).toBe('<pre lang="go"><code>print("local")</code></pre>');
        mutationCount += 1;
        mutated = true;
        return { revision: '3' };
      },
      insertBlocksAfter: async () => {},
      moveBlocksAfter: async () => {},
      deleteBlocks: async () => {}
    };

    await expect(runPublish({
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
    })).resolves.toMatchObject({ mode: 'write' });

    expect(mutationCount).toBe(1);
    expect(metadataFetches).toBe(0);
  });

  it('carries a replacement Code block ID into a later move and its checkpoint', async () => {
    const state = codeReconcileState([
      headingBlock('build', 'Build'),
      codeBlock('code-1', 'print("old")', 49),
      headingBlock('search', 'Search'),
      textBlock('anchor', 'Anchor.')
    ]);
    const desiredCode: SemanticCodeBlock = {
      kind: 'code',
      locator: { sectionPath: ['Search'], kind: 'code', ordinal: 0 },
      content: 'print("new")',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      remoteBlockId: 'code-1',
      issues: []
    };
    const update: Extract<ScopedPatchOperation, { kind: 'code-update' }> = {
      kind: 'code-update',
      locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      sourceLocator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      remoteBlockId: 'code-1',
      desiredCode: { ...desiredCode, locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 } }
    };
    const move: Extract<ScopedPatchOperation, { kind: 'code-move' }> = {
      kind: 'code-move',
      locator: desiredCode.locator,
      sourceLocator: update.sourceLocator,
      afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 1 },
      remoteBlockId: 'code-1',
      desiredCode
    };
    let checkpointCalls = 0;
    const adapter = codeReconcileAdapter(state, {
      replaceBlock: async ({ blockId }) => {
        expect(blockId).toBe('code-1');
        state.replace(blockId, codeBlock('code-2', 'print("new")', 49));
      },
      moveBlocksAfter: async ({ blockId, sourceBlockIds }) => {
        expect(sourceBlockIds).toEqual(['code-2']);
        state.moveAfter(blockId, sourceBlockIds);
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [update, move],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' },
      recordCheckpoint: async (_completed, verified) => {
        checkpointCalls += 1;
        expect(verified.every((operation) =>
          (operation.kind !== 'code-update' && operation.kind !== 'code-move') ||
          operation.remoteBlockId === 'code-2'
        )).toBe(true);
      }
    })).resolves.toHaveLength(2);

    expect(checkpointCalls).toBe(2);
  });

  it('fails closed when a Code move ID disappears even if its old locator is occupied', async () => {
    const state = codeReconcileState([
      headingBlock('build', 'Build'),
      codeBlock('unrelated-code', 'print("old")', 49),
      headingBlock('search', 'Search'),
      textBlock('anchor', 'Anchor.')
    ]);
    const desiredCode: SemanticCodeBlock = {
      kind: 'code',
      locator: { sectionPath: ['Search'], kind: 'code', ordinal: 0 },
      content: 'print("old")',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      remoteBlockId: 'missing-code',
      issues: []
    };
    const move: Extract<ScopedPatchOperation, { kind: 'code-move' }> = {
      kind: 'code-move',
      locator: desiredCode.locator,
      sourceLocator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 1 },
      remoteBlockId: 'missing-code',
      desiredCode
    };
    let moves = 0;
    const adapter = codeReconcileAdapter(state, {
      moveBlocksAfter: async ({ blockId, sourceBlockIds }) => {
        moves += 1;
        state.moveAfter(blockId, sourceBlockIds);
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [move],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).rejects.toThrow('Code move identity is no longer resolvable');

    expect(moves).toBe(0);
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

  it('preserves created Code reconcile IDs when engine readback fails', async () => {
    const state = codeReconcileState([
      headingBlock('build', 'Build'),
      codeBlock('old-code', 'old', 49),
      headingBlock('search', 'Search'),
      textBlock('anchor', 'Anchor.')
    ]);
    let inserted = false;
    let postInsertReads = 0;
    const adapter = codeReconcileAdapter(state, {
      fetchDocBlocks: async () => {
        if (inserted && ++postInsertReads === 2) {
          throw new CliFailure({
            type: 'network',
            subtype: 'provider_readback_failed',
            message: 'provider readback failed',
            retryable: true,
            providerCode: 429
          });
        }
        return { blocks: state.blocks() };
      },
      insertBlocksAfter: async ({ blockId }) => {
        state.insertAfter(blockId, codeBlock('created-code', 'new', 49));
        inserted = true;
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [codeReconcileOperation({
        desiredContent: 'new',
        desiredSection: 'Search',
        afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 1 },
        remoteCodes: [{ section: 'Build', content: 'old', blockId: 'old-code' }]
      })],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({
        kind: 'code-reconcile-create',
        blockIds: ['created-code']
      })],
      failedOperation: expect.objectContaining({ kind: 'code-readback' }),
      causeDetails: expect.objectContaining({
        type: 'network',
        retryable: true,
        providerCode: 429
      })
    });
  });

  it('carries a replacement Code ID into reconcile checkpoints', async () => {
    const state = codeReconcileState([
      headingBlock('search', 'Search'),
      textBlock('anchor', 'Anchor.'),
      codeBlock('code-1', 'old', 49)
    ]);
    let checkpointCalls = 0;
    const adapter = codeReconcileAdapter(state, {
      replaceBlock: async ({ blockId }) => {
        expect(blockId).toBe('code-1');
        state.replace(blockId, codeBlock('code-2', 'new', 49));
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [codeReconcileOperation({
        desiredContent: 'new',
        desiredSection: 'Search',
        afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 1 },
        remoteCodes: [{ section: 'Search', content: 'old', blockId: 'code-1' }]
      })],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' },
      recordCheckpoint: async (_completed, verified) => {
        checkpointCalls += 1;
        const last = verified.at(-1);
        if (last?.kind !== 'code-update') return;
        expect(last.remoteBlockId).toBe('code-2');
        expect(last.desiredCode.remoteBlockId).toBe('code-2');
      }
    })).resolves.toHaveLength(2);

    expect(checkpointCalls).toBe(2);
  });

  it('merges earlier top-level completions when a Code reconcile move fails', async () => {
    const state = codeReconcileState([
      headingBlock('search', 'Search'),
      codeBlock('code-1', 'old', 49),
      textBlock('anchor', 'Anchor.')
    ]);
    const earlier = { kind: 'update' as const, locator: { sectionPath: [], kind: 'text' as const, ordinal: 0 } };
    const pending = { kind: 'delete' as const, locator: { sectionPath: ['Later'], kind: 'text' as const, ordinal: 0 } };
    const adapter = codeReconcileAdapter(state, {
      replaceBlock: async ({ blockId }) => {
        state.replace(blockId, codeBlock(blockId, 'new', 49));
      },
      moveBlocksAfter: async () => {
        throw new CliFailure({
          type: 'network',
          subtype: 'move_failed',
          message: 'move failed',
          retryable: true
        });
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [codeReconcileOperation({
        desiredContent: 'new',
        desiredSection: 'Search',
        afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 1 },
        remoteCodes: [{ section: 'Search', content: 'old', blockId: 'code-1' }]
      })],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' },
      completedOperations: [earlier],
      pendingAfter: [pending],
      recoveryCheckpoint: { written: true, revision: '9' }
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [
        earlier,
        expect.objectContaining({ kind: 'code-reconcile-update' })
      ],
      failedOperation: expect.objectContaining({ kind: 'code-reconcile-move' }),
      pendingOperations: [pending],
      recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '9',
      causeDetails: expect.objectContaining({ type: 'network', retryable: true })
    });
  });

  it('preserves pending operations and checkpoint state when Code reconcile delete readback fails', async () => {
    const state = codeReconcileState([
      headingBlock('build', 'Build'),
      codeBlock('obsolete-code', 'old', 49),
      headingBlock('search', 'Search'),
      codeBlock('desired-code', 'new', 49)
    ]);
    let deleted = false;
    const pending = { kind: 'table-create' as const, locator: { sectionPath: ['Later'], kind: 'table' as const, ordinal: 0 } };
    const adapter = codeReconcileAdapter(state, {
      fetchDocBlocks: async () => {
        if (deleted) throw new Error('delete readback failed');
        return { blocks: state.blocks() };
      },
      deleteBlocks: async ({ blockIds }) => {
        state.delete(blockIds);
        deleted = true;
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [{
        ...codeReconcileOperation({
          desiredContent: 'new',
          desiredSection: 'Search',
          remoteCodes: [
            { section: 'Build', content: 'old', blockId: 'obsolete-code' },
            { section: 'Search', content: 'new', blockId: 'desired-code' }
          ]
        }),
        phase: 'delete'
      }],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' },
      completedOperations: [{ kind: 'update' }],
      pendingAfter: [pending],
      recoveryCheckpoint: { written: true, revision: '11' }
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [
        expect.objectContaining({ kind: 'update' }),
        expect.objectContaining({ kind: 'code-reconcile-delete' })
      ],
      failedOperation: expect.objectContaining({ kind: 'code-readback' }),
      pendingOperations: [pending],
      recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '11'
    });
  });

  it('reports a Code reconcile checkpoint failure as receipt-write', async () => {
    const state = codeReconcileState([
      headingBlock('search', 'Search'),
      textBlock('anchor', 'Anchor.'),
      codeBlock('code-1', 'old', 49)
    ]);
    const pending = { kind: 'delete' as const, locator: { sectionPath: ['Later'], kind: 'text' as const, ordinal: 0 } };
    const adapter = codeReconcileAdapter(state, {
      replaceBlock: async ({ blockId }) => {
        state.replace(blockId, codeBlock(blockId, 'new', 49));
      }
    });

    await expect(applyScopedOperations({
      adapter,
      doc: 'doc_token',
      operations: [codeReconcileOperation({
        desiredContent: 'new',
        desiredSection: 'Search',
        afterLocator: { sectionPath: ['Search'], kind: 'text', ordinal: 0 },
        remoteCodes: [{ section: 'Search', content: 'old', blockId: 'code-1' }]
      })],
      callouts: { noteTitle: 'Notes', warningTitle: 'Warning' },
      pendingAfter: [pending],
      recordCheckpoint: async () => { throw new Error('checkpoint failed'); },
      recoveryCheckpoint: { written: false, revision: '12' }
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'code-reconcile-update' })],
      failedOperation: { kind: 'receipt-write' },
      pendingOperations: [pending],
      recoveryCheckpointWritten: false,
      recoveryCheckpointRevision: '12'
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

  it('repairs a receipt-recorded flat list as a nested scoped create with parent-aware readback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-nested-list-repair-'));
    const markdownPath = join(dir, 'doc.md');
    const localMarkdown = nestedListMarkdown(true);
    const flatMarkdown = nestedListMarkdown(false);
    await writeFile(markdownPath, localMarkdown, 'utf8');
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: dir, target, markdown: localMarkdown });
    const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
      cwd: dir,
      target,
      document: remoteSemanticDocument(nestedListBlocks('flat'), 'doc_token')
    });
    await writePublishReceipt({
      cwd: dir,
      receipt: {
        version: 3,
        target,
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        localSourceHash: hashText(localMarkdown),
        publishDraftHash: hashText(localMarkdown),
        remoteSnapshotHash: hashText(flatMarkdown),
        localBaseSnapshot,
        remoteSemanticSnapshot,
        updatedAt: '2026-07-17T00:00:00.000Z'
      }
    });
    const initialBlocks = nestedListBlocks('flat');
    const initialPage = initialBlocks[0]!;
    const initialById = new Map(initialBlocks.flatMap((block) => {
      return block.block_id ? [[block.block_id, block] as const] : [];
    }));
    let directBlocks = (initialPage.children as string[]).map((blockId) => initialById.get(blockId)!);
    let descendants: FeishuBlock[] = [];
    let final = false;
    const counter = { value: 0 };
    const creates: Array<{ parentBlockId: string; index?: number; count: number }> = [];
    const deletes: string[][] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: final ? localMarkdown : flatMarkdown,
        revision: final ? '3' : '2'
      }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: directBlocks.map((block) => block.block_id!) },
          ...directBlocks,
          ...descendants
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {
        throw new Error('nested repair must use explicit child creation');
      },
      createChildBlocks: async ({ parentBlockId, index, blocks }) => {
        creates.push({ parentBlockId, index, count: blocks.length });
        return {
          blocks: createChildBlocksInMemory({
            documentId: 'doc_token',
            directBlocks,
            descendants,
            parentBlockId,
            index,
            blocks,
            prefix: 'new',
            counter
          })
        };
      },
      deleteBlocks: async ({ blockIds }) => {
        deletes.push(blockIds);
        const deleting = new Set(blockIds);
        directBlocks = directBlocks.filter((block) => !block.block_id || !deleting.has(block.block_id));
        descendants = descendants.filter((block) => !block.block_id || !deleting.has(block.block_id));
        final = true;
      },
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

    expect(result.mode).toBe('write');
    expect(creates).toEqual([
      { parentBlockId: 'doc_token', index: 1, count: 1 },
      { parentBlockId: 'new-1', index: 0, count: 3 }
    ]);
    expect(deletes).toEqual([['old-parent', 'old-child', 'old-nested-bullet', 'old-nested-ordered']]);
    await expect(readPublishReceipt({ cwd: dir, target })).resolves.toMatchObject({ version: 4 });
  });

  it('dry-runs exact recovery from the observed malformed nested create before the unchanged flat baseline', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: fixture.malformedMarkdown, revision: '38' }),
        fetchDocBlocks: async () => ({ blocks: fixture.malformedBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.zdocRoundTrip).toMatchObject({ safeToPublish: true });
    expect(result.plan.whiteboards?.operations).toEqual([]);
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.scopedPatch?.warnings).toContain(
      'recovering exact malformed scoped create at ["Before you start"]'
    );
    expect(result.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({
        kind: 'create',
        insertAfterBlockId: 'baseline-2',
        desiredBlocks: expect.arrayContaining([
          expect.objectContaining({ markdown: expect.stringContaining('Second conclusion.') })
        ])
      }),
      expect.objectContaining({
        kind: 'delete',
        blockIds: fixture.malformedRootIds.concat(fixture.oldFlatIds),
        recovery: expect.objectContaining({
          expectedDescendantBlockIds: fixture.malformedChildIds,
          followingBlockId: 'baseline-15'
        })
      })
    ]);
  });

  it('dry-runs revision 39 recovery from two exact malformed tree creates before the unchanged flat baseline', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const page = fixture.malformedBlocks[0]!;
    const second = materializeTextBlockTrees(malformedHierarchyCreateMarkdown(), 'malformed2');
    const existingDirectIds = page.children as string[];
    const directIds = [
      ...existingDirectIds.slice(0, 2),
      ...second.roots.map((block) => block.block_id!),
      ...existingDirectIds.slice(2)
    ];
    const revision39Blocks = [
      { ...page, children: directIds },
      ...fixture.malformedBlocks.slice(1),
      ...second.roots,
      ...second.descendants
    ];
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({
          markdown: multiHierarchyMarkdownWithMalformedAttempts(2),
          revision: '39'
        }),
        fetchDocBlocks: async () => ({ blocks: revision39Blocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.scopedPatch?.warnings).toContain(
      'recovering exact malformed scoped create at ["Before you start"]'
    );
    expect(result.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'create', insertAfterBlockId: 'baseline-2' }),
      expect.objectContaining({
        kind: 'delete',
        blockIds: [
          ...second.roots.map((block) => block.block_id!),
          ...fixture.malformedRootIds,
          ...fixture.oldFlatIds
        ],
        recovery: expect.objectContaining({
          expectedDescendantBlockIds: [
            ...second.descendants.map((block) => block.block_id!),
            ...fixture.malformedChildIds
          ],
          followingBlockId: 'baseline-15'
        })
      })
    ]);
  });

  it('blocks revision 39 recovery when a child in either malformed create drifts', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const page = fixture.malformedBlocks[0]!;
    const second = materializeTextBlockTrees(malformedHierarchyCreateMarkdown(), 'malformed2');
    const driftedChild = second.descendants[1]!;
    const existingDirectIds = page.children as string[];
    const remoteBlocks = [
      {
        ...page,
        children: [
          ...existingDirectIds.slice(0, 2),
          ...second.roots.map((block) => block.block_id!),
          ...existingDirectIds.slice(2)
        ]
      },
      ...fixture.malformedBlocks.slice(1),
      ...second.roots,
      ...second.descendants.map((block) => block === driftedChild
        ? markdownBlock(block.block_id!, '- Teammate drift.')
        : block)
    ];
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: multiHierarchyMarkdownWithMalformedAttempts(2), revision: '39' }),
        fetchDocBlocks: async () => ({ blocks: remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.safeToPublish).toBe(false);
  });

  it('recreates the observed malformed nested tree through explicit parent child writes before deleting old roots', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const initialPage = fixture.malformedBlocks[0]!;
    const initialById = new Map(fixture.malformedBlocks.flatMap((block) => {
      return block.block_id ? [[block.block_id, block] as const] : [];
    }));
    let directBlocks = (initialPage.children as string[]).map((blockId) => initialById.get(blockId)!);
    const directIds = new Set(directBlocks.flatMap((block) => block.block_id ? [block.block_id] : []));
    let descendants = fixture.malformedBlocks.filter((block) => {
      return block.block_id && block.block_id !== 'doc_token' && !directIds.has(block.block_id);
    });
    let final = false;
    const calls: string[] = [];
    const desired = materializeTextBlockTrees(nestedHierarchyCreateMarkdown(), 'recovered');
    const desiredById = new Map(desired.descendants.flatMap((block) => {
      return block.block_id ? [[block.block_id, block] as const] : [];
    }));
    const desiredChildren = new Map(desired.roots.map((root) => [
      root.block_id!,
      ((root.children as string[] | undefined) ?? []).map((blockId) => desiredById.get(blockId)!)
    ]));
    const currentBlocks = () => [
      { block_id: 'doc_token', block_type: 1, children: directBlocks.map((block) => block.block_id!) },
      ...directBlocks,
      ...descendants
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: final ? fixture.nestedMarkdown : fixture.malformedMarkdown,
        revision: final ? '39' : '38'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {
        throw new Error('nested tree create must not use composite Markdown or XML insertion');
      },
      createChildBlocks: async ({ parentBlockId, index, blocks, clientToken }) => {
        calls.push(`create:${parentBlockId}:${index}:${blocks.length}:${clientToken}`);
        if (parentBlockId === 'doc_token') {
          expect(index).toBe(2);
          expect(blocks).toHaveLength(3);
          expect(blocks.every((block) => !block.children)).toBe(true);
          const anchorIndex = directBlocks.findIndex((block) => block.block_id === 'baseline-2');
          if (anchorIndex < 0) throw new Error('malformed recovery anchor missing');
          const created = desired.roots.map((root) => ({ ...root, parent_id: 'doc_token', children: undefined }));
          directBlocks.splice(anchorIndex + 1, 0, ...created);
          return { blocks: created };
        }
        const expected = desiredChildren.get(parentBlockId);
        if (!expected) throw new Error(`unexpected tree parent ${parentBlockId}`);
        expect(index).toBe(0);
        expect(blocks).toHaveLength(expected.length);
        expect(blocks.every((block) => !block.children)).toBe(true);
        const parent = directBlocks.find((block) => block.block_id === parentBlockId);
        if (!parent) throw new Error(`tree parent ${parentBlockId} is missing`);
        const created = expected.map((block) => ({ ...block, parent_id: parentBlockId, children: undefined }));
        parent.children = created.map((block) => block.block_id!);
        descendants = [...descendants, ...created];
        return { blocks: created };
      },
      deleteBlocks: async ({ blockIds }) => {
        calls.push(`delete:${blockIds.join(',')}`);
        expect(blockIds).toEqual(fixture.malformedRootIds.concat(fixture.oldFlatIds));
        const deleting = new Set([...blockIds, ...fixture.malformedChildIds]);
        directBlocks = directBlocks.filter((block) => !block.block_id || !deleting.has(block.block_id));
        descendants = descendants.filter((block) => !block.block_id || !deleting.has(block.block_id));
        final = true;
      },
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatch(/^create:doc_token:2:3:/);
    expect(calls[1]).toMatch(/^create:recovered-1:0:2:/);
    expect(calls[2]).toMatch(/^create:recovered-4:0:6:/);
    expect(calls[3]).toMatch(/^create:recovered-11:0:1:/);
    expect(calls[4]).toBe(`delete:${fixture.malformedRootIds.concat(fixture.oldFlatIds).join(',')}`);
    expect(new Set(calls.slice(0, 4).map((call) => call.split(':').at(-1))).size).toBe(4);
    expect(directBlocks.map((block) => block.block_id)).toEqual([
      'baseline-1', 'baseline-2', 'recovered-1', 'recovered-4', 'recovered-11', 'baseline-15', 'baseline-16'
    ]);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: fixture.target })).resolves.toMatchObject({
      version: 4,
      remoteRevision: '39'
    });
  });

  it('reports exact created root IDs and keeps deletes pending when staged child creation fails', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const initialPage = fixture.malformedBlocks[0]!;
    const initialById = new Map(fixture.malformedBlocks.flatMap((block) => {
      return block.block_id ? [[block.block_id, block] as const] : [];
    }));
    let directBlocks = (initialPage.children as string[]).map((blockId) => initialById.get(blockId)!);
    const descendants = fixture.malformedBlocks.filter((block) => {
      return block.block_id && block.block_id !== 'doc_token' && !directBlocks.includes(block);
    });
    const desired = materializeTextBlockTrees(nestedHierarchyCreateMarkdown(), 'partial');
    let deletes = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.malformedMarkdown, revision: '38' }),
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: directBlocks.map((block) => block.block_id!) },
          ...directBlocks,
          ...descendants
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => {
        throw new Error('composite insertion is forbidden');
      },
      createChildBlocks: async ({ parentBlockId }) => {
        if (parentBlockId !== 'doc_token') throw new Error('simulated child batch failure');
        const roots = desired.roots.map((root) => ({ ...root, parent_id: 'doc_token', children: undefined }));
        const anchorIndex = directBlocks.findIndex((block) => block.block_id === 'baseline-2');
        directBlocks.splice(anchorIndex + 1, 0, ...roots);
        return { blocks: roots };
      },
      deleteBlocks: async () => { deletes += 1; },
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    })).rejects.toMatchObject({
      completedOperations: [expect.objectContaining({
        kind: 'create',
        parentBlockId: 'doc_token',
        blockIds: desired.roots.map((block) => block.block_id!)
      })],
      failedOperation: expect.objectContaining({ kind: 'scoped-readback' }),
      pendingOperations: [expect.objectContaining({ kind: 'delete' })],
      receiptWritten: false
    });
    expect(deletes).toBe(0);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: fixture.target })).resolves.toMatchObject({
      version: 3
    });
  });

  it('replans an exact staged-root partial create ahead of both revision 39 malformed sets', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const page = fixture.malformedBlocks[0]!;
    const second = materializeTextBlockTrees(malformedHierarchyCreateMarkdown(), 'malformed2');
    const partial = materializeTextBlockTrees(nestedHierarchyCreateMarkdown(), 'partial');
    const partialRoots = partial.roots.map((root) => ({ ...root, parent_id: 'doc_token', children: undefined }));
    const existingDirectIds = page.children as string[];
    const directIds = [
      ...existingDirectIds.slice(0, 2),
      ...partialRoots.map((block) => block.block_id!),
      ...second.roots.map((block) => block.block_id!),
      ...existingDirectIds.slice(2)
    ];
    const remoteBlocks = [
      { ...page, children: directIds },
      ...fixture.malformedBlocks.slice(1),
      ...partialRoots,
      ...second.roots,
      ...second.descendants
    ];
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: multiHierarchyMarkdownWithMalformedAttempts(2), revision: '40' }),
        fetchDocBlocks: async () => ({ blocks: remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'create', insertAfterBlockId: 'baseline-2' }),
      expect.objectContaining({
        kind: 'delete',
        blockIds: [
          ...partialRoots.map((block) => block.block_id!),
          ...second.roots.map((block) => block.block_id!),
          ...fixture.malformedRootIds,
          ...fixture.oldFlatIds
        ],
        recovery: expect.objectContaining({
          expectedDescendantBlockIds: [
            ...second.descendants.map((block) => block.block_id!),
            ...fixture.malformedChildIds
          ]
        })
      })
    ]);
  });

  it('blocks staged-root recovery when one created root changed remotely', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const page = fixture.malformedBlocks[0]!;
    const partial = materializeTextBlockTrees(nestedHierarchyCreateMarkdown(), 'partial');
    const partialRoots = partial.roots.map((root, index) => index === 1
      ? markdownBlock(root.block_id!, '- Teammate changed this root.')
      : { ...root, parent_id: 'doc_token', children: undefined });
    const existingDirectIds = page.children as string[];
    const remoteBlocks = [
      {
        ...page,
        children: [
          ...existingDirectIds.slice(0, 2),
          ...partialRoots.map((block) => block.block_id!),
          ...existingDirectIds.slice(2)
        ]
      },
      ...fixture.malformedBlocks.slice(1),
      ...partialRoots
    ];
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: fixture.malformedMarkdown, revision: '40' }),
        fetchDocBlocks: async () => ({ blocks: remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.safeToPublish).toBe(false);
  });

  it('fails closed when a malformed nested create child drifts before recovery', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const drifted = fixture.malformedBlocks.map((block) => block.block_id === 'malformed-4'
      ? markdownBlock('malformed-4', '- Teammate changed nested two.')
      : block);
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({
          markdown: fixture.malformedMarkdown.replace('Nested two.', 'Teammate changed nested two.'),
          revision: '39'
        }),
        fetchDocBlocks: async () => ({ blocks: drifted }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip).toMatchObject({ safeToPublish: false });
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-ambiguous',
      severity: 'blocker'
    }));
  });

  it('fails preflight before malformed recovery writes when a reviewed child ID changes', async () => {
    const fixture = await createMalformedHierarchyRecoveryFixture();
    const drifted = fixture.malformedBlocks.flatMap((block) => {
      if (block.block_id === 'malformed-2') {
        return [{
          ...block,
          children: (block.children as string[]).map((blockId) => {
            return blockId === 'malformed-4' ? 'malformed-4b' : blockId;
          })
        }];
      }
      if (block.block_id === 'malformed-4') {
        return [{ ...block, block_id: 'malformed-4b' }];
      }
      return [block];
    });
    let reads = 0;
    let writes = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.malformedMarkdown, revision: '38' }),
      fetchDocBlocks: async () => ({
        blocks: (reads += 1) === 1 ? fixture.malformedBlocks : drifted
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => { writes += 1; },
      insertBlocksAfter: async () => { writes += 1; },
      deleteBlocks: async () => { writes += 1; },
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: fixture.target,
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    })).rejects.toThrow('partial-create recovery preflight failed: malformed tree child identity changed');
    expect(writes).toBe(0);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: fixture.target })).resolves.toMatchObject({
      version: 3
    });
  });

  it('updates and verifies a nested child without replacing its parent list block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-nested-list-update-'));
    const markdownPath = join(dir, 'doc.md');
    const baseline = nestedChildMarkdown('Child paragraph.');
    const desired = nestedChildMarkdown('Updated child paragraph.');
    await writeFile(markdownPath, desired, 'utf8');
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: dir, target, markdown: baseline });
    const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
      cwd: dir,
      target,
      document: remoteSemanticDocument(nestedChildBlocks('Child paragraph.'), 'doc_token')
    });
    await writePublishReceipt({
      cwd: dir,
      receipt: {
        version: 3,
        target,
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        localSourceHash: hashText(baseline),
        publishDraftHash: hashText(baseline),
        remoteSnapshotHash: hashText(baseline),
        localBaseSnapshot,
        remoteSemanticSnapshot,
        updatedAt: '2026-07-17T00:00:00.000Z'
      }
    });
    let child = 'Child paragraph.';
    const replacements: Array<{ blockId: string; content: string }> = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: nestedChildMarkdown(child), revision: child.startsWith('Updated') ? '3' : '2' }),
      fetchDocBlocks: async () => ({ blocks: nestedChildBlocks(child) }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        replacements.push({ blockId, content });
        child = content;
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

    expect(result.mode).toBe('write');
    expect(replacements).toEqual([{ blockId: 'child', content: 'Updated child paragraph.' }]);
    expect(nestedChildBlocks(child)[1]).toMatchObject({ block_id: 'parent', children: ['child', 'nested'] });
    await expect(readPublishReceipt({ cwd: dir, target })).resolves.toMatchObject({ version: 4 });
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

  it('reports a first table write as completed when post-engine semantic readback fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-post-engine-readback-'));
    const markdownPath = join(dir, 'doc.md');
    const before = [['ef', 'Old.']] as Array<[string, string]>;
    const after = [['ef', 'Updated.']] as Array<[string, string]>;
    await writeFile(markdownPath, htmlParameterTable(after), 'utf8');
    let mutated = false;
    let postMutationReads = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: markdownParameterTable(mutated ? after : before),
        revision: mutated ? '2' : '1'
      }),
      fetchDocBlocks: async () => {
        if (mutated && postMutationReads++ > 0) throw new Error('terminal table semantic readback failure');
        return { blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['table1'] },
          ...feishuTableBlocks(mutated ? after : before, 'table1')
        ] };
      },
      replaceDocument: async () => {},
      replaceBlock: async () => { mutated = true; },
      insertBlocksAfter: async () => {},
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
      completedOperations: [expect.objectContaining({ kind: 'table-replace' })],
      failedOperation: expect.objectContaining({ kind: 'scoped-readback' }),
      receiptWritten: false
    });
  });

  it('reports a first table checkpoint failure as receipt-write after verified remote success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-post-engine-checkpoint-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const before = [['ef', 'Old.']] as Array<[string, string]>;
    const after = [['ef', 'Updated.']] as Array<[string, string]>;
    const base = htmlParameterTable(before);
    const desired = htmlParameterTable(after);
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['table1'] },
        ...feishuTableBlocks(before, 'table1')
      ], 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(markdownParameterTable(before)),
        remoteRevision: '1',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });
    let mutated = false;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        if (mutated) throw new Error('checkpoint persistence read failed');
        return { markdown: markdownParameterTable(before), revision: '1' };
      },
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['table1'] },
        ...feishuTableBlocks(mutated ? after : before, 'table1')
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => { mutated = true; },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {}
    };

    await expect(runPublish({
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
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [expect.objectContaining({ kind: 'table-replace' })],
      failedOperation: { kind: 'receipt-write' },
      recoveryCheckpointWritten: false,
      receiptWritten: false
    });
  });

  it('retries table readback without repeating a successful table mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-readback-retry-'));
    const markdownPath = join(dir, 'doc.md');
    const before = [['ef', 'Accuracy trade-off.']] as Array<[string, string]>;
    const after = [
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ] as Array<[string, string]>;
    await writeFile(markdownPath, htmlParameterTable(after), 'utf8');
    let mutated = false;
    let staleReadbacks = 2;
    let mutationCount = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: markdownParameterTable(mutated ? after : before),
        revision: mutated ? '2' : '1'
      }),
      fetchDocBlocks: async () => {
        const stale = mutated && staleReadbacks > 0;
        if (stale) staleReadbacks -= 1;
        const rows = mutated && !stale ? after : before;
        return { blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['table1'] },
          ...feishuTableBlocks(rows, 'table1')
        ] };
      },
      replaceDocument: async () => {},
      replaceBlock: async () => {
        mutationCount += 1;
        mutated = true;
      },
      insertBlocksAfter: async () => {},
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
    })).resolves.toMatchObject({ mode: 'write' });

    expect(mutationCount).toBe(1);
    expect(staleReadbacks).toBe(0);
  });

  it('retries a transient provider read failure after a successful table mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-provider-readback-retry-'));
    const markdownPath = join(dir, 'doc.md');
    const before = [['ef', 'Accuracy trade-off.']] as Array<[string, string]>;
    const after = [
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ] as Array<[string, string]>;
    await writeFile(markdownPath, htmlParameterTable(after), 'utf8');
    let mutated = false;
    let transientReadFailures = 1;
    let mutationCount = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        if (mutated && transientReadFailures > 0) {
          transientReadFailures -= 1;
          throw new CliFailure({
            type: 'internal',
            subtype: 'unknown',
            message: 'An error occurred during processing. Check the input and retry',
            retryable: false,
            providerCode: 12330102
          });
        }
        return {
          markdown: markdownParameterTable(mutated ? after : before),
          revision: mutated ? '2' : '1'
        };
      },
      fetchDocBlocks: async () => ({
        blocks: [
          { block_id: 'doc_token', block_type: 1, children: ['table1'] },
          ...feishuTableBlocks(mutated ? after : before, 'table1')
        ]
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {
        mutationCount += 1;
        mutated = true;
        return { revision: '2' };
      },
      insertBlocksAfter: async () => {},
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
    })).resolves.toMatchObject({ mode: 'write' });

    expect(mutationCount).toBe(1);
    expect(transientReadFailures).toBe(0);
  });

  it('waits for a delayed table view, checkpoints its mutation revision, and continues with the next table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-readback-stabilization-'));
    try {
      const target = { kind: 'docx' as const, token: 'doc_token' };
      const base = partialCheckpointMarkdown({
        paragraphs: [],
        calloutBody: 'Body.',
        includeNewTail: false,
        includeNewCallout: false,
        updatedTables: new Set()
      });
      const desired = partialCheckpointMarkdown({
        paragraphs: [],
        calloutBody: 'Body.',
        includeNewTail: false,
        includeNewCallout: false,
        updatedTables: new Set(['alpha', 'beta'])
      });
      const markdownPath = join(dir, 'doc.md');
      await writeFile(markdownPath, desired, 'utf8');
      const initialBlocks = partialCheckpointBlocks({
        paragraphs: [],
        paragraphIds: [],
        calloutBody: 'Body.',
        calloutBodyId: 'callout-body',
        includeNewTail: false,
        includeNewCallout: false,
        updatedTables: new Set()
      });
      await writePublishBaselineBundle({
        cwd: dir,
        target,
        localBaseline: base,
        publishBaseline: base,
        remoteSemantic: remoteSemanticDocument(initialBlocks, 'doc_token'),
        receipt: {
          resolvedDocumentId: 'doc_token',
          profile: 'none',
          dialect: 'gfm',
          dialectDraftHash: hashText(base),
          dialectDependencies: [],
          linkResolutionFingerprint: semanticHash([]),
          resolvedLinks: [],
          localSourceHash: hashText(base),
          publishDraftHash: hashText(base),
          remoteSnapshotHash: hashText(base),
          remoteRevision: '2268',
          whiteboards: [],
          updatedAt: new Date().toISOString()
        }
      });

      const mutatedTables = new Set<string>();
      let revision = 2268;
      let alphaStaleReadbacks = 6;
      const mutations: string[] = [];
      let resolveFirstMutation!: () => void;
      const firstMutation = new Promise<void>((resolve) => {
        resolveFirstMutation = resolve;
      });
      const adapter: FeishuAdapter = {
        fetchDocMarkdown: async () => ({
          markdown: partialCheckpointMarkdown({
            paragraphs: [],
            calloutBody: 'Body.',
            includeNewTail: false,
            includeNewCallout: false,
            updatedTables: mutatedTables
          }),
          revision: String(revision)
        }),
        fetchDocBlocks: async () => {
          const visibleTables = new Set(mutatedTables);
          if (mutatedTables.has('alpha') && alphaStaleReadbacks > 0) {
            visibleTables.delete('alpha');
            alphaStaleReadbacks -= 1;
          }
          return {
            blocks: partialCheckpointBlocks({
              paragraphs: [],
              paragraphIds: [],
              calloutBody: 'Body.',
              calloutBodyId: 'callout-body',
              includeNewTail: false,
              includeNewCallout: false,
              updatedTables: visibleTables
            })
          };
        },
        replaceDocument: async () => {},
        replaceBlock: async ({ blockId }) => {
          const key = blockId === 'table-alpha' ? 'alpha' : blockId === 'table-beta' ? 'beta' : undefined;
          if (!key) throw new Error(`unexpected table mutation: ${blockId}`);
          mutations.push(key);
          mutatedTables.add(key);
          revision += 1;
          if (mutations.length === 1) resolveFirstMutation();
          return { revision: String(revision) };
        },
        insertBlocksAfter: async () => {},
        deleteBlocks: async () => {}
      };

      vi.useFakeTimers();
      const publish = runPublish({
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
      await firstMutation;
      await vi.runAllTimersAsync();

      await expect(publish).resolves.toMatchObject({ mode: 'write' });
      expect(mutations).toEqual(['alpha', 'beta']);
      expect(alphaStaleReadbacks).toBe(0);
      await expect(readPublishReceipt({ cwd: dir, target })).resolves.toMatchObject({
        version: 4,
        remoteRevision: '2270'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not accept a desired table view before the mutation revision becomes visible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-table-revision-stabilization-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const before = [['ef', 'Accuracy trade-off.']] as Array<[string, string]>;
    const after = [
      ['ef', 'Accuracy trade-off.'],
      ['num_random_samplings', 'Initial random seed iterations.']
    ] as Array<[string, string]>;
    const base = htmlParameterTable(before);
    const desired = htmlParameterTable(after);
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, desired, 'utf8');
    await writePublishBaselineBundle({
      cwd: dir,
      target,
      localBaseline: base,
      publishBaseline: base,
      remoteSemantic: remoteSemanticDocument([
        { block_id: 'doc_token', block_type: 1, children: ['table1'] },
        ...feishuTableBlocks(before, 'table1')
      ], 'doc_token'),
      receipt: {
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText(base),
        dialectDependencies: [],
        linkResolutionFingerprint: semanticHash([]),
        resolvedLinks: [],
        localSourceHash: hashText(base),
        publishDraftHash: hashText(base),
        remoteSnapshotHash: hashText(markdownParameterTable(before)),
        remoteRevision: '2268',
        whiteboards: [],
        updatedAt: new Date().toISOString()
      }
    });

    let mutated = false;
    let postMutationMarkdownReads = 0;
    let resolveMutation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        if (!mutated) return { markdown: markdownParameterTable(before), revision: '2268' };
        postMutationMarkdownReads += 1;
        return postMutationMarkdownReads === 1
          ? { markdown: markdownParameterTable(before), revision: '2268' }
          : { markdown: markdownParameterTable(after), revision: '2269' };
      },
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['table1'] },
        ...feishuTableBlocks(mutated ? after : before, 'table1')
      ] }),
      replaceDocument: async () => {},
      replaceBlock: async () => {
        mutated = true;
        resolveMutation();
        return { revision: '2269' };
      },
      insertBlocksAfter: async () => {},
      deleteBlocks: async () => {}
    };

    vi.useFakeTimers();
    try {
      const publish = runPublish({
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
      await mutation;
      await vi.runAllTimersAsync();
      await expect(publish).resolves.toMatchObject({ mode: 'write' });
    } finally {
      vi.useRealTimers();
    }

    expect(postMutationMarkdownReads).toBeGreaterThanOrEqual(2);
    await expect(readPublishReceipt({ cwd: dir, target })).resolves.toMatchObject({
      version: 4,
      remoteRevision: '2269'
    });
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

  it('preserves a tracked Whiteboard for an unchanged direct SVG during Zdoc text updates', async () => {
    const fixture = await createTrackedDirectSvgFixture({
      baselineText: 'Old surrounding text.',
      currentText: 'Updated surrounding text.'
    });
    const adapter = trackedDirectSvgAdapter({ text: 'Old surrounding text.' });

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.operations).toContainEqual(expect.objectContaining({
      kind: 'update',
      desiredMarkdown: 'Updated surrounding text.'
    }));
    expect(result.plan.whiteboards?.operations).toEqual([]);
    expect(result.plan.whiteboards?.assets).toEqual([expect.objectContaining({
      assetKey: 'images/flow.png',
      state: 'clean',
      action: 'preserve tracked whiteboard',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    })]);
  });

  it('blocks a changed tracked direct SVG without explicit Whiteboard intent', async () => {
    const fixture = await createTrackedDirectSvgFixture({
      baselineText: 'Surrounding text.',
      currentText: 'Surrounding text.',
      currentSvg: '<svg viewBox="0 0 10 10"><text>Updated flow</text></svg>'
    });

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: trackedDirectSvgAdapter({ text: 'Surrounding text.' })
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({
      code: 'protected-whiteboard-local-changed',
      assetKey: 'images/flow.png'
    }));
    expect(result.plan.whiteboards?.operations).toEqual([]);
  });

  it('requires Whiteboard opt-in and asset-specific confirmation to update a tracked direct SVG', async () => {
    const fixture = await createTrackedDirectSvgFixture({
      baselineText: 'Surrounding text.',
      currentText: 'Surrounding text.',
      currentSvg: '<svg viewBox="0 0 10 10"><text>Updated flow</text></svg>'
    });
    let updates = 0;
    const adapter: FeishuAdapter = {
      ...trackedDirectSvgAdapter({ text: 'Surrounding text.' }),
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => { updates += 1; }
    };

    const unconfirmed = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      adapter
    });
    expect(unconfirmed.plan.strategy).toBe('blocked');
    expect(unconfirmed.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({
      code: 'protected-whiteboard-overwrite-confirmation-required'
    }));
    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter
    })).rejects.toThrow('Scoped publish is blocked');
    expect(updates).toBe(0);

    const confirmed = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });
    expect(confirmed.plan.strategy).toBe('block-patch');
    expect(confirmed.plan.requiredRemoteWhiteboardOverwrites).toEqual(['images/flow.png']);
    expect(confirmed.plan.whiteboards?.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token',
      reason: 'confirmed-protected-overwrite'
    })]);
  });

  it('plans mixed text replacement with a confirmed protected Whiteboard update', async () => {
    const fixture = await createMixedTextProtectedWhiteboardFixture();
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.remoteMarkdown, revision: '2' }),
      fetchDocBlocks: async () => ({ blocks: fixture.remoteBlocks }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => {}
    };

    const protectedOnly = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });
    expect(protectedOnly.plan.strategy).toBe('blocked');
    expect(protectedOnly.plan.scopedPatch?.blockers).toEqual([]);
    expect(protectedOnly.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({
      code: 'protected-whiteboard-local-changed',
      assetKey: 'images/flow.png'
    }));

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'update',
        remoteBlockId: 'intro',
        desiredMarkdown: 'Intro [integration](https://example.feishu.cn/wiki/english).'
      }),
      expect.objectContaining({
        kind: 'create',
        insertAfterBlockId: 'before',
        desiredMarkdown: expect.stringContaining('**Create credentials**')
      }),
      expect.objectContaining({
        kind: 'delete',
        blockIds: ['old-1', 'old-2', 'old-3', 'duplicate']
      })
    ]));
    expect(result.plan.whiteboards?.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    })]);
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.requiredRemoteWhiteboardOverwrites).toEqual(['images/flow.png']);
  });

  it('uses the dialect-resolved Feishu URL inside a mixed scoped create', async () => {
    const fixture = await createMixedTextProtectedWhiteboardFixture({ relativeDetailsLink: true });
    const resolvedUrl = 'https://example.feishu.cn/wiki/B1cSwfWcri4VJLkCR20cHIs6nCf';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.remoteMarkdown, revision: '2' }),
      fetchDocBlocks: async () => ({ blocks: fixture.remoteBlocks }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => {},
      resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
      fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
      fetchBaseRecords: async () => [{
        recordId: 'rec1',
        fields: {
          Slug: 'integrate-with-model-providers',
          Docs: `[Integrate with Model Providers](${resolvedUrl})`,
          'Placement Type': ['canonical']
        }
      }],
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: {
        linkResolver: {
          type: 'lark-base',
          baseUrl: 'https://example.feishu.cn/base/base_token',
          keyField: 'Slug',
          urlField: 'Docs',
          placementTypeField: 'Placement Type',
          acceptedPlacementTypes: ['canonical']
        }
      },
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    const create = result.plan.scopedPatch?.operations.find((operation) => operation.kind === 'create');
    expect(create).toMatchObject({ kind: 'create' });
    if (!create || create.kind !== 'create') throw new Error('mixed create operation missing');
    expect(create.desiredMarkdown).toContain(`[Integrate with Model Providers](${resolvedUrl})`);
    expect(create.desiredMarkdown).not.toContain('./integrate-with-model-providers');
    expect(create.desiredBlocks).toContainEqual(expect.objectContaining({
      markdown: expect.stringContaining(`For details, see [Integrate with Model Providers](${resolvedUrl}).`)
    }));
  });

  it('reports resolved-link create readback loss with recoverable pending operations and no new receipt', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    let directBlocks = fixture.baselineRemoteBlocks.slice(1);
    let nestedChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let created = false;
    let requestedMarkdown = '';
    const counter = { value: 0 };
    const currentBlocks = () => [
      {
        block_id: 'doc_token',
        block_type: 1,
        children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
      },
      ...directBlocks,
      ...nestedChildren
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: created ? fixture.partialRemoteMarkdown : fixture.baselineRemoteMarkdown,
        revision: created ? '33' : '31'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        const replacement = markdownToFeishuBlocks(content)[0];
        if (!replacement) throw new Error('partial create intro replacement missing');
        directBlocks = directBlocks.map((block) => block.block_id === blockId
          ? { ...replacement, block_id: blockId }
          : block);
      },
      insertBlocksAfter: async () => {
        throw new Error('nested resolved-link create must use explicit child creation');
      },
      createChildBlocks: async ({ parentBlockId, index, blocks }) => {
        requestedMarkdown += feishuBlocksToMarkdown(blocks);
        const createdBlocks = createChildBlocksInMemory({
          documentId: 'doc_token',
          directBlocks,
          descendants: nestedChildren,
          parentBlockId,
          index,
          blocks,
          prefix: 'created',
          counter,
          transform: (block) => {
            if (!feishuBlocksToMarkdown([block]).includes('For details, see')) return block;
            return {
              ...markdownBlock(block.block_id!, 'For details, see Integrate with Model Providers.'),
              parent_id: block.parent_id
            };
          }
        });
        created = true;
        return { blocks: createdBlocks };
      },
      deleteBlocks: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => {},
      resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
      fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
      fetchBaseRecords: async () => [{
        recordId: 'rec1',
        fields: {
          Slug: 'integrate-with-model-providers',
          Docs: `[Integrate with Model Providers](${fixture.resolvedUrl})`,
          'Placement Type': ['canonical']
        }
      }],
      createDocument: async () => ({ documentId: 'created' })
    };

    let thrown: unknown;
    try {
      await runPublish({
        cwd: fixture.dir,
        file: fixture.markdownPath,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        dialect: 'zdoc-authoring',
        dialectConfig: fixture.dialectConfig,
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmCollaborationRisk: true,
        syncWhiteboards: true,
        confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
        adapter
      });
    } catch (error) {
      thrown = error;
    }

    expect(requestedMarkdown).toContain(`[Integrate with Model Providers](${fixture.resolvedUrl})`);
    expect(requestedMarkdown).not.toContain('./integrate-with-model-providers');
    expect(thrown).toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [
        expect.objectContaining({ kind: 'update' }),
        expect.objectContaining({ kind: 'create' })
      ],
      failedOperation: expect.objectContaining({ kind: 'scoped-readback' }),
      pendingOperations: expect.arrayContaining([
        expect.objectContaining({ kind: 'table-create' }),
        expect.objectContaining({ kind: 'whiteboard-update' }),
        expect.objectContaining({ kind: 'delete' })
      ]),
      receiptWritten: false
    });
    await expect(readPublishReceipt({
      cwd: fixture.dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({ version: 3 });
  });

  it('recovers an exact completed mixed create plus unchanged baseline suffix after readback failure', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.partialRemoteMarkdown, revision: '33' }),
      fetchDocBlocks: async () => ({ blocks: fixture.partialRemoteBlocks }),
      replaceDocument: async () => {},
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => {},
      resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
      fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
      fetchBaseRecords: async () => [{
        recordId: 'rec1',
        fields: {
          Slug: 'integrate-with-model-providers',
          Docs: `[Integrate with Model Providers](${fixture.resolvedUrl})`,
          'Placement Type': ['canonical']
        }
      }],
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.scopedPatch?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'create',
        insertAfterBlockId: 'before-intro',
        desiredMarkdown: expect.stringContaining(
          `For details, see [Integrate with Model Providers](${fixture.resolvedUrl}).`
        )
      }),
      expect.objectContaining({
        kind: 'delete',
        locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 2 },
        blockIds: expect.arrayContaining(['created-1', 'created-12', 'old-1', 'old-2', 'old-3'])
      }),
      expect.objectContaining({
        kind: 'table-create',
        insertAfterBlockId: 'params-intro',
        insertBeforeBlockId: 'provider-primary'
      }),
      expect.objectContaining({ kind: 'delete', blockIds: ['provider-duplicate'] })
    ]));
    expect(result.plan.scopedPatch?.operations).not.toContainEqual(expect.objectContaining({
      kind: 'update',
      remoteBlockId: fixture.detailsBlockId
    }));
    expect(result.plan.scopedPatch?.scopeSummary.overlappingConflicts).toEqual([]);
    expect(result.plan.whiteboards?.operations).toContainEqual(expect.objectContaining({
      kind: 'whiteboard-update',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    }));
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.requiredRemoteWhiteboardOverwrites).toEqual(['images/flow.png']);
  });

  it('recovers an exact completed native table create after a later Whiteboard failure', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    let directBlocks = fixture.partialRemoteBlocks.slice(1);
    let nestedChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let tableChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let hierarchyCreated = false;
    let tableCreated = false;
    let deleteCalls = 0;
    const treeCounter = { value: 0 };
    const currentBlocks = () => [
      {
        block_id: 'doc_token',
        block_type: 1,
        children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
      },
      ...directBlocks,
      ...nestedChildren,
      ...tableChildren
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: tableCreated
          ? fixture.tableCreatedRemoteMarkdown
          : hierarchyCreated
            ? fixture.linkRepairedRemoteMarkdown
            : fixture.partialRemoteMarkdown,
        revision: tableCreated ? '35' : '33'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        const replacement = markdownToFeishuBlocks(content)[0];
        if (!replacement) throw new Error('table recovery link replacement missing');
        directBlocks = directBlocks.map((block) => block.block_id === blockId
          ? { ...replacement, block_id: blockId }
          : block);
      },
      insertBlocksAfter: async ({ blockId, content, format }) => {
        expect(blockId).toBe('params-intro');
        expect(format).toBe('xml');
        expect(content).toMatch(/^<table>/);
        const [root, ...children] = feishuTableBlocks([
          ['name', 'Function name.'],
          ['input_field_names', 'Source fields.'],
          ['output_field_names', 'Output fields.'],
          ['function_type', 'Function type.'],
          ['params', 'Provider parameters.']
        ], 'params-table', true);
        const anchorIndex = directBlocks.findIndex((block) => block.block_id === blockId);
        if (!root || anchorIndex < 0) throw new Error('table recovery insert anchor missing');
        directBlocks.splice(anchorIndex + 1, 0, root);
        tableChildren = children;
        tableCreated = true;
      },
      createChildBlocks: async ({ parentBlockId, index, blocks }) => {
        const created = createChildBlocksInMemory({
          documentId: 'doc_token',
          directBlocks,
          descendants: nestedChildren,
          parentBlockId,
          index,
          blocks,
          prefix: 'recovered',
          counter: treeCounter
        });
        hierarchyCreated = true;
        return { blocks: created };
      },
      deleteBlocks: async () => { deleteCalls += 1; },
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
      updateWhiteboard: async () => {
        throw new Error('doc data is not ready: resource error: whiteboard');
      },
      resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
      fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
      fetchBaseRecords: async () => [{
        recordId: 'rec1',
        fields: {
          Slug: 'integrate-with-model-providers',
          Docs: `[Integrate with Model Providers](${fixture.resolvedUrl})`,
          'Placement Type': ['canonical']
        }
      }],
      createDocument: async () => ({ documentId: 'created' })
    };

    let thrown: unknown;
    try {
      await runPublish({
        cwd: fixture.dir,
        file: fixture.markdownPath,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        dialect: 'zdoc-authoring',
        dialectConfig: fixture.dialectConfig,
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmCollaborationRisk: true,
        syncWhiteboards: true,
        confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
        adapter
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [
        expect.objectContaining({ kind: 'create' }),
        expect.objectContaining({ kind: 'table-create' })
      ],
      failedOperation: expect.objectContaining({ kind: 'whiteboard-update' }),
      pendingOperations: [
        expect.objectContaining({
          kind: 'delete',
          locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 2 }
        }),
        expect.objectContaining({
          kind: 'delete',
          locator: { sectionPath: ['Define the text embedding function'], kind: 'text', ordinal: 3 }
        })
      ],
      receiptWritten: false
    });
    expect(deleteCalls).toBe(0);
    await expect(readPublishReceipt({
      cwd: fixture.dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({ version: 3 });

    const recovery = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(recovery.plan.strategy).toBe('block-patch');
    expect(recovery.plan.scopedPatch?.blockers).toEqual([]);
    expect(recovery.plan.scopedPatch?.scopeSummary.overlappingConflicts).toEqual([]);
    expect(recovery.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({
        kind: 'delete',
        blockIds: expect.arrayContaining(['created-1', 'created-12', 'old-1', 'old-2', 'old-3'])
      }),
      expect.objectContaining({ kind: 'delete', blockIds: ['provider-duplicate'] })
    ]);
    expect(recovery.plan.scopedPatch?.operations).not.toContainEqual(expect.objectContaining({ kind: 'table-create' }));
    expect(recovery.plan.whiteboards?.operations).toEqual([expect.objectContaining({
      kind: 'whiteboard-update',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    })]);
    expect(recovery.plan.requiredRemoteWhiteboardOverwrites).toEqual(['images/flow.png']);
    expect(recovery.plan.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('blocks completed table-create recovery when the native table content drifted', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const state = completedTableRecoveryState(fixture);
    const changed = 'Function description changed remotely.';
    const cellIndex = state.blocks.findIndex((block) => feishuBlocksToMarkdown([block]).includes('Function name.'));
    const cell = state.blocks[cellIndex];
    if (!cell?.block_id) throw new Error('completed table content drift cell missing');
    state.blocks[cellIndex] = textBlock(cell.block_id, changed);

    const result = await runCompletedTableRecoveryDryRun(
      fixture,
      state.blocks,
      fixture.tableCreatedRemoteMarkdown.replace('Function name.', changed)
    );

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Table',
      severity: 'blocker'
    }));
  });

  it('blocks completed table-create recovery when native table marks drifted', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const state = completedTableRecoveryState(fixture);
    const cellIndex = state.blocks.findIndex((block) => feishuBlocksToMarkdown([block]).includes('Function name.'));
    const cell = state.blocks[cellIndex];
    if (!cell?.block_id) throw new Error('completed table marks drift cell missing');
    state.blocks[cellIndex] = markdownBlock(cell.block_id, '**Function name.**');

    const result = await runCompletedTableRecoveryDryRun(
      fixture,
      state.blocks,
      fixture.tableCreatedRemoteMarkdown.replace('Function name.', '**Function name.**')
    );

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Table',
      severity: 'blocker'
    }));
  });

  it('blocks completed table-create recovery when the native table moved outside its reviewed anchors', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const state = completedTableRecoveryState(fixture);
    const tableIndex = state.directBlocks.findIndex((block) => block.block_id === 'params-table');
    const [table] = state.directBlocks.splice(tableIndex, 1);
    const providerIndex = state.directBlocks.findIndex((block) => block.block_id === 'provider-primary');
    if (!table || tableIndex < 0 || providerIndex < 0) throw new Error('completed table move fixture missing');
    state.directBlocks.splice(providerIndex + 1, 0, table);
    const blocks = completedTableBlocks(state.directBlocks, state.tableChildren);
    const movedMarkdown = fixture.linkRepairedRemoteMarkdown.replace(
      `The following table describes the parameters.\n\n${fixture.provider}`,
      `The following table describes the parameters.\n\n${fixture.provider}\n\n${fixture.tableMarkdown}`
    );

    const result = await runCompletedTableRecoveryDryRun(fixture, blocks, movedMarkdown);

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Table',
      severity: 'blocker'
    }));
  });

  it('blocks completed table-create recovery when an adjacent anchor changed remotely', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const state = completedTableRecoveryState(fixture);
    const changedProvider = `${fixture.provider} A teammate added this sentence.`;
    const providerIndex = state.directBlocks.findIndex((block) => block.block_id === 'provider-primary');
    if (providerIndex < 0) throw new Error('completed table following anchor missing');
    state.directBlocks[providerIndex] = markdownBlock('provider-primary', changedProvider);
    const blocks = completedTableBlocks(state.directBlocks, state.tableChildren);

    const result = await runCompletedTableRecoveryDryRun(
      fixture,
      blocks,
      fixture.tableCreatedRemoteMarkdown.replace(fixture.provider, changedProvider)
    );

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Table',
      severity: 'blocker'
    }));
  });

  it('blocks partial-create recovery when an extra remote block is present', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const direct = fixture.partialRemoteBlocks.slice(1);
    const oldStart = direct.findIndex((block) => block.block_id === 'old-1');
    direct.splice(oldStart, 0, markdownBlock('teammate-extra', 'A teammate added this paragraph.'));
    const blocks = [
      { block_id: 'doc_token', block_type: 1, children: direct.map((block) => block.block_id!) },
      ...direct
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const remoteMarkdown = fixture.partialRemoteMarkdown.replace(
      '\n\n- Create credentials in the provider console.\n- Grant the required permissions.',
      '\n\nA teammate added this paragraph.\n\n- Create credentials in the provider console.\n- Grant the required permissions.'
    );
    const adapter = recoveryPlanningAdapter(fixture, blocks, remoteMarkdown);

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.scopedPatch?.safeToWrite).toBe(false);
    expect(result.plan.scopedPatch?.warnings).not.toContainEqual(expect.stringContaining('recovering exact completed scoped create'));
  });

  it('blocks partial-create recovery when an ordinary created nested paragraph drifted', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    const expected = 'Grant the required permissions.';
    const drifted = 'Grant the required permissions and rotate them weekly.';
    let driftedBlockId: string | undefined;
    const blocks = fixture.partialRemoteBlocks.map((block) => {
      if (feishuBlocksToMarkdown([block]).trim() !== expected) return block;
      driftedBlockId = block.block_id;
      return markdownBlock(block.block_id!, drifted);
    });
    if (!driftedBlockId) throw new Error('nested drift fixture block missing');
    const remoteMarkdown = fixture.partialRemoteMarkdown.replace(expected, drifted);
    const adapter = recoveryPlanningAdapter(fixture, blocks, remoteMarkdown);

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.scopedPatch?.safeToWrite).toBe(false);
    expect(result.plan.scopedPatch?.blockers).not.toEqual([]);
    expect(result.plan.scopedPatch?.warnings).not.toContainEqual(expect.stringContaining('recovering exact completed scoped create'));
  });

  it('fails closed before flattened hierarchy recovery when its reviewed remote block drifted', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    let blockReads = 0;
    let writes = 0;
    const driftedBlocks = fixture.partialRemoteBlocks.map((block) => {
      return block.block_id === fixture.detailsBlockId
        ? markdownBlock(fixture.detailsBlockId, 'A teammate changed this paragraph.')
        : block;
    });
    const adapter = recoveryPlanningAdapter(fixture, fixture.partialRemoteBlocks, fixture.partialRemoteMarkdown);
    adapter.fetchDocBlocks = async () => ({
      blocks: (blockReads += 1) === 1 ? fixture.partialRemoteBlocks : driftedBlocks
    });
    adapter.replaceBlock = async () => { writes += 1; };
    adapter.insertBlocksAfter = async () => { writes += 1; };
    adapter.deleteBlocks = async () => { writes += 1; };
    adapter.updateWhiteboard = async () => { writes += 1; };

    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    })).rejects.toThrow('partial-create recovery preflight failed: flattened sequence content changed');
    expect(writes).toBe(0);
    await expect(readPublishReceipt({
      cwd: fixture.dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({ version: 3 });
  });

  it('writes the exact partial-create recovery and records a receipt only after final readback', async () => {
    const fixture = await createMixedCreateRecoveryFixture();
    let directBlocks = fixture.partialRemoteBlocks.slice(1);
    let nestedChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let tableChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let remoteRaw: unknown = whiteboardTextRaw('Flow');
    let written = false;
    const calls: string[] = [];
    const treeCounter = { value: 0 };
    const currentBlocks = () => [
      {
        block_id: 'doc_token',
        block_type: 1,
        children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
      },
      ...directBlocks,
      ...nestedChildren,
      ...tableChildren
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: written ? fixture.finalRemoteMarkdown : fixture.partialRemoteMarkdown,
        revision: written ? '34' : '33'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        calls.push(`replace:${blockId}`);
        const replacement = markdownToFeishuBlocks(content)[0];
        if (!replacement) throw new Error('recovery replacement block missing');
        directBlocks = directBlocks.map((block) => block.block_id === blockId
          ? { ...replacement, block_id: blockId }
          : block);
        written = true;
      },
      insertBlocksAfter: async ({ blockId, content, format }) => {
        calls.push(`insert:${blockId}:${format}`);
        expect(content).toMatch(/^<table>/);
        const [root, ...children] = feishuTableBlocks([
          ['name', 'Function name.'],
          ['input_field_names', 'Source fields.'],
          ['output_field_names', 'Output fields.'],
          ['function_type', 'Function type.'],
          ['params', 'Provider parameters.']
        ], 'params-table', true);
        const anchorIndex = directBlocks.findIndex((block) => block.block_id === blockId);
        if (!root || anchorIndex < 0) throw new Error('recovery table anchor missing');
        directBlocks.splice(anchorIndex + 1, 0, root);
        tableChildren = children;
        written = true;
      },
      createChildBlocks: async ({ parentBlockId, index, blocks }) => {
        calls.push(`create:${parentBlockId}:${blocks.length}`);
        const created = createChildBlocksInMemory({
          documentId: 'doc_token',
          directBlocks,
          descendants: nestedChildren,
          parentBlockId,
          index,
          blocks,
          prefix: 'recovered',
          counter: treeCounter
        });
        written = true;
        return { blocks: created };
      },
      deleteBlocks: async ({ blockIds }) => {
        calls.push(`delete:${blockIds.join(',')}`);
        const deleting = new Set(blockIds);
        directBlocks = directBlocks.filter((block) => !block.block_id || !deleting.has(block.block_id));
        written = true;
      },
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: remoteRaw }),
      updateWhiteboard: async () => {
        calls.push('whiteboard:wb_token');
        remoteRaw = whiteboardTextRaw('Updated Flow');
        written = true;
      },
      resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
      fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
      fetchBaseRecords: async () => [{
        recordId: 'rec1',
        fields: {
          Slug: 'integrate-with-model-providers',
          Docs: `[Integrate with Model Providers](${fixture.resolvedUrl})`,
          'Placement Type': ['canonical']
        }
      }],
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      dialect: 'zdoc-authoring',
      dialectConfig: fixture.dialectConfig,
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.mode).toBe('write');
    expect(calls).toEqual([
      'create:doc_token:3',
      'create:recovered-1:2',
      'create:recovered-2:5',
      'create:recovered-3:2',
      'insert:params-intro:xml',
      'whiteboard:wb_token',
      'delete:created-1,created-2,created-3,created-4,created-5,created-6,created-7,created-8,created-9,created-10,created-11,created-12,old-1,old-2,old-3',
      'delete:provider-duplicate'
    ]);
    expect(directBlocks.map((block) => block.block_id)).not.toEqual(expect.arrayContaining([
      'old-1', 'old-2', 'old-3', 'provider-duplicate'
    ]));
    expect(directBlocks).toContainEqual(expect.objectContaining({
      block_id: 'wb_block',
      block_type: 43,
      whiteboard: { token: 'wb_token' }
    }));
    await expect(readPublishReceipt({
      cwd: fixture.dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      version: 4,
      whiteboards: [{ blockId: 'wb_block', whiteboardToken: 'wb_token' }]
    });
  });

  it('writes and verifies mixed text replacement without changing protected Whiteboard identity', async () => {
    const fixture = await createMixedTextProtectedWhiteboardFixture();
    let directBlocks = fixture.remoteBlocks.slice(1);
    let written = false;
    let remoteRaw: unknown = whiteboardTextRaw('Flow');
    let createdBlock = 0;
    const treeCounter = { value: 0 };
    let nestedChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    const currentBlocks = () => [
      {
        block_id: 'doc_token',
        block_type: 1,
        children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
      },
      ...directBlocks,
      ...nestedChildren
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: written ? fixture.desiredRemoteMarkdown : fixture.remoteMarkdown,
        revision: written ? '3' : '2'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      replaceBlock: async ({ blockId, content }) => {
        const replacement = markdownToFeishuBlocks(content)[0];
        if (!replacement) throw new Error('replacement block missing');
        directBlocks = directBlocks.map((block) => block.block_id === blockId
          ? { ...replacement, block_id: blockId }
          : block);
        written = true;
      },
      insertBlocksAfter: async ({ blockId, content, format }) => {
        expect(format).toBe('markdown');
        const materialized = {
          roots: markdownToFeishuBlocks(content).map((block) => ({
            ...block,
            block_id: `created-${createdBlock += 1}`
          })),
          descendants: []
        };
        const anchorIndex = blockId === 'doc_token'
          ? -1
          : directBlocks.findIndex((block) => block.block_id === blockId);
        if (anchorIndex < -1 || (blockId !== 'doc_token' && anchorIndex < 0)) {
          throw new Error('insert anchor missing');
        }
        directBlocks.splice(anchorIndex + 1, 0, ...materialized.roots);
        nestedChildren = materialized.descendants;
        written = true;
      },
      createChildBlocks: async ({ parentBlockId, index, blocks }) => {
        const created = createChildBlocksInMemory({
          documentId: 'doc_token',
          directBlocks,
          descendants: nestedChildren,
          parentBlockId,
          index,
          blocks,
          prefix: 'tree',
          counter: treeCounter
        });
        written = true;
        return { blocks: created };
      },
      deleteBlocks: async ({ blockIds }) => {
        const deleting = new Set(blockIds);
        directBlocks = directBlocks.filter((block) => !block.block_id || !deleting.has(block.block_id));
        written = true;
      },
      replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
      queryWhiteboard: async () => ({ raw: remoteRaw }),
      updateWhiteboard: async () => {
        remoteRaw = whiteboardTextRaw('Updated Flow');
        written = true;
      }
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
      adapter
    });

    expect(result.mode).toBe('write');
    expect(directBlocks).toContainEqual(expect.objectContaining({
      block_id: 'wb_block',
      block_type: 43,
      whiteboard: { token: 'wb_token' }
    }));
    expect(directBlocks.map((block) => block.block_id)).not.toEqual(expect.arrayContaining([
      'old-1', 'old-2', 'old-3', 'duplicate'
    ]));
    await expect(readPublishReceipt({
      cwd: fixture.dir,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      version: 4,
      whiteboards: [{ blockId: 'wb_block', whiteboardToken: 'wb_token' }]
    });
  });

  it('repairs receipt-recorded missing table and duplicate text without changing a protected Whiteboard', async () => {
    const fixture = await createRecordedRoundTripLossFixture();
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: fixture.remoteMarkdown, revision: '2' }),
        fetchDocBlocks: async () => ({ blocks: fixture.remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('block-patch');
    expect(result.plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(result.plan.scopedPatch?.blockers).toEqual([]);
    expect(result.plan.scopedPatch?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'table-create',
        insertAfterBlockId: 'params-intro',
        insertBeforeBlockId: 'provider-primary',
        locator: { sectionPath: ['Define the text embedding function'], kind: 'table', ordinal: 0 }
      }),
      expect.objectContaining({
        kind: 'delete',
        blockIds: ['provider-duplicate']
      })
    ]));
    expect(result.plan.zdocRoundTrip?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'round-trip-loss-repair', component: 'Table', severity: 'warning' }),
      expect.objectContaining({ code: 'round-trip-loss-repair', component: 'Text', severity: 'warning' })
    ]));
    expect(result.plan.whiteboards?.operations).toEqual([]);
    expect(result.plan.whiteboards?.assets).toContainEqual(expect.objectContaining({
      assetKey: 'images/flow.png',
      action: 'preserve tracked whiteboard',
      blockId: 'wb_block',
      whiteboardToken: 'wb_token'
    }));
  });

  it('writes and verifies an anchored native table repair before deleting the recorded duplicate', async () => {
    const fixture = await createRecordedRoundTripLossFixture();
    let directBlocks = fixture.remoteBlocks.slice(1);
    let tableChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] = [];
    let written = false;
    const calls: string[] = [];
    const currentBlocks = () => [
      {
        block_id: 'doc_token',
        block_type: 1,
        children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
      },
      ...directBlocks,
      ...tableChildren
    ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: written ? fixture.desiredRemoteMarkdown : fixture.remoteMarkdown,
        revision: written ? '3' : '2'
      }),
      fetchDocBlocks: async () => ({ blocks: currentBlocks() }),
      replaceDocument: async () => {},
      insertBlocksAfter: async ({ blockId, content, format }) => {
        calls.push(`insert:${blockId}:${format}`);
        expect(format).toBe('xml');
        expect(content).toMatch(/^<table>/);
        const [tableRoot, ...children] = feishuTableBlocks([
          ['name', 'Function name.'],
          ['input_field_names', 'Source fields.'],
          ['output_field_names', 'Output fields.'],
          ['function_type', 'Function type.'],
          ['params', 'Provider parameters.']
        ], 'params-table', true);
        const anchorIndex = directBlocks.findIndex((block) => block.block_id === blockId);
        if (!tableRoot || anchorIndex < 0) throw new Error('table insert fixture anchor missing');
        directBlocks.splice(anchorIndex + 1, 0, tableRoot);
        tableChildren = children;
        written = true;
      },
      deleteBlocks: async ({ blockIds }) => {
        calls.push(`delete:${blockIds.join(',')}`);
        const deleting = new Set(blockIds);
        directBlocks = directBlocks.filter((block) => !block.block_id || !deleting.has(block.block_id));
        written = true;
      },
      replaceBlock: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(calls).toEqual(['insert:params-intro:xml', 'delete:provider-duplicate']);
    expect(directBlocks.map((block) => block.block_id)).toEqual(expect.arrayContaining([
      'wb_block', 'params-intro', 'params-table', 'provider-primary'
    ]));
    expect(directBlocks.map((block) => block.block_id)).not.toContain('provider-duplicate');
    expect(directBlocks.find((block) => block.block_id === 'wb_block')).toMatchObject({
      block_type: 43,
      whiteboard: { token: 'wb_token' }
    });
  });

  it('fails closed before table creation when the reviewed adjacent anchors drift', async () => {
    const fixture = await createRecordedRoundTripLossFixture();
    let blockReads = 0;
    let inserts = 0;
    const driftedBlocks = (() => {
      const direct = fixture.remoteBlocks.slice(1);
      const anchorIndex = direct.findIndex((block) => block.block_id === 'params-intro');
      direct.splice(anchorIndex + 1, 0, markdownBlock('interloper', 'A teammate inserted this paragraph.'));
      return [
        { block_id: 'doc_token', block_type: 1, children: direct.map((block) => block.block_id!) },
        ...direct
      ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
    })();
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: fixture.remoteMarkdown, revision: '2' }),
      fetchDocBlocks: async () => ({
        blocks: (blockReads += 1) === 1 ? fixture.remoteBlocks : driftedBlocks
      }),
      replaceDocument: async () => {},
      replaceBlock: async () => {},
      insertBlocksAfter: async () => { inserts += 1; },
      deleteBlocks: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: true,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      confirmCollaborationRisk: true,
      adapter
    })).rejects.toThrow('table-create preflight failed: adjacent anchors no longer match the reviewed plan');
    expect(inserts).toBe(0);
  });

  it('blocks a recorded table loss when the local table changed after the receipt', async () => {
    const fixture = await createRecordedRoundTripLossFixture();
    const current = await readFile(fixture.markdownPath, 'utf8');
    await writeFile(fixture.markdownPath, current.replace('Provider parameters.', 'Changed provider parameters.'), 'utf8');

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: fixture.remoteMarkdown, revision: '2' }),
        fetchDocBlocks: async () => ({ blocks: fixture.remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.risks).toContainEqual(expect.stringContaining('changed locally after the receipt'));
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Table',
      severity: 'blocker'
    }));
  });

  it('blocks a recorded duplicate loss when the remote duplicate changed after the receipt', async () => {
    const fixture = await createRecordedRoundTripLossFixture();
    const changedDuplicate = 'A teammate changed the duplicate provider guidance.';
    const remoteMarkdown = fixture.remoteMarkdown.replace(
      `${fixture.provider}\n\n${fixture.provider}`,
      `${fixture.provider}\n\n${changedDuplicate}`
    );
    const remoteBlocks = fixture.remoteBlocks.map((block) => {
      return block.block_id === 'provider-duplicate'
        ? markdownBlock('provider-duplicate', changedDuplicate)
        : block;
    });

    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '3' }),
        fetchDocBlocks: async () => ({ blocks: remoteBlocks }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.risks).toContainEqual(expect.stringContaining('changed remotely after the receipt'));
    expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-drift',
      component: 'Text',
      severity: 'blocker'
    }));
  });

  it('blocks tracked direct SVG protection when the remote Whiteboard identity mismatches the receipt', async () => {
    const fixture = await createTrackedDirectSvgFixture({
      baselineText: 'Surrounding text.',
      currentText: 'Updated surrounding text.'
    });
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: trackedDirectSvgAdapter({
        text: 'Surrounding text.',
        whiteboardToken: 'different_token'
      })
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({
      code: 'tracked-whiteboard-identity-mismatch'
    }));
    expect(result.plan.risks).toContain('scoped publish is blocked; auto will not fall back to document replacement');
  });

  it('blocks a Zdoc direct SVG when the corresponding remote Whiteboard has no receipt identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-whiteboard-untracked-'));
    const images = join(dir, 'images');
    const markdownPath = join(dir, 'doc.md');
    await mkdir(images);
    await writeFile(markdownPath, 'Surrounding text.\n\n![Flow](./images/flow.svg)', 'utf8');
    await writeFile(join(images, 'flow.svg'), '<svg viewBox="0 0 10 10"><text>Flow</text></svg>', 'utf8');

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
      adapter: trackedDirectSvgAdapter({ text: 'Surrounding text.' })
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.whiteboards?.blockers).toContainEqual(expect.objectContaining({
      code: 'tracked-whiteboard-receipt-missing',
      assetKey: 'images/flow.png'
    }));
  });

  it('blocks document replacement when Zdoc receipts protect Whiteboard identity', async () => {
    const fixture = await createTrackedDirectSvgFixture({
      baselineText: 'Surrounding text.',
      currentText: 'Updated surrounding text.'
    });
    const result = await runPublish({
      cwd: fixture.dir,
      file: fixture.markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      write: false,
      create: false,
      strategy: 'document-replace',
      confirmDestructive: false,
      adapter: trackedDirectSvgAdapter({ text: 'Surrounding text.' })
    });

    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.risks).toContain('document replacement cannot preserve tracked Whiteboard block and token identity');
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

  it('retries a structured applying Whiteboard update with the same idempotency token', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)', updatedSvg);
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>'),
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let remoteRaw: unknown = whiteboardTextRaw('CAGRA v1');
    const idempotencyTokens: string[] = [];
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
      updateWhiteboard: async ({ idempotencyToken }) => {
        idempotencyTokens.push(idempotencyToken);
        if (idempotencyTokens.length === 1) {
          throw new Error(JSON.stringify({
            ok: false,
            error: {
              code: 4003101,
              message: 'doc is applying doc data is not ready resource error whiteboard'
            }
          }));
        }
        remoteRaw = whiteboardTextRaw('CAGRA v2');
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
      confirmCollaborationRisk: true,
      syncWhiteboards: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(idempotencyTokens).toHaveLength(2);
    expect(new Set(idempotencyTokens).size).toBe(1);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 4,
        whiteboards: [{ blockId: 'wb_block', whiteboardToken: 'wb_token' }]
      });
  });

  it('retries provider code 4003101 preserved by the Lark CLI adapter', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)', updatedSvg);
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>'),
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let updated = false;
    const idempotencyTokens: string[] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        if (args[0] === 'docs' && args[1] === '+fetch') {
          return {
            stdout: JSON.stringify({ ok: true, data: { content: remoteMarkdown, revision_id: 2 } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' &&
          args[2] === '/open-apis/docx/v1/documents/doc_token') {
          return {
            stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 2 } } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' && args[2]?.includes('/blocks')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
                  { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
                ],
                has_more: false
              }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+query') {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { raw: updated ? whiteboardTextRaw('CAGRA v2') : whiteboardTextRaw('CAGRA v1') }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+update') {
          idempotencyTokens.push(args[args.indexOf('--idempotent-token') + 1]!);
          if (idempotencyTokens.length === 1) {
            return {
              stdout: '',
              stderr: JSON.stringify({
                ok: false,
                error: {
                  type: 'internal',
                  subtype: 'openapi_error',
                  code: 4003101,
                  message: 'doc is applying doc data is not ready resource error whiteboard',
                  retryable: false
                }
              })
            };
          }
          updated = true;
          return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
        }
        throw new Error(`unexpected lark-cli call: ${args.join(' ')}`);
      }
    });

    const result = await runPublish({
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

    expect(result.mode).toBe('write');
    expect(idempotencyTokens).toHaveLength(2);
    expect(new Set(idempotencyTokens).size).toBe(1);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({ version: 4 });
  });

  it('retries a structured raw-not-ready query after a Lark CLI Whiteboard update', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)', updatedSvg);
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>'),
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let updated = false;
    let updates = 0;
    let postUpdateQueries = 0;
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        if (args[0] === 'docs' && args[1] === '+fetch') {
          return {
            stdout: JSON.stringify({ ok: true, data: { content: remoteMarkdown, revision_id: 2 } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' &&
          args[2] === '/open-apis/docx/v1/documents/doc_token') {
          return {
            stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 2 } } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' && args[2]?.includes('/blocks')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
                  { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
                ],
                has_more: false
              }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+query') {
          if (!updated) {
            return {
              stdout: JSON.stringify({ ok: true, data: { raw: whiteboardTextRaw('CAGRA v1') } }),
              stderr: ''
            };
          }
          postUpdateQueries += 1;
          return postUpdateQueries === 1
            ? { stdout: JSON.stringify({ ok: true, data: { raw: { nodes: [] } } }), stderr: '' }
            : {
                stdout: JSON.stringify({ ok: true, data: { raw: whiteboardTextRaw('CAGRA v2') } }),
                stderr: ''
              };
        }
        if (args[0] === 'whiteboard' && args[1] === '+update') {
          updates += 1;
          updated = true;
          return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
        }
        throw new Error(`unexpected lark-cli call: ${args.join(' ')}`);
      }
    });

    const result = await runPublish({
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

    expect(result.mode).toBe('write');
    expect(updates).toBe(1);
    expect(postUpdateQueries).toBe(2);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({ version: 4 });
  });

  it('does not retry malformed raw state after a Lark CLI Whiteboard update', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)', updatedSvg);
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    const previousSvgHash = hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>');
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: previousSvgHash,
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let updated = false;
    let updates = 0;
    let postUpdateQueries = 0;
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        if (args[0] === 'docs' && args[1] === '+fetch') {
          return {
            stdout: JSON.stringify({ ok: true, data: { content: remoteMarkdown, revision_id: 2 } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' &&
          args[2] === '/open-apis/docx/v1/documents/doc_token') {
          return {
            stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 2 } } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' && args[2]?.includes('/blocks')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
                  { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
                ],
                has_more: false
              }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+query') {
          if (!updated) {
            return {
              stdout: JSON.stringify({ ok: true, data: { raw: whiteboardTextRaw('CAGRA v1') } }),
              stderr: ''
            };
          }
          postUpdateQueries += 1;
          return {
            stdout: JSON.stringify({ ok: true, data: { raw: { version: 1 } } }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+update') {
          updates += 1;
          updated = true;
          return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
        }
        throw new Error(`unexpected lark-cli call: ${args.join(' ')}`);
      }
    });

    await expect(runPublish({
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
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      completedOperations: [],
      failedOperation: expect.objectContaining({ kind: 'whiteboard-update' }),
      receiptWritten: false
    });
    expect(updates).toBe(1);
    expect(postUpdateQueries).toBe(1);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({ version: 3, whiteboards: [{ svgHash: previousSvgHash }] });
  });

  it('does not retry a non-applying Whiteboard update error', async () => {
    const updatedSvg = '<svg viewBox="0 0 10 10"><text>CAGRA v2</text></svg>';
    const fixture = await createWhiteboardFixture('![CAGRA](./assets/cagra.png)', updatedSvg);
    const remoteMarkdown = '![CAGRA](remote-whiteboard)';
    const previousSvgHash = hashText('<svg viewBox="0 0 10 10"><text>CAGRA v1</text></svg>');
    await writeTrackedWhiteboardReceipt({
      cwd: fixture.dir,
      markdown: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown,
      svgHash: previousSvgHash,
      remoteRaw: whiteboardTextRaw('CAGRA v1')
    });
    let updates = 0;
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        if (args[0] === 'docs' && args[1] === '+fetch') {
          return {
            stdout: JSON.stringify({ ok: true, data: { content: remoteMarkdown, revision_id: 2 } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' &&
          args[2] === '/open-apis/docx/v1/documents/doc_token') {
          return {
            stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 2 } } }),
            stderr: ''
          };
        }
        if (args[0] === 'api' && args[1] === 'GET' && args[2]?.includes('/blocks')) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  { block_id: 'doc_token', block_type: 1, children: ['wb_block'] },
                  { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } }
                ],
                has_more: false
              }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+query') {
          return {
            stdout: JSON.stringify({ ok: true, data: { raw: whiteboardTextRaw('CAGRA v1') } }),
            stderr: ''
          };
        }
        if (args[0] === 'whiteboard' && args[1] === '+update') {
          updates += 1;
          return {
            stdout: '',
            stderr: JSON.stringify({
              ok: false,
              error: {
                type: 'authorization',
                subtype: 'openapi_error',
                code: 403,
                message: 'doc is applying doc data is not ready resource error whiteboard',
                retryable: false
              }
            })
          };
        }
        throw new Error(`unexpected lark-cli call: ${args.join(' ')}`);
      }
    });

    await expect(runPublish({
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
    })).rejects.toMatchObject({
      name: 'PartialWriteError',
      failedOperation: expect.objectContaining({ kind: 'whiteboard-update' }),
      receiptWritten: false
    });
    expect(updates).toBe(1);
    await expect(readPublishReceipt({ cwd: fixture.dir, target: { kind: 'docx', token: 'doc_token' } }))
      .resolves.toMatchObject({
        version: 3,
        whiteboards: [{ svgHash: previousSvgHash }]
      });
  });

  it('fails after bounded applying retries without executing pending deletes', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createMixedCreateRecoveryFixture();
      const state = completedTableRecoveryState(fixture);
      let updates = 0;
      let deletes = 0;
      let resolveFirstUpdate!: () => void;
      const firstUpdate = new Promise<void>((resolve) => { resolveFirstUpdate = resolve; });
      const adapter = recoveryPlanningAdapter(fixture, state.blocks, fixture.tableCreatedRemoteMarkdown);
      adapter.updateWhiteboard = async () => {
        updates += 1;
        if (updates === 1) resolveFirstUpdate();
        throw new Error(JSON.stringify({
          ok: false,
          error: {
            code: 4003101,
            message: 'doc is applying doc data is not ready resource error whiteboard'
          }
        }));
      };
      adapter.deleteBlocks = async () => { deletes += 1; };

      const outcome = runPublish({
        cwd: fixture.dir,
        file: fixture.markdownPath,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        dialect: 'zdoc-authoring',
        dialectConfig: fixture.dialectConfig,
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmCollaborationRisk: true,
        syncWhiteboards: true,
        confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
        adapter
      }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error })
      );

      await firstUpdate;
      await vi.runAllTimersAsync();
      const { result, error } = await outcome;

      expect(result).toBeUndefined();
      expect(error).toMatchObject({
        name: 'PartialWriteError',
        completedOperations: [],
        failedOperation: expect.objectContaining({ kind: 'whiteboard-update' }),
        pendingOperations: [
          expect.objectContaining({
            kind: 'delete',
            locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 5 }
          }),
          expect.objectContaining({
            kind: 'delete',
            locator: { sectionPath: ['Define the text embedding function'], kind: 'text', ordinal: 3 }
          })
        ],
        receiptWritten: false
      });
      expect(updates).toBe(8);
      expect(deletes).toBe(0);
      await expect(readPublishReceipt({
        cwd: fixture.dir,
        target: { kind: 'docx', token: 'doc_token' }
      })).resolves.toMatchObject({ version: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails after bounded raw-not-ready readback retries without executing pending deletes', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await createMixedCreateRecoveryFixture();
      const state = completedTableRecoveryState(fixture);
      let updated = false;
      let updates = 0;
      let postUpdateQueries = 0;
      let deletes = 0;
      let resolveFirstPostUpdateQuery!: () => void;
      const firstPostUpdateQuery = new Promise<void>((resolve) => { resolveFirstPostUpdateQuery = resolve; });
      const adapter = recoveryPlanningAdapter(fixture, state.blocks, fixture.tableCreatedRemoteMarkdown);
      adapter.updateWhiteboard = async () => {
        updates += 1;
        updated = true;
      };
      adapter.queryWhiteboard = async () => {
        if (!updated) return { raw: whiteboardTextRaw('Flow') };
        postUpdateQueries += 1;
        if (postUpdateQueries === 1) resolveFirstPostUpdateQuery();
        throw new CliFailure({
          type: 'verification',
          subtype: 'whiteboard_raw_not_ready',
          message: 'raw node state is not ready',
          retryable: false
        });
      };
      adapter.deleteBlocks = async () => { deletes += 1; };

      const outcome = runPublish({
        cwd: fixture.dir,
        file: fixture.markdownPath,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        dialect: 'zdoc-authoring',
        dialectConfig: fixture.dialectConfig,
        write: true,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        confirmCollaborationRisk: true,
        syncWhiteboards: true,
        confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
        adapter
      }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error })
      );

      await firstPostUpdateQuery;
      await vi.runAllTimersAsync();
      const { result, error } = await outcome;

      expect(result).toBeUndefined();
      expect(error).toMatchObject({
        name: 'PartialWriteError',
        completedOperations: [],
        failedOperation: expect.objectContaining({ kind: 'whiteboard-update' }),
        pendingOperations: [
          expect.objectContaining({
            kind: 'delete',
            locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 5 }
          }),
          expect.objectContaining({
            kind: 'delete',
            locator: { sectionPath: ['Define the text embedding function'], kind: 'text', ordinal: 3 }
          })
        ],
        receiptWritten: false
      });
      expect(updates).toBe(1);
      expect(postUpdateQueries).toBe(8);
      expect(deletes).toBe(0);
      await expect(readPublishReceipt({
        cwd: fixture.dir,
        target: { kind: 'docx', token: 'doc_token' }
      })).resolves.toMatchObject({ version: 3 });
    } finally {
      vi.useRealTimers();
    }
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

async function createMixedTextProtectedWhiteboardFixture(input: {
  relativeDetailsLink?: boolean;
} = {}): Promise<{
  dir: string;
  markdownPath: string;
  remoteMarkdown: string;
  desiredRemoteMarkdown: string;
  desiredBefore: string;
  remoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-mixed-text-whiteboard-'));
  const images = join(dir, 'images');
  const markdownPath = join(dir, 'doc.md');
  const baselineSvg = '<svg viewBox="0 0 10 10"><text>Flow</text></svg>';
  const currentSvg = '<svg viewBox="0 0 10 10"><text>Updated Flow</text></svg>';
  const detailsParagraph = input.relativeDetailsLink
    ? 'For details, see [Integrate with Model Providers](./integrate-with-model-providers).'
    : 'Store the secret securely.';
  const desiredBefore = [
    '- **Create credentials**',
    '',
    '    Create credentials in the provider console.',
    '',
    '- **Grant permissions**',
    '',
    '    Grant the required permissions.',
    '',
    '    - Read models',
    '    - Invoke endpoints',
    '    - Inspect usage',
    '',
    `    ${detailsParagraph}`,
    '',
    '- **Choose a model**',
    '',
    '    Choose a supported embedding model.'
  ].join('\n');
  const baselineMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://docs.example.com/integration).',
    '',
    '## How it works',
    '',
    '![Flow](./images/flow.svg)',
    '',
    '## Before you start',
    '',
    '- Create credentials in the provider console.',
    '- Grant the required permissions.',
    '- Choose a supported embedding model.',
    '',
    'This requirement is already covered above.',
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const desiredMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://example.feishu.cn/wiki/english).',
    '',
    '## How it works',
    '',
    '![Flow](./images/flow.svg)',
    '',
    '## Before you start',
    '',
    desiredBefore,
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const remoteMarkdown = baselineMarkdown
    .replace('https://docs.example.com/integration', 'https://docs.example.com/integration')
    .replace('./images/flow.svg', 'remote-whiteboard');
  const desiredRemoteMarkdown = desiredMarkdown.replace('./images/flow.svg', 'remote-whiteboard');
  const directBlocks = [
    markdownBlock('intro', 'Intro [integration](https://docs.example.com/integration).'),
    markdownBlock('how', '## How it works'),
    { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } },
    markdownBlock('before', '## Before you start'),
    markdownBlock('old-1', '- Create credentials in the provider console.'),
    markdownBlock('old-2', '- Grant the required permissions.'),
    markdownBlock('old-3', '- Choose a supported embedding model.'),
    markdownBlock('duplicate', 'This requirement is already covered above.'),
    markdownBlock('configure', '## Configure the integration'),
    markdownBlock('continue', 'Continue here.')
  ];
  const remoteBlocks = [
    { block_id: 'doc_token', block_type: 1, children: directBlocks.map((block) => block.block_id!) },
    ...directBlocks
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];

  await mkdir(images);
  await writeFile(markdownPath, desiredMarkdown, 'utf8');
  await writeFile(join(images, 'flow.svg'), currentSvg, 'utf8');

  const target = { kind: 'docx' as const, token: 'doc_token' };
  const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: dir, target, markdown: baselineMarkdown });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: dir,
    target,
    document: remoteSemanticDocument(remoteBlocks, 'doc_token')
  });
  await writePublishReceipt({
    cwd: dir,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(baselineMarkdown),
      publishDraftHash: hashText(baselineMarkdown),
      remoteSnapshotHash: hashText(remoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [{
        assetKey: 'images/flow.png',
        pngPath: 'images/flow.png',
        svgPath: 'images/flow.svg',
        svgHash: hashText(baselineSvg),
        whiteboardToken: 'wb_token',
        blockId: 'wb_block',
        remoteStateHash: whiteboardRemoteStateHash(whiteboardTextRaw('Flow')),
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-16T00:00:00.000Z'
    }
  });
  return { dir, markdownPath, remoteMarkdown, desiredRemoteMarkdown, desiredBefore, remoteBlocks };
}

async function createMixedCreateRecoveryFixture(): Promise<{
  dir: string;
  markdownPath: string;
  baselineRemoteMarkdown: string;
  baselineRemoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  partialRemoteMarkdown: string;
  partialRemoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  linkRepairedRemoteMarkdown: string;
  tableCreatedRemoteMarkdown: string;
  finalRemoteMarkdown: string;
  resolvedBefore: string;
  detailsBlockId: string;
  resolvedUrl: string;
  provider: string;
  tableMarkdown: string;
  dialectConfig: {
    linkResolver: {
      type: 'lark-base';
      baseUrl: string;
      keyField: string;
      urlField: string;
      placementTypeField: string;
      acceptedPlacementTypes: string[];
    };
  };
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-partial-create-recovery-'));
  const images = join(dir, 'images');
  const markdownPath = join(dir, 'doc.md');
  const baselineSvg = '<svg viewBox="0 0 10 10"><text>Flow</text></svg>';
  const currentSvg = '<svg viewBox="0 0 10 10"><text>Updated Flow</text></svg>';
  const resolvedUrl = 'https://example.feishu.cn/wiki/B1cSwfWcri4VJLkCR20cHIs6nCf';
  const relativeDetails = 'For details, see [Integrate with Model Providers](./integrate-with-model-providers).';
  const resolvedDetails = `For details, see [Integrate with Model Providers](${resolvedUrl}).`;
  const plainDetails = 'For details, see Integrate with Model Providers.';
  const provider = 'Set `provider` and `credential` together. The token must be valid for the selected provider.';
  const beforeIntro = 'Complete these prerequisites before creating the collection.';
  const oldBefore = [
    '- Create credentials in the provider console.',
    '- Grant the required permissions.',
    '- Choose a supported embedding model.'
  ].join('\n');
  const desiredBefore = [
    '- **Create credentials**',
    '',
    `    ${relativeDetails}`,
    '',
    '    Create credentials in the provider console.',
    '',
    '- **Grant permissions**',
    '',
    '    Grant the required permissions.',
    '',
    '    - Read models',
    '    - Invoke endpoints',
    '    - Inspect usage',
    '',
    '    Review the granted permissions regularly.',
    '',
    '- **Choose a model**',
    '',
    '    Choose a supported embedding model.',
    '',
    '    Confirm that the model supports text embeddings.'
  ].join('\n');
  const resolvedBefore = desiredBefore.replace(relativeDetails, resolvedDetails);
  const table = markdownParameterTable([
    ['name', 'Function name.'],
    ['input_field_names', 'Source fields.'],
    ['output_field_names', 'Output fields.'],
    ['function_type', 'Function type.'],
    ['params', 'Provider parameters.']
  ]);
  const baselineMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://docs.example.com/integration).',
    '',
    '## How it works',
    '',
    '![Flow](./images/flow.svg)',
    '',
    '## Before you start',
    '',
    beforeIntro,
    '',
    oldBefore,
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    table,
    '',
    provider,
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const desiredMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://example.feishu.cn/wiki/english).',
    '',
    '## How it works',
    '',
    '![Flow](./images/flow.svg)',
    '',
    '## Before you start',
    '',
    beforeIntro,
    '',
    desiredBefore,
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    table,
    '',
    provider,
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const baselineRemoteMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://docs.example.com/integration).',
    '',
    '## How it works',
    '',
    '![Flow](remote-whiteboard)',
    '',
    '## Before you start',
    '',
    beforeIntro,
    '',
    oldBefore,
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    provider,
    '',
    provider,
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const partialRemoteMarkdown = [
    '# Hugging Face',
    '',
    'Intro [integration](https://example.feishu.cn/wiki/english).',
    '',
    '## How it works',
    '',
    '![Flow](remote-whiteboard)',
    '',
    '## Before you start',
    '',
    beforeIntro,
    '',
    resolvedBefore.replace(resolvedDetails, plainDetails),
    '',
    oldBefore,
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    provider,
    '',
    provider,
    '',
    '## Configure the integration',
    '',
    'Continue here.'
  ].join('\n');
  const finalRemoteMarkdown = desiredMarkdown
    .replace(relativeDetails, resolvedDetails)
    .replace('./images/flow.svg', 'remote-whiteboard');
  const linkRepairedRemoteMarkdown = partialRemoteMarkdown.replace(plainDetails, resolvedDetails);
  const tableCreatedRemoteMarkdown = linkRepairedRemoteMarkdown.replace(
    `The following table describes the parameters.\n\n${provider}`,
    `The following table describes the parameters.\n\n${table}\n\n${provider}`
  );

  const baselineDirect = [
    markdownBlock('intro', 'Intro [integration](https://docs.example.com/integration).'),
    markdownBlock('how', '## How it works'),
    { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } },
    markdownBlock('before', '## Before you start'),
    textBlock('before-intro', beforeIntro),
    markdownBlock('old-1', '- Create credentials in the provider console.'),
    markdownBlock('old-2', '- Grant the required permissions.'),
    markdownBlock('old-3', '- Choose a supported embedding model.'),
    markdownBlock('define', '## Define the text embedding function'),
    textBlock('params-intro', 'The following table describes the parameters.'),
    markdownBlock('provider-primary', provider),
    markdownBlock('provider-duplicate', provider),
    markdownBlock('configure', '## Configure the integration'),
    textBlock('continue', 'Continue here.')
  ];
  const baselineRemoteBlocks = [
    { block_id: 'doc_token', block_type: 1, children: baselineDirect.map((block) => block.block_id!) },
    ...baselineDirect
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  const createdBlocks = flattenTextBlockTrees(markdownToFeishuBlocks(resolvedBefore)).map((block, index) => ({
    ...block,
    block_id: `created-${index + 1}`
  }));
  const representationIndex = createdBlocks.findIndex((block) => {
    return feishuBlocksToMarkdown([block]).trim() === 'Create credentials in the provider console.';
  });
  if (representationIndex < 0) throw new Error('partial recovery fixture representation block missing');
  const representationBlockId = createdBlocks[representationIndex]!.block_id!;
  createdBlocks[representationIndex] = textBlock(
    representationBlockId,
    'Create\u00a0credentials in the provider console.'
  );
  const detailsIndex = createdBlocks.findIndex((block) => {
    return feishuBlocksToMarkdown([block]).includes('For details, see');
  });
  if (detailsIndex < 0) throw new Error('partial recovery fixture details block missing');
  const detailsBlockId = createdBlocks[detailsIndex]!.block_id!;
  createdBlocks[detailsIndex] = markdownBlock(detailsBlockId, plainDetails);
  const partialDirect = [
    markdownBlock('intro', 'Intro [integration](https://example.feishu.cn/wiki/english).'),
    markdownBlock('how', '## How it works'),
    { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } },
    markdownBlock('before', '## Before you start'),
    textBlock('before-intro', beforeIntro),
    ...createdBlocks,
    markdownBlock('old-1', '- Create credentials in the provider console.'),
    markdownBlock('old-2', '- Grant the required permissions.'),
    markdownBlock('old-3', '- Choose a supported embedding model.'),
    markdownBlock('define', '## Define the text embedding function'),
    textBlock('params-intro', 'The following table describes the parameters.'),
    markdownBlock('provider-primary', provider),
    markdownBlock('provider-duplicate', provider),
    markdownBlock('configure', '## Configure the integration'),
    textBlock('continue', 'Continue here.')
  ];
  const partialRemoteBlocks = [
    { block_id: 'doc_token', block_type: 1, children: partialDirect.map((block) => block.block_id!) },
    ...partialDirect
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];

  await mkdir(images);
  await writeFile(markdownPath, desiredMarkdown, 'utf8');
  await writeFile(join(images, 'flow.svg'), currentSvg, 'utf8');
  const target = { kind: 'docx' as const, token: 'doc_token' };
  const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: dir, target, markdown: baselineMarkdown });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: dir,
    target,
    document: remoteSemanticDocument(baselineRemoteBlocks, 'doc_token')
  });
  await writePublishReceipt({
    cwd: dir,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'zilliz',
      localSourceHash: hashText(baselineMarkdown),
      publishDraftHash: hashText(baselineMarkdown),
      remoteSnapshotHash: hashText(baselineRemoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [{
        assetKey: 'images/flow.png',
        pngPath: 'images/flow.png',
        svgPath: 'images/flow.svg',
        svgHash: hashText(baselineSvg),
        whiteboardToken: 'wb_token',
        blockId: 'wb_block',
        remoteStateHash: whiteboardRemoteStateHash(whiteboardTextRaw('Flow')),
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-16T00:00:00.000Z'
    }
  });
  return {
    dir,
    markdownPath,
    baselineRemoteMarkdown,
    baselineRemoteBlocks,
    partialRemoteMarkdown,
    partialRemoteBlocks,
    linkRepairedRemoteMarkdown,
    tableCreatedRemoteMarkdown,
    finalRemoteMarkdown,
    resolvedBefore,
    detailsBlockId,
    resolvedUrl,
    provider,
    tableMarkdown: table,
    dialectConfig: {
      linkResolver: {
        type: 'lark-base',
        baseUrl: 'https://example.feishu.cn/base/base_token',
        keyField: 'Slug',
        urlField: 'Docs',
        placementTypeField: 'Placement Type',
        acceptedPlacementTypes: ['canonical']
      }
    }
  };
}

function completedTableRecoveryState(
  fixture: Awaited<ReturnType<typeof createMixedCreateRecoveryFixture>>
): {
  blocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  directBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  tableChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
} {
  const resolvedDetails = `For details, see [Integrate with Model Providers](${fixture.resolvedUrl}).`;
  const directBlocks = fixture.partialRemoteBlocks.slice(1).map((block) => {
    return block.block_id === fixture.detailsBlockId
      ? markdownBlock(fixture.detailsBlockId, resolvedDetails)
      : block;
  });
  const nested = materializeTextBlockTrees(fixture.resolvedBefore, 'recovered');
  const beforeIntroIndex = directBlocks.findIndex((block) => block.block_id === 'before-intro');
  if (beforeIntroIndex < 0) throw new Error('completed hierarchy recovery fixture anchor missing');
  directBlocks.splice(beforeIntroIndex + 1, 0, ...nested.roots);
  const [table, ...tableChildren] = feishuTableBlocks([
    ['name', 'Function name.'],
    ['input_field_names', 'Source fields.'],
    ['output_field_names', 'Output fields.'],
    ['function_type', 'Function type.'],
    ['params', 'Provider parameters.']
  ], 'params-table', true);
  const anchorIndex = directBlocks.findIndex((block) => block.block_id === 'params-intro');
  if (!table || anchorIndex < 0) throw new Error('completed table recovery fixture anchor missing');
  directBlocks.splice(anchorIndex + 1, 0, table);
  return {
    blocks: completedTableBlocks(directBlocks, [...nested.descendants, ...tableChildren]),
    directBlocks,
    tableChildren: [...nested.descendants, ...tableChildren]
  };
}

function completedTableBlocks(
  directBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'],
  tableChildren: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks']
): Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] {
  return [
    {
      block_id: 'doc_token',
      block_type: 1,
      children: directBlocks.flatMap((block) => block.block_id ? [block.block_id] : [])
    },
    ...directBlocks,
    ...tableChildren
  ];
}

async function runCompletedTableRecoveryDryRun(
  fixture: Awaited<ReturnType<typeof createMixedCreateRecoveryFixture>>,
  blocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'],
  markdown: string
) {
  return runPublish({
    cwd: fixture.dir,
    file: fixture.markdownPath,
    target: { kind: 'docx', token: 'doc_token' },
    profile: 'zilliz',
    dialect: 'zdoc-authoring',
    dialectConfig: fixture.dialectConfig,
    write: false,
    create: false,
    strategy: 'auto',
    confirmDestructive: false,
    syncWhiteboards: true,
    confirmedRemoteWhiteboardOverwrites: ['images/flow.png'],
    adapter: recoveryPlanningAdapter(fixture, blocks, markdown)
  });
}

function recoveryPlanningAdapter(
  fixture: Awaited<ReturnType<typeof createMixedCreateRecoveryFixture>>,
  blocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'],
  markdown: string
): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown, revision: '33' }),
    fetchDocBlocks: async () => ({ blocks }),
    replaceDocument: async () => {},
    replaceBlock: async () => {},
    insertBlocksAfter: async () => {},
    deleteBlocks: async () => {},
    replaceImageWithWhiteboard: async () => ({ blockId: 'wb_block', whiteboardToken: 'wb_token' }),
    queryWhiteboard: async () => ({ raw: whiteboardTextRaw('Flow') }),
    updateWhiteboard: async () => {},
    resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
    fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
    fetchBaseRecords: async () => [{
      recordId: 'rec1',
      fields: {
        Slug: 'integrate-with-model-providers',
        Docs: `[Integrate with Model Providers](${fixture.resolvedUrl})`,
        'Placement Type': ['canonical']
      }
    }],
    createDocument: async () => ({ documentId: 'created' })
  };
}

async function createRecordedRoundTripLossFixture(): Promise<{
  dir: string;
  markdownPath: string;
  remoteMarkdown: string;
  desiredRemoteMarkdown: string;
  provider: string;
  remoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-recorded-loss-'));
  const images = join(dir, 'images');
  const markdownPath = join(dir, 'doc.md');
  const svg = '<svg viewBox="0 0 10 10"><text>Flow</text></svg>';
  const provider = 'Set `provider` and `credential` together. The token must be valid for the selected provider.';
  const table = [
    '| Parameter | Description |',
    '|-|-|',
    '| `name` | Function name. |',
    '| `input_field_names` | Source fields. |',
    '| `output_field_names` | Output fields. |',
    '| `function_type` | Function type. |',
    '| `params` | Provider parameters. |'
  ].join('\n');
  const localMarkdown = [
    '# Hugging Face',
    '',
    '## How it works',
    '',
    '![Flow](./images/flow.svg)',
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    table,
    '',
    provider,
    '',
    '## Next step',
    '',
    'Create the collection.'
  ].join('\n');
  const remoteMarkdown = [
    '# Hugging Face',
    '',
    '## How it works',
    '',
    '![Flow](remote-whiteboard)',
    '',
    '## Define the text embedding function',
    '',
    'The following table describes the parameters.',
    '',
    provider,
    '',
    provider,
    '',
    '## Next step',
    '',
    'Create the collection.'
  ].join('\n');
  const directBlocks = [
    markdownBlock('how', '## How it works'),
    { block_id: 'wb_block', block_type: 43, whiteboard: { token: 'wb_token' } },
    markdownBlock('define', '## Define the text embedding function'),
    textBlock('params-intro', 'The following table describes the parameters.'),
    markdownBlock('provider-primary', provider),
    markdownBlock('provider-duplicate', provider),
    markdownBlock('next', '## Next step'),
    textBlock('create', 'Create the collection.')
  ];
  const remoteBlocks = [
    { block_id: 'doc_token', block_type: 1, children: directBlocks.map((block) => block.block_id!) },
    ...directBlocks
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];

  await mkdir(images);
  await writeFile(markdownPath, localMarkdown, 'utf8');
  await writeFile(join(images, 'flow.svg'), svg, 'utf8');
  const target = { kind: 'docx' as const, token: 'doc_token' };
  const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: dir, target, markdown: localMarkdown });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: dir,
    target,
    document: remoteSemanticDocument(remoteBlocks, 'doc_token')
  });
  await writePublishReceipt({
    cwd: dir,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(localMarkdown),
      publishDraftHash: hashText(localMarkdown),
      remoteSnapshotHash: hashText(remoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [{
        assetKey: 'images/flow.png',
        pngPath: 'images/flow.png',
        svgPath: 'images/flow.svg',
        svgHash: hashText(svg),
        whiteboardToken: 'wb_token',
        blockId: 'wb_block',
        remoteStateHash: whiteboardRemoteStateHash(whiteboardTextRaw('Flow')),
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-16T00:00:00.000Z'
    }
  });
  const desiredRemoteMarkdown = localMarkdown.replace('./images/flow.svg', 'remote-whiteboard');
  return { dir, markdownPath, remoteMarkdown, desiredRemoteMarkdown, provider, remoteBlocks };
}

function markdownBlock(blockId: string, markdown: string) {
  const block = markdownToFeishuBlocks(markdown)[0];
  if (!block) throw new Error(`Markdown fixture did not produce a block: ${markdown}`);
  return { ...block, block_id: blockId };
}

function flattenTextBlockTrees(blocks: FeishuBlock[]): FeishuBlock[] {
  return blocks.flatMap(flattenTextBlockTree);
}

function flattenTextBlockTree(block: FeishuBlock): FeishuBlock[] {
  const children = Array.isArray(block.children)
    ? block.children.filter((child): child is FeishuBlock => {
        return Boolean(child && typeof child === 'object' && !Array.isArray(child) && 'block_type' in child);
      })
    : [];
  const { children: _children, ...shell } = block;
  return [shell, ...children.flatMap(flattenTextBlockTree)];
}

function materializeTextBlockTrees(
  markdown: string,
  prefix: string
): { roots: FeishuBlock[]; descendants: FeishuBlock[] } {
  let ordinal = 0;
  const materialize = (block: FeishuBlock): { root: FeishuBlock; descendants: FeishuBlock[] } => {
    ordinal += 1;
    const blockId = `${prefix}-${ordinal}`;
    const children = Array.isArray(block.children)
      ? block.children.filter((child): child is FeishuBlock => {
          return Boolean(child && typeof child === 'object' && !Array.isArray(child) && 'block_type' in child);
        })
      : [];
    const materializedChildren = children.map(materialize);
    const root: FeishuBlock = {
      ...block,
      block_id: blockId,
      ...(materializedChildren.length > 0
        ? { children: materializedChildren.map((child) => child.root.block_id!) }
        : { children: undefined })
    };
    return {
      root,
      descendants: materializedChildren.flatMap((child) => [child.root, ...child.descendants])
    };
  };
  const materialized = markdownToFeishuBlocks(markdown).map(materialize);
  return {
    roots: materialized.map((entry) => entry.root),
    descendants: materialized.flatMap((entry) => entry.descendants)
  };
}

function createChildBlocksInMemory(input: {
  documentId: string;
  directBlocks: FeishuBlock[];
  descendants: FeishuBlock[];
  parentBlockId: string;
  index?: number;
  blocks: FeishuBlock[];
  prefix: string;
  counter: { value: number };
  transform?: (block: FeishuBlock) => FeishuBlock;
}): FeishuBlock[] {
  const created = input.blocks.map((block) => {
    input.counter.value += 1;
    const candidate = {
      ...block,
      block_id: `${input.prefix}-${input.counter.value}`,
      parent_id: input.parentBlockId,
      children: undefined
    };
    return input.transform ? input.transform(candidate) : candidate;
  });
  const index = input.index ?? -1;
  if (input.parentBlockId === input.documentId) {
    input.directBlocks.splice(index < 0 ? input.directBlocks.length : index, 0, ...created);
    return created;
  }
  const parent = [...input.directBlocks, ...input.descendants].find((block) => {
    return block.block_id === input.parentBlockId;
  });
  if (!parent) throw new Error(`created child parent ${input.parentBlockId} is missing`);
  const childIds = Array.isArray(parent.children) && parent.children.every((child) => typeof child === 'string')
    ? parent.children as string[]
    : [];
  childIds.splice(index < 0 ? childIds.length : index, 0, ...created.map((block) => block.block_id!));
  parent.children = childIds;
  input.descendants.push(...created);
  return created;
}

async function createTrackedDirectSvgFixture(input: {
  baselineText: string;
  currentText: string;
  currentSvg?: string;
}): Promise<{ dir: string; markdownPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-zdoc-whiteboard-protection-'));
  const images = join(dir, 'images');
  const markdownPath = join(dir, 'doc.md');
  const baselineSvg = '<svg viewBox="0 0 10 10"><text>Flow</text></svg>';
  const markdown = (text: string) => `${text}\n\n![Flow](./images/flow.svg)`;
  const remoteMarkdown = `${input.baselineText}\n\n![Flow](remote-whiteboard)`;
  await mkdir(images);
  await writeFile(markdownPath, markdown(input.currentText), 'utf8');
  await writeFile(join(images, 'flow.svg'), input.currentSvg ?? baselineSvg, 'utf8');

  const target = { kind: 'docx' as const, token: 'doc_token' };
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: dir,
    target,
    markdown: markdown(input.baselineText)
  });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: dir,
    target,
    document: { nodes: [
      {
        kind: 'text',
        locator: { sectionPath: [], kind: 'text', ordinal: 0 },
        blockType: 2,
        markdown: input.baselineText,
        remoteBlockId: 'text_block'
      },
      {
        kind: 'asset',
        locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
        representation: 'whiteboard',
        remoteBlockId: 'wb_block',
        remoteToken: 'wb_token'
      }
    ] }
  });
  await writePublishReceipt({
    cwd: dir,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(markdown(input.baselineText)),
      publishDraftHash: hashText(markdown(input.baselineText)),
      remoteSnapshotHash: hashText(remoteMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [{
        assetKey: 'images/flow.png',
        pngPath: 'images/flow.png',
        svgPath: 'images/flow.svg',
        svgHash: hashText(baselineSvg),
        whiteboardToken: 'wb_token',
        blockId: 'wb_block',
        remoteStateHash: whiteboardRemoteStateHash(whiteboardTextRaw('Flow')),
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-16T00:00:00.000Z'
    }
  });
  return { dir, markdownPath };
}

function trackedDirectSvgAdapter(input: {
  text: string;
  blockId?: string;
  whiteboardToken?: string;
}): FeishuAdapter {
  const blockId = input.blockId ?? 'wb_block';
  const whiteboardToken = input.whiteboardToken ?? 'wb_token';
  return {
    fetchDocMarkdown: async () => ({
      markdown: `${input.text}\n\n![Flow](remote-whiteboard)`,
      revision: '2'
    }),
    fetchDocBlocks: async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: ['text_block', blockId] },
      textBlock('text_block', input.text),
      { block_id: blockId, block_type: 43, whiteboard: { token: whiteboardToken } }
    ] }),
    replaceDocument: async () => {}
  };
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

function partialCheckpointMarkdown(input: {
  paragraphs: string[];
  calloutBody: string;
  includeNewTail: boolean;
  includeNewCallout: boolean;
  updatedTables: Set<string>;
}): string {
  const text = [
    ...input.paragraphs,
    ...(input.includeNewTail ? ['New tail.'] : []),
    `<div class="alert note">\n\n${input.calloutBody}\n\n</div>`,
    ...(input.includeNewCallout
      ? ['<div class="alert warning">\n\nNew warning.\n\n</div>']
      : []),
    ...['alpha', 'beta', 'gamma', 'delta'].map((key) => {
      const value = input.updatedTables.has(key) ? `Updated ${key}.` : `Old ${key}.`;
      return `<table>\n  <tr><th><p>Key ${key}</p></th><th><p>Value ${key}</p></th></tr>\n` +
        `  <tr><td><p><code>${key}</code></p></td><td><p>${value}</p></td></tr>\n</table>`;
    })
  ];
  return text.join('\n\n');
}

function partialCheckpointBlocks(input: {
  paragraphs: string[];
  paragraphIds: string[];
  calloutBody: string;
  calloutBodyId: string;
  includeNewTail: boolean;
  includeNewCallout: boolean;
  updatedTables: Set<string>;
}): Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] {
  const tableKeys = ['alpha', 'beta', 'gamma', 'delta'];
  const directChildren = [
    ...input.paragraphIds,
    ...(input.includeNewTail ? ['new-tail'] : []),
    'callout-existing',
    ...(input.includeNewCallout ? ['callout-new'] : []),
    ...tableKeys.map((key) => `table-${key}`)
  ];
  return [
    { block_id: 'doc_token', block_type: 1, children: directChildren },
    ...input.paragraphs.map((paragraph, index) => textBlock(input.paragraphIds[index]!, paragraph)),
    ...(input.includeNewTail ? [textBlock('new-tail', 'New tail.')] : []),
    {
      block_id: 'callout-existing',
      block_type: 19,
      callout: { emoji_id: '📘' },
      children: ['callout-title', input.calloutBodyId]
    },
    textBlock('callout-title', 'Notes'),
    textBlock(input.calloutBodyId, input.calloutBody),
    ...(input.includeNewCallout
      ? [
          {
            block_id: 'callout-new',
            block_type: 19,
            callout: { emoji_id: '❗' },
            children: ['callout-new-title', 'callout-new-body']
          },
          textBlock('callout-new-title', 'Warning'),
          textBlock('callout-new-body', 'New warning.')
        ]
      : []),
    ...tableKeys.flatMap((key) => feishuNamedTableBlocks({
      tableId: `table-${key}`,
      key,
      value: input.updatedTables.has(key) ? `Updated ${key}.` : `Old ${key}.`
    }))
  ];
}

function feishuNamedTableBlocks(input: {
  tableId: string;
  key: string;
  value: string;
}): Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'] {
  const values = [
    [`Key ${input.key}`, `Value ${input.key}`],
    [input.key, input.value]
  ];
  const cellIds = values.flatMap((_, row) => [
    `${input.tableId}-c${row}-0`,
    `${input.tableId}-c${row}-1`
  ]);
  return [
    {
      block_id: input.tableId,
      block_type: 31,
      table: { property: { row_size: 2, column_size: 2 }, cells: cellIds }
    },
    ...values.flatMap((row, rowIndex) => row.flatMap((value, columnIndex) => {
      const cellId = `${input.tableId}-c${rowIndex}-${columnIndex}`;
      const textId = `${cellId}-p`;
      return [
        { block_id: cellId, block_type: 32, children: [textId] },
        {
          ...textBlock(textId, value),
          text: {
            elements: [{ text_run: {
              content: value,
              text_element_style: rowIndex === 1 && columnIndex === 0 ? { inline_code: true } : {}
            } }]
          }
        }
      ];
    }))
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
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

function headingBlock(blockId: string, content: string): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 4,
    heading2: {
      elements: [{ text_run: { content, text_element_style: {} } }]
    }
  };
}

function codeReconcileState(initialBlocks: FeishuBlock[]): {
  blocks: () => FeishuBlock[];
  insertAfter: (blockId: string, block: FeishuBlock) => void;
  replace: (blockId: string, block: FeishuBlock) => void;
  delete: (blockIds: string[]) => void;
  moveAfter: (blockId: string, sourceBlockIds: string[]) => void;
} {
  const direct = [...initialBlocks];
  return {
    blocks: () => [{
      block_id: 'doc_token',
      block_type: 1,
      children: direct.flatMap((block) => block.block_id ? [block.block_id] : [])
    }, ...direct],
    insertAfter(blockId, block) {
      const index = direct.findIndex((candidate) => candidate.block_id === blockId);
      if (index < 0) throw new Error(`Code reconcile insert anchor ${blockId} is missing.`);
      direct.splice(index + 1, 0, block);
    },
    replace(blockId, block) {
      const index = direct.findIndex((candidate) => candidate.block_id === blockId);
      if (index < 0) throw new Error(`Code reconcile replacement ${blockId} is missing.`);
      direct[index] = block;
    },
    delete(blockIds) {
      for (const blockId of blockIds) {
        const index = direct.findIndex((candidate) => candidate.block_id === blockId);
        if (index >= 0) direct.splice(index, 1);
      }
    },
    moveAfter(blockId, sourceBlockIds) {
      const moving = sourceBlockIds.flatMap((sourceBlockId) => {
        const index = direct.findIndex((candidate) => candidate.block_id === sourceBlockId);
        return index >= 0 ? direct.splice(index, 1) : [];
      });
      const anchorIndex = direct.findIndex((candidate) => candidate.block_id === blockId);
      if (anchorIndex < 0) throw new Error(`Code reconcile move anchor ${blockId} is missing.`);
      direct.splice(anchorIndex + 1, 0, ...moving);
    }
  };
}

function codeReconcileAdapter(
  state: ReturnType<typeof codeReconcileState>,
  overrides: Partial<FeishuAdapter>
): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown: '' }),
    fetchDocBlocks: async () => ({ blocks: state.blocks() }),
    replaceDocument: async () => {},
    replaceBlock: async ({ blockId }) => {
      state.replace(blockId, codeBlock(blockId, 'new', 49));
    },
    insertBlocksAfter: async ({ blockId }) => {
      state.insertAfter(blockId, codeBlock('created-code', 'new', 49));
    },
    moveBlocksAfter: async ({ blockId, sourceBlockIds }) => {
      state.moveAfter(blockId, sourceBlockIds);
    },
    deleteBlocks: async ({ blockIds }) => {
      state.delete(blockIds);
    },
    ...overrides
  };
}

function codeReconcileOperation(input: {
  desiredContent: string;
  desiredSection: string;
  afterLocator?: SemanticCodeBlock['locator'];
  remoteCodes: Array<{ section: string; content: string; blockId: string }>;
}): Extract<ScopedPatchOperation, { kind: 'code-section-reconcile' }> {
  const desiredCode: SemanticCodeBlock = {
    kind: 'code',
    locator: { sectionPath: [input.desiredSection], kind: 'code', ordinal: 0 },
    content: input.desiredContent,
    sourceLanguage: 'python',
    resolvedLanguage: 'python',
    issues: []
  };
  return {
    kind: 'code-section-reconcile',
    locator: desiredCode.locator,
    sectionPaths: [...new Set([
      ...input.remoteCodes.map(({ section }) => section),
      input.desiredSection
    ])].map((section) => [section]),
    desiredCodes: [{
      code: desiredCode,
      ...(input.afterLocator ? { afterLocator: input.afterLocator } : {})
    }],
    remoteCodes: input.remoteCodes.map(({ section, content, blockId }) => ({
      kind: 'code',
      locator: { sectionPath: [section], kind: 'code', ordinal: 0 },
      content,
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      remoteBlockId: blockId,
      issues: []
    }))
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

async function createMalformedHierarchyRecoveryFixture(): Promise<{
  dir: string;
  markdownPath: string;
  target: { kind: 'docx'; token: string };
  nestedMarkdown: string;
  malformedMarkdown: string;
  malformedBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  malformedRootIds: string[];
  malformedChildIds: string[];
  oldFlatIds: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fms-malformed-hierarchy-recovery-'));
  const markdownPath = join(dir, 'doc.md');
  const target = { kind: 'docx' as const, token: 'doc_token' };
  const nestedMarkdown = multiHierarchyMarkdown('nested');
  const flatMarkdown = multiHierarchyMarkdown('flat');
  const malformedMarkdown = multiHierarchyMarkdown('malformed');
  const baseline = materializeTextBlockTrees(flatMarkdown, 'baseline');
  const malformed = materializeTextBlockTrees(malformedHierarchyCreateMarkdown(), 'malformed');
  const oldFlatIds = baseline.roots.slice(2, 14).map((block) => block.block_id!);
  const malformedRootIds = malformed.roots.map((block) => block.block_id!);
  const malformedChildIds = malformed.descendants.map((block) => block.block_id!);
  const direct = [
    ...baseline.roots.slice(0, 2),
    ...malformed.roots,
    ...baseline.roots.slice(2)
  ];
  const malformedBlocks = [
    { block_id: 'doc_token', block_type: 1, children: direct.map((block) => block.block_id!) },
    ...direct,
    ...malformed.descendants
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];

  await writeFile(markdownPath, nestedMarkdown, 'utf8');
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: dir,
    target,
    markdown: nestedMarkdown
  });
  const baselineBlocks = [
    { block_id: 'doc_token', block_type: 1, children: baseline.roots.map((block) => block.block_id!) },
    ...baseline.roots
  ] as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: dir,
    target,
    document: remoteSemanticDocument(baselineBlocks, 'doc_token')
  });
  await writePublishReceipt({
    cwd: dir,
    receipt: {
      version: 3,
      target,
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: hashText(nestedMarkdown),
      publishDraftHash: hashText(nestedMarkdown),
      remoteSnapshotHash: hashText(flatMarkdown),
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: [],
      updatedAt: '2026-07-17T00:00:00.000Z'
    }
  });
  return {
    dir,
    markdownPath,
    target,
    nestedMarkdown,
    malformedMarkdown,
    malformedBlocks,
    malformedRootIds,
    malformedChildIds,
    oldFlatIds
  };
}

function multiHierarchyMarkdown(state: 'nested' | 'flat' | 'malformed'): string {
  const nested = `## Before you start

Intro.

${nestedHierarchyCreateMarkdown()}`;
  const flat = `## Before you start

Intro.

- **First requirement**

First detail.

Second detail.

- **Second requirement**

Second intro.

- Nested one.

- Nested two.

- Nested three.

Second follow-up.

Second conclusion.

- **Third requirement**

Third detail.`;
  const before = state === 'nested'
    ? nested
    : state === 'flat'
      ? flat
      : `${nested.split('\n\n').slice(0, 2).join('\n\n')}\n\n${malformedHierarchyCreateMarkdown()}\n\n${flat.split('\n\n').slice(2).join('\n\n')}`;
  return `${before}\n\n## After\n\nStable paragraph.`;
}

function multiHierarchyMarkdownWithMalformedAttempts(count: number): string {
  const flat = multiHierarchyMarkdown('flat');
  const heading = '## Before you start\n\nIntro.';
  const suffix = flat.slice(flat.indexOf('- **First requirement**'));
  return `${heading}\n\n${Array.from({ length: count }, () => malformedHierarchyCreateMarkdown()).join('\n\n')}\n\n${suffix}`;
}

function nestedHierarchyCreateMarkdown(): string {
  return `- **First requirement**

    First detail.

    Second detail.

- **Second requirement**

    Second intro.

    - Nested one.
    - Nested two.
    - Nested three.

    Second follow-up.

    Second conclusion.

- **Third requirement**

    Third detail.`;
}

function malformedHierarchyCreateMarkdown(): string {
  return `- **First requirement**First detail.Second detail.

- **Second requirement**Second intro.

    - Nested one.

    - Nested two.

    - Nested three.

- **Third requirement**Third detail.`;
}

function nestedListMarkdown(nested: boolean): string {
  return nested
    ? `## Before you start

- **Parent**

    Child paragraph.

    - Nested bullet.
    1. Nested ordered.

## After

Stable paragraph.`
    : `## Before you start

- **Parent**

Child paragraph.

- Nested bullet.

1. Nested ordered.

## After

Stable paragraph.`;
}

function nestedListBlocks(state: 'flat' | 'created' | 'final') {
  const oldIds = ['old-parent', 'old-child', 'old-nested-bullet', 'old-nested-ordered'];
  const rootIds = state === 'flat'
    ? ['before-heading', ...oldIds, 'after-heading', 'after-text']
    : state === 'created'
      ? ['before-heading', 'new-parent', ...oldIds, 'after-heading', 'after-text']
      : ['before-heading', 'new-parent', 'after-heading', 'after-text'];
  const blocks = [
    { block_id: 'doc_token', block_type: 1, children: rootIds },
    {
      block_id: 'before-heading',
      block_type: 4,
      heading2: { elements: [{ text_run: { content: 'Before you start', text_element_style: {} } }] }
    },
    {
      block_id: 'after-heading',
      block_type: 4,
      heading2: { elements: [{ text_run: { content: 'After', text_element_style: {} } }] }
    },
    textBlock('after-text', 'Stable paragraph.')
  ];
  if (state !== 'final') {
    blocks.push(
      {
        block_id: 'old-parent',
        block_type: 12,
        bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
      },
      textBlock('old-child', 'Child paragraph.'),
      {
        block_id: 'old-nested-bullet',
        block_type: 12,
        bullet: { elements: [{ text_run: { content: 'Nested bullet.', text_element_style: {} } }] }
      },
      {
        block_id: 'old-nested-ordered',
        block_type: 13,
        ordered: { elements: [{ text_run: { content: 'Nested ordered.', text_element_style: {} } }] }
      }
    );
  }
  if (state !== 'flat') {
    blocks.push(
      {
        block_id: 'new-parent',
        block_type: 12,
        children: ['new-child', 'new-nested-bullet', 'new-nested-ordered'],
        bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
      },
      textBlock('new-child', 'Child paragraph.'),
      {
        block_id: 'new-nested-bullet',
        block_type: 12,
        bullet: { elements: [{ text_run: { content: 'Nested bullet.', text_element_style: {} } }] }
      },
      {
        block_id: 'new-nested-ordered',
        block_type: 13,
        ordered: { elements: [{ text_run: { content: 'Nested ordered.', text_element_style: {} } }] }
      }
    );
  }
  return blocks;
}

function nestedChildMarkdown(child: string): string {
  return `- **Parent**

    ${child}

    - Nested bullet.`;
}

function nestedChildBlocks(child: string) {
  return [
    { block_id: 'doc_token', block_type: 1, children: ['parent'] },
    {
      block_id: 'parent',
      block_type: 12,
      children: ['child', 'nested'],
      bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
    },
    textBlock('child', child),
    {
      block_id: 'nested',
      block_type: 12,
      bullet: { elements: [{ text_run: { content: 'Nested bullet.', text_element_style: {} } }] }
    }
  ];
}

function blocksForMarkdown(markdown: string, previous: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks']) {
  const page = previous.find((block) => block.block_type === 1);
  const parsed = markdownToFeishuBlocks(markdown);
  const body = parsed[0]?.block_type === 3 ? parsed.slice(1) : parsed;
  const usedPreviousIds = new Set<string>();
  const previousBody = previous.filter((block) => block.block_type !== 1);
  const withIds = body.map((block, index) => {
    const rendered = feishuBlocksToMarkdown([block]).trim();
    const preserved = previous.find((candidate) => {
      return candidate.block_id && !usedPreviousIds.has(candidate.block_id) &&
        candidate.block_type === block.block_type &&
        feishuBlocksToMarkdown([candidate]).trim() === rendered;
    });
    const positional = previousBody[index];
    const blockId = preserved?.block_id ?? (
      positional?.block_id && positional.block_type === block.block_type && !usedPreviousIds.has(positional.block_id)
        ? positional.block_id
        : undefined
    );
    if (blockId) usedPreviousIds.add(blockId);
    return { ...block, block_id: blockId ?? `after-${index}` };
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

function feishuTableBlocks(rows: Array<[string, string]>, tableId: string, boldHeaders = false) {
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
            text_element_style: row === 0 && boldHeaders
              ? { bold: true }
              : column === 0 && row > 0 ? { inline_code: true } : {}
          } }]
        }
      });
    });
  });
  return blocks as Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>['blocks'];
}
