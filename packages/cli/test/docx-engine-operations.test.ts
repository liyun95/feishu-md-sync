import { describe, expect, it, vi } from 'vitest';
import {
  canonicalHash,
  createDocumentSnapshot,
  EngineExecutionError,
  LarkCliProviderError,
  PartialMutationError,
  type VerifiedOperationEvidence,
} from 'feishu-docx-engine';
import { CliFailure } from '../src/core/cli-failure.js';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { DEFAULT_CALLOUT_CONFIG } from '../src/config/sync-config.js';
import { normalizeCliFailure } from '../src/core/cli-failure.js';
import {
  bridgeEngineCause,
  enginePartialWriteError,
  operationIdForScopedOperation,
  operationIdForWhiteboardOperation,
  scopedOperationToMutationIntents,
  whiteboardOperationToMutationIntent,
} from '../src/publish/docx-engine-operations.js';
import { createDocxEngineJournal } from '../src/publish/docx-engine-journal.js';
import type { ScopedPatchOperation } from '../src/publish/scoped-patch-plan.js';
import type { SemanticTable } from '../src/semantic/types.js';
import type { WhiteboardOperation } from '../src/whiteboards/whiteboard-plan.js';

const locator = { sectionPath: ['Section'], kind: 'text' as const, ordinal: 0 };

function snapshot() {
  return createDocumentSnapshot({
    documentId: 'doc',
    revision: '7',
    blocks: [
      {
        block_id: 'doc',
        block_type: 1,
        children: ['anchor', 'text', 'code', 'table', 'callout', 'callout-child', 'token', 'image', 'board'],
      },
      textBlock('anchor', 'Anchor'),
      textBlock('text', 'Old'),
      codeBlock('code', 'old()', 49, 'Keep me'),
      tableBlock('table'),
      { block_id: 'callout', block_type: 19, callout: { emoji_id: '📘' }, children: [] },
      textBlock('callout-child', 'Old child'),
      textBlock('token', '<Procedures>'),
      { block_id: 'image', block_type: 27, image: { token: 'image-token' } },
      { block_id: 'board', block_type: 43, whiteboard: { token: 'board-token' } },
    ],
  });
}

describe('Docx engine operation translation', () => {
  it('translates text, nested list, table, Callout, Code, and Procedures operations exactly', () => {
    const state = snapshot();
    const hash = (blockId: string) => state.nodes.find((node) => node.blockId === blockId)!.canonicalHash;
    const table: SemanticTable = {
      kind: 'table',
      locator: { ...locator, kind: 'table' },
      headers: [{ blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value: 'Name', marks: { bold: true } }] }] }],
      rows: [{ key: 'one', cells: [{ blocks: [{ kind: 'list', ordered: false, items: [[{ kind: 'text', value: 'One', marks: { code: true } }]] }] }] }],
      unsupported: [],
    };
    const operations: ScopedPatchOperation[] = [
      { kind: 'update', locator, parentBlockId: 'doc', remoteBlockId: 'text', desiredMarkdown: 'New **text**.' },
      {
        kind: 'create', locator: { ...locator, ordinal: 1 }, parentBlockId: 'doc', insertAfterBlockId: 'anchor',
        desiredMarkdown: '- Parent\n  - Child', desiredBlocks: [{ blockType: 12, markdown: 'Parent' }],
      },
      { kind: 'delete', locator: { ...locator, ordinal: 2 }, parentBlockId: 'doc', blockIds: ['text'] },
      { kind: 'table-replace', locator: table.locator, remoteBlockId: 'table', desiredTable: table, diff: { headerChanged: true, additions: [], updates: [], blockers: [] } },
      { kind: 'table-create', locator: { ...table.locator, ordinal: 1 }, parentBlockId: 'doc', insertAfterBlockId: 'anchor', insertBeforeBlockId: 'text', desiredTable: table },
      {
        kind: 'callout-create', locator: { ...locator, kind: 'callout' }, parentBlockId: 'doc', insertAfterBlockId: 'anchor',
        desiredCallout: { kind: 'callout', locator: { ...locator, kind: 'callout' }, calloutType: 'note', children: [{ ordinal: 0, blockType: 2, markdown: 'Body' }], unsupported: [] },
      },
      { kind: 'callout-title-update', locator: { ...locator, kind: 'callout' }, calloutBlockId: 'callout', remoteBlockId: 'callout-child', desiredMarkdown: 'Note' },
      { kind: 'callout-child-update', locator: { ...locator, kind: 'callout' }, calloutBlockId: 'callout', childOrdinal: 0, remoteBlockId: 'callout-child', desiredMarkdown: 'Updated child' },
      { kind: 'callout-child-create', locator: { ...locator, kind: 'callout' }, calloutBlockId: 'callout', childOrdinal: 1, insertAfterBlockId: 'callout', desiredChildren: [{ ordinal: 1, blockType: 2, markdown: 'New child' }], desiredMarkdown: 'New child' },
      { kind: 'callout-child-delete', locator: { ...locator, kind: 'callout' }, calloutBlockId: 'callout', childOrdinal: 0, blockIds: ['callout-child'] },
      { kind: 'callout-delete', locator: { ...locator, kind: 'callout' }, blockIds: ['callout'] },
      {
        kind: 'code-update', locator: { ...locator, kind: 'code' }, sourceLocator: { ...locator, kind: 'code' }, remoteBlockId: 'code',
        desiredCode: { kind: 'code', locator: { ...locator, kind: 'code' }, content: 'print(1)', sourceLanguage: 'py', resolvedLanguage: 'python', caption: 'Keep me', issues: [] },
      },
      {
        kind: 'code-create', locator: { ...locator, kind: 'code', ordinal: 1 }, afterLocator: locator,
        desiredCode: { kind: 'code', locator: { ...locator, kind: 'code', ordinal: 1 }, content: 'echo ok', sourceLanguage: 'sh', resolvedLanguage: 'shell', issues: [] },
      },
      {
        kind: 'code-move', locator: { ...locator, kind: 'code', ordinal: 1 }, sourceLocator: { ...locator, kind: 'code' }, remoteBlockId: 'code', afterLocator: locator,
        desiredCode: { kind: 'code', locator: { ...locator, kind: 'code', ordinal: 1 }, content: 'old()', sourceLanguage: 'py', resolvedLanguage: 'python', issues: [] },
      },
      { kind: 'code-delete', locator: { ...locator, kind: 'code' }, sourceLocator: { ...locator, kind: 'code' }, remoteBlockId: 'code' },
      { kind: 'authoring-token-create', locator: { ...locator, kind: 'authoring-token' }, token: '</Procedures>', parentBlockId: 'doc', insertAfterBlockId: 'anchor' },
      { kind: 'authoring-token-move', locator: { ...locator, kind: 'authoring-token' }, token: '<Procedures>', remoteBlockId: 'token', insertAfterBlockId: 'anchor' },
      { kind: 'authoring-token-delete', locator: { ...locator, kind: 'authoring-token' }, token: '<Procedures>', parentBlockId: 'doc', remoteBlockId: 'token' },
    ];

    const intents = operations.map((operation) => scopedOperationToMutationIntents({
      operation,
      snapshot: state,
      callouts: DEFAULT_CALLOUT_CONFIG,
      resolvedParentBlockId: 'doc',
      resolvedInsertAfterBlockId: 'anchor',
    }));

    expect(intents[0]).toEqual([{
      operationId: operationIdForScopedOperation(operations[0]!), kind: 'replace', targetBlockId: 'text',
      expectedHash: hash('text'), desired: { kind: 'paragraph', content: [
        { kind: 'text', text: 'New ' }, { kind: 'text', text: 'text', bold: true }, { kind: 'text', text: '.' },
      ] },
    }]);
    expect(intents[1]?.[0]).toMatchObject({ kind: 'insert', parentBlockId: 'doc', insertAfterBlockId: 'anchor', desired: [{ kind: 'list' }] });
    expect(intents[2]).toEqual([expect.objectContaining({ kind: 'delete', parentBlockId: 'doc', blockIds: ['text'], expectedHashes: [hash('text')] })]);
    expect(intents[3]).toMatchObject([{ kind: 'replace', targetBlockId: 'table', expectedHash: hash('table'), desired: { kind: 'table' } }]);
    expect(intents[4]).toMatchObject([{ kind: 'insert', insertBeforeBlockId: 'text', desired: [{ kind: 'table' }] }]);
    expect(intents[5]).toMatchObject([{ kind: 'insert', desired: [{ kind: 'callout', calloutType: 'note', title: 'Notes', children: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Body' }] }] }] }]);
    expect(intents[6]?.[0]).toMatchObject({ kind: 'replace', targetBlockId: 'callout-child', desired: { kind: 'paragraph' } });
    expect(intents[7]?.[0]).toMatchObject({ kind: 'replace', targetBlockId: 'callout-child', desired: { kind: 'paragraph' } });
    expect(intents[8]?.[0]).toMatchObject({ kind: 'insert', parentBlockId: 'callout', desired: [{ kind: 'paragraph' }] });
    expect(intents[9]?.[0]).toMatchObject({ kind: 'delete', parentBlockId: 'doc', blockIds: ['callout-child'] });
    expect(intents[10]?.[0]).toMatchObject({ kind: 'delete', parentBlockId: 'doc', blockIds: ['callout'] });
    expect(intents[11]).toMatchObject([{ kind: 'replace', targetBlockId: 'code', expectedHash: hash('code'), desired: { kind: 'code', language: 'python', text: 'print(1)', caption: 'Keep me' } }]);
    expect(intents[12]).toMatchObject([{ kind: 'insert', parentBlockId: 'doc', insertAfterBlockId: 'anchor', desired: [{ kind: 'code', language: 'shell', text: 'echo ok' }] }]);
    expect(intents[13]).toEqual([expect.objectContaining({ kind: 'move', parentBlockId: 'doc', blockIds: ['code'], insertAfterBlockId: 'anchor' })]);
    expect(intents[14]).toEqual([expect.objectContaining({ kind: 'delete', parentBlockId: 'doc', blockIds: ['code'], expectedHashes: [hash('code')] })]);
    expect(intents[15]?.[0]).toMatchObject({ kind: 'insert', desired: [{ kind: 'paragraph', content: [{ kind: 'text', text: '</Procedures>' }] }] });
    expect(intents[16]?.[0]).toMatchObject({ kind: 'move', blockIds: ['token'], insertAfterBlockId: 'anchor' });
    expect(intents[17]?.[0]).toMatchObject({ kind: 'delete', blockIds: ['token'], expectedHashes: [hash('token')] });
  });

  it('routes image-to-Whiteboard and tracked Whiteboard SVG writes through typed intents', () => {
    const state = snapshot();
    const create: WhiteboardOperation = {
      kind: 'whiteboard-create', assetKey: 'images/flow.png', locator: { ...locator, kind: 'asset' },
      placementFingerprint: 'place', remoteImageBlockId: 'image', svgPath: 'images/flow.svg', svgHash: 'svg-hash',
    };
    const update: WhiteboardOperation = {
      kind: 'whiteboard-update', assetKey: 'images/flow.png', locator: { ...locator, kind: 'asset' },
      placementFingerprint: 'place', blockId: 'board', whiteboardToken: 'board-token', svgPath: 'images/flow.svg', svgHash: 'svg-hash',
      remoteStateHash: 'remote-hash', reason: 'local-changed',
    };

    expect(whiteboardOperationToMutationIntent({ operation: create, snapshot: state, svg: '<svg><text>Flow</text></svg>' })).toEqual({
      operationId: operationIdForWhiteboardOperation(create), kind: 'whiteboard-overwrite', targetBlockId: 'image',
      expectedTargetHash: state.nodes.find((node) => node.blockId === 'image')!.canonicalHash,
      desired: { kind: 'svg', value: '<svg><text>Flow</text></svg>' },
    });
    expect(whiteboardOperationToMutationIntent({ operation: update, snapshot: state, svg: '<svg><text>Flow</text></svg>' })).toEqual({
      operationId: operationIdForWhiteboardOperation(update), kind: 'whiteboard-overwrite', targetBlockId: 'board', targetToken: 'board-token',
      expectedTargetHash: state.nodes.find((node) => node.blockId === 'board')!.canonicalHash,
      desired: { kind: 'svg', value: '<svg><text>Flow</text></svg>' },
    });
  });

  it('preserves continuation paragraphs and nested lists in list-item child order', () => {
    const operation: ScopedPatchOperation = {
      kind: 'create',
      locator,
      parentBlockId: 'doc',
      insertAfterBlockId: 'anchor',
      desiredMarkdown: '- Parent\n\n    Continuation.\n\n    - Child',
      desiredBlocks: [{ blockType: 12, markdown: 'Parent' }],
    };

    expect(scopedOperationToMutationIntents({
      operation,
      snapshot: snapshot(),
      callouts: DEFAULT_CALLOUT_CONFIG,
    })).toMatchObject([{
      kind: 'insert',
      desired: [{
        kind: 'list',
        items: [{
          children: [
            { kind: 'paragraph', content: [{ kind: 'text', text: 'Continuation.' }] },
            { kind: 'list', items: [{ content: [{ kind: 'text', text: 'Child' }] }] },
          ],
        }],
      }],
    }]);
  });
});

describe('Docx engine publish bridge', () => {
  it('composes one Lark CLI executor and identity across engine snapshot and mutation calls', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      identity: 'user',
      exec: async (args) => {
        calls.push(args);
        if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/docx/v1/documents/doc') {
          return { stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 7 } } }), stderr: '' };
        }
        if (args[0] === 'api' && args[1] === 'GET' && args[2]?.endsWith('/blocks')) {
          return { stdout: JSON.stringify({ ok: true, data: { items: [{ block_id: 'doc', block_type: 1, children: [] }], has_more: false } }), stderr: '' };
        }
        return { stdout: JSON.stringify({ ok: true, data: { revision: '8' } }), stderr: '' };
      },
    });

    await adapter.docxTransport.fetchBlocks('doc');
    await adapter.docxTransport.replaceBlock({
      documentId: 'doc', blockId: 'p1', content: '<p>Updated</p>', format: 'xml',
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((args) => args.slice(-2).join(' ') === '--as user')).toBe(true);
    expect(calls.filter((args) => args.includes('block_replace'))).toHaveLength(1);
    const blockRead = calls.find((args) => args[2]?.endsWith('/blocks'))!;
    expect(JSON.parse(blockRead[blockRead.indexOf('--params') + 1]!)).toMatchObject({
      document_revision_id: 7,
    });
  });

  it('preserves a structured provider envelope through an initial engine failure', () => {
    const provider = new LarkCliProviderError({
      type: 'network',
      subtype: 'rate_limited',
      code: 429001,
      message: 'Too many requests',
      hint: 'Retry later',
      retryable: true,
      missing_scopes: ['docx:document:write'],
      console_url: 'https://open.feishu.cn/app/cli_a',
    });
    const wrapped = new EngineExecutionError(
      'provider_failure',
      'Provider rejected the first mutation.',
      { operationId: 'first', cause: provider },
    );

    expect(normalizeCliFailure(bridgeEngineCause(wrapped)).details).toEqual({
      type: 'network',
      subtype: 'rate_limited',
      message: 'Too many requests',
      hint: 'Retry later',
      retryable: true,
      providerCode: 429001,
      missingScopes: ['docx:document:write'],
      consoleUrl: 'https://open.feishu.cn/app/cli_a',
    });
  });

  it('records verified engine evidence in checkpoint order without writing the product receipt', async () => {
    const completed: Array<{ kind: string }> = [];
    const verified: ScopedPatchOperation[] = [];
    const operation: ScopedPatchOperation = {
      kind: 'update', locator, parentBlockId: 'doc', remoteBlockId: 'text', desiredMarkdown: 'New',
    };
    const checkpoint = vi.fn(async () => {});
    const journal = createDocxEngineJournal({
      operationsById: new Map([[operationIdForScopedOperation(operation), operation]]),
      completedOperations: completed,
      verifiedOperations: verified,
      recordCheckpoint: checkpoint,
      summarize: (value) => ({ kind: value.kind }),
    });
    const evidence: VerifiedOperationEvidence = {
      operationId: operationIdForScopedOperation(operation), createdBlockIds: ['new'], revision: '8',
      afterSnapshotHash: canonicalHash('after'), verified: true,
    };

    await journal.recordVerified(evidence);

    expect(completed).toEqual([{ kind: 'update' }]);
    expect(verified).toEqual([operation]);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledWith(completed, verified);
  });

  it('preserves the existing PartialWriteError and CLI JSON envelope for engine partial evidence', () => {
    const operation: ScopedPatchOperation = {
      kind: 'update', locator, parentBlockId: 'doc', remoteBlockId: 'text', desiredMarkdown: 'New',
    };
    const operationId = operationIdForScopedOperation(operation);
    const cause = new CliFailure({ type: 'network', subtype: 'rate_limited', message: 'Too many requests', retryable: true });
    const partial = new PartialMutationError({
      batchFingerprint: 'batch', beforeSnapshotHash: 'before', lastObservedRevision: '8',
      completedOperations: [{ operationId, createdBlockIds: [], revision: '8', afterSnapshotHash: 'after', verified: true }],
      failedOperation: { operationId, kind: 'provider', message: cause.message, cause },
      pendingOperationIds: [], createdBlockIds: [], recoveryDisposition: 'resume_possible',
    }, { cause });
    const error = enginePartialWriteError({
      error: partial,
      operationsById: new Map([[operationId, operation]]),
      completedOperations: [],
      pendingAfter: [{ kind: 'whiteboard-update', assetKey: 'images/flow.png' }],
      recoveryCheckpoint: { written: true, revision: '8' },
      summarize: (value) => ({ kind: value.kind, locator: value.locator }),
    });

    expect(error).toMatchObject({
      name: 'PartialWriteError', receiptWritten: false, recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '8', completedOperations: [{ kind: 'update' }],
      failedOperation: { kind: 'update' }, pendingOperations: [{ kind: 'whiteboard-update' }],
    });
    expect(normalizeCliFailure(error).details.partialWrite).toMatchObject({
      receiptWritten: false,
      cause: { type: 'network', subtype: 'rate_limited', retryable: true },
    });
  });
});

function textBlock(blockId: string, text: string) {
  return {
    block_id: blockId, block_type: 2,
    text: { elements: [{ text_run: { content: text, text_element_style: {} } }], style: { align: 1 } },
  };
}

function codeBlock(blockId: string, text: string, language: number, caption?: string) {
  return {
    block_id: blockId, block_type: 14,
    code: { elements: [{ text_run: { content: text, text_element_style: {} } }], style: { language, ...(caption ? { caption } : {}) } },
  };
}

function tableBlock(blockId: string) {
  return {
    block_id: blockId, block_type: 31, children: [],
    table: { property: { row_size: 0, column_size: 0, merge_info: [] }, cells: [] },
  };
}
