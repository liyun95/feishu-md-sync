import { describe, expect, it, vi } from 'vitest';
import {
  canonicalHash,
  createDocumentSnapshot,
  createFeishuDocxEngine,
  EngineExecutionError,
  PartialMutationError,
  prepareMutationBatch,
  type DesiredNode,
  type DocxTransport,
  type MutationIntent,
  type MutationJournal,
  type OverwriteWhiteboardInput,
  type ProviderBlock,
  type VerifiedOperationEvidence,
} from '../src/index.js';

const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

function textPayload(text: string, overrides: Record<string, unknown> = {}) {
  return {
    elements: [{ text_run: { content: text, text_element_style: { ...style, ...overrides } } }],
    style: { align: 1 },
  };
}

function paragraphBlock(blockId: string, text: string, parentId = 'root'): ProviderBlock {
  return {
    block_id: blockId,
    parent_id: parentId,
    block_type: 2,
    text: textPayload(text),
  };
}

function paragraph(text: string): DesiredNode {
  return { kind: 'paragraph', content: [{ kind: 'text', text }] };
}

function desiredTable(): Extract<DesiredNode, { kind: 'table' }> {
  return {
    kind: 'table',
    rows: [
      { cells: [
        { content: [paragraph('Name')] },
        { content: [paragraph('Description')] },
      ] },
      { cells: [
        { content: [{ kind: 'paragraph', content: [{ kind: 'code', text: 'model' }] }] },
        { content: [{
          kind: 'list',
          ordered: false,
          items: [{
            content: [{ kind: 'text', text: 'Embedding model' }],
            children: [{
              kind: 'list',
              ordered: true,
              items: [{ content: [{ kind: 'text', text: 'Required' }], children: [] }],
            }],
          }],
        }] },
      ] },
    ],
  };
}

type OverwriteCall = OverwriteWhiteboardInput;

class ResourceTransport implements DocxTransport {
  readonly documentId = 'doc-resource';
  blocks: ProviderBlock[] = baseBlocks();
  revision = 1;
  replaceCalls: Parameters<DocxTransport['replaceBlock']>[0][] = [];
  insertCalls: Parameters<DocxTransport['insertAfter']>[0][] = [];
  queryCalls: string[] = [];
  overwriteCalls: OverwriteCall[] = [];
  rawByToken = new Map<string, unknown>([
    ['source-board', { version: 1, nodes: [{ id: 'source-text', type: 'text_shape', text: 'Source board' }] }],
    ['target-board', { version: 1, nodes: [{ id: 'target-old', type: 'text_shape', text: 'Old board' }] }],
  ]);
  tableCellMismatch = false;
  tableDimensionMismatch = false;
  tableMergeMismatch = false;
  tablePlacementDrift = false;
  surroundingDrift = false;
  tableThrowAfterWrite = false;
  whiteboardThrowAfterWrite = false;
  whiteboardRejectWithoutWrite = false;
  whiteboardAmbiguousReject = false;
  failQueryAfterOverwrite = false;
  failCreatedBoardQuery = false;
  imageReplacementAmbiguous = false;
  staleProviderRevision = false;
  futureProviderRevision = false;
  svgNoop = false;
  transientOverwriteFailures = 0;
  transientQueryFailures = 0;
  imageReplacementReadbackMisses = 0;
  imageReplacementReadbacks = 0;
  private imageReplacementBeforeBlocks: ProviderBlock[] | undefined;
  private nextId = 1;

  async resolveDocument(): Promise<{ documentId: string }> {
    return { documentId: this.documentId };
  }

  async fetchBlocks(documentId: string) {
    expect(documentId).toBe(this.documentId);
    if (this.imageReplacementBeforeBlocks) {
      this.imageReplacementReadbacks += 1;
      if (this.imageReplacementReadbackMisses > 0) {
        this.imageReplacementReadbackMisses -= 1;
        return {
          revision: String(this.revision),
          blocks: structuredClone(this.imageReplacementBeforeBlocks),
        };
      }
    }
    return { revision: String(this.revision), blocks: structuredClone(this.blocks) };
  }

  async replaceBlock(input: Parameters<DocxTransport['replaceBlock']>[0]) {
    this.replaceCalls.push(structuredClone(input));
    if (input.content.startsWith('<whiteboard type="svg">')) {
      this.replaceImage(input.blockId);
    } else if (input.content.startsWith('<table>')) {
      this.replaceTable(input.blockId);
    } else {
      throw new Error(`unexpected replace XML: ${input.content}`);
    }
    this.revision += 1;
    if (this.tableThrowAfterWrite) throw new Error('table provider response lost');
    return {
      revision: String(this.futureProviderRevision
        ? this.revision + 1
        : this.staleProviderRevision
          ? this.revision - 1
          : this.revision),
    };
  }

  async insertAfter(input: Parameters<DocxTransport['insertAfter']>[0]) {
    this.insertCalls.push(structuredClone(input));
    if (!input.content.startsWith('<table>')) throw new Error('expected table XML');
    const parent = this.find('root');
    const id = `table-${this.nextId++}`;
    const table = tableBlocks(id, desiredTable(), this.tableCellMismatch);
    this.mutateTableMetadata(table[0]!);
    this.blocks.push(...table);
    const children = parent.children as string[];
    const index = children.indexOf(input.blockId) + 1;
    children.splice(this.tablePlacementDrift ? index + 1 : index, 0, id);
    if (this.surroundingDrift) {
      (this.find('before').text as ReturnType<typeof textPayload>).elements[0]!.text_run.content = 'drift';
    }
    this.revision += 1;
    if (this.tableThrowAfterWrite) throw new Error('table provider response lost');
    return { revision: String(this.staleProviderRevision ? this.revision - 1 : this.revision) };
  }

  async createChildren(): Promise<never> { throw new Error('not used'); }
  async moveAfter(): Promise<never> { throw new Error('not used'); }
  async deleteBlocks(): Promise<never> { throw new Error('not used'); }
  async createDocument(): Promise<never> { throw new Error('not used'); }

  async queryWhiteboard(token: string): Promise<unknown> {
    this.queryCalls.push(token);
    if (this.transientQueryFailures > 0) {
      this.transientQueryFailures -= 1;
      throw Object.assign(new Error('whiteboard raw not ready'), {
        details: { subtype: 'whiteboard_raw_not_ready' },
      });
    }
    if (this.failQueryAfterOverwrite && this.overwriteCalls.length > 0 && token === 'target-board') {
      throw new Error('whiteboard readback unavailable');
    }
    if (this.failCreatedBoardQuery && token === 'board-new-1-token') {
      throw new Error('created Whiteboard raw unavailable');
    }
    const raw = this.rawByToken.get(token);
    if (raw === undefined) throw new Error(`missing raw state for ${token}`);
    return structuredClone(raw);
  }

  async overwriteWhiteboard(input: OverwriteCall): Promise<void> {
    this.overwriteCalls.push(structuredClone(input));
    if (this.transientOverwriteFailures > 0) {
      this.transientOverwriteFailures -= 1;
      throw Object.assign(new Error('4003101 doc is applying: whiteboard'), { code: 4003101 });
    }
    if (this.whiteboardRejectWithoutWrite) {
      throw Object.assign(new Error('provider rejected overwrite'), { writeAccepted: false });
    }
    if (this.whiteboardAmbiguousReject) throw new Error('provider response ambiguous');
    if (input.format === 'raw') {
      this.rawByToken.set(input.token, structuredClone(input.value));
    } else if (!this.svgNoop) {
      this.rawByToken.set(input.token, {
        version: 2,
        nodes: [{ id: 'svg-text', type: 'text_shape', text: svgText(input.value) }],
      });
    }
    if (this.whiteboardThrowAfterWrite) throw new Error('whiteboard response lost');
  }

  snapshot() {
    return createDocumentSnapshot({
      documentId: this.documentId,
      revision: String(this.revision),
      blocks: structuredClone(this.blocks),
    });
  }

  private find(blockId: string): ProviderBlock {
    const block = this.blocks.find(({ block_id }) => block_id === blockId);
    if (!block) throw new Error(`missing block ${blockId}`);
    return block;
  }

  private replaceTable(targetId: string): void {
    const target = this.find(targetId);
    const parent = this.find(target.parent_id!);
    const children = parent.children as string[];
    const index = children.indexOf(targetId);
    const removed = subtreeIds(this.blocks, targetId);
    this.blocks = this.blocks.filter(({ block_id }) => !removed.has(block_id!));
    const id = `table-${this.nextId++}`;
    const replacement = tableBlocks(id, desiredTable(), this.tableCellMismatch);
    this.mutateTableMetadata(replacement[0]!);
    this.blocks.push(...replacement);
    children.splice(index, 1, id);
    parent.children = children;
    if (this.tablePlacementDrift) children.reverse();
    if (this.surroundingDrift) {
      (this.find('after').text as ReturnType<typeof textPayload>).elements[0]!.text_run.content = 'drift';
    }
  }

  private mutateTableMetadata(table: ProviderBlock): void {
    const property = (table.table as { property: Record<string, unknown> }).property;
    if (this.tableDimensionMismatch) property.column_size = Number(property.column_size) + 1;
    if (this.tableMergeMismatch) {
      property.merge_info = [{ row_span: 1, col_span: 2 }, ...(
        property.merge_info as unknown[]
      ).slice(1)];
    }
  }

  private replaceImage(targetId: string): void {
    this.imageReplacementBeforeBlocks = structuredClone(this.blocks);
    const target = this.find(targetId);
    const parent = this.find(target.parent_id!);
    const children = parent.children as string[];
    const index = children.indexOf(targetId);
    this.blocks = this.blocks.filter(({ block_id }) => block_id !== targetId);
    const ids = this.imageReplacementAmbiguous ? ['board-new-1', 'board-new-2'] : ['board-new-1'];
    for (const id of ids) {
      this.blocks.push({
        block_id: id,
        parent_id: parent.block_id,
        block_type: 43,
        board: { token: `${id}-token` },
      });
      this.rawByToken.set(`${id}-token`, {
        nodes: [{ id: `${id}-shape`, type: 'text_shape', text: 'Diagram' }],
      });
    }
    children.splice(index, 1, ...ids);
    if (this.surroundingDrift) {
      (this.find('after').text as ReturnType<typeof textPayload>).elements[0]!.text_run.content = 'drift';
    }
  }
}

function baseBlocks(): ProviderBlock[] {
  return [
    { block_id: 'root', block_type: 1, children: ['before', 'old-table', 'image', 'board', 'after'] },
    paragraphBlock('before', 'Before'),
    ...tableBlocks('old-table', {
      kind: 'table',
      rows: [{ cells: [{ content: [paragraph('Old')] }] }],
    }),
    { block_id: 'image', parent_id: 'root', block_type: 27, image: { token: 'image-token' } },
    { block_id: 'board', parent_id: 'root', block_type: 43, board: { token: 'target-board' } },
    paragraphBlock('after', 'After'),
  ];
}

function tableBlocks(
  tableId: string,
  desired: Extract<DesiredNode, { kind: 'table' }>,
  mismatch = false,
): ProviderBlock[] {
  const rows = desired.rows.length;
  const columns = desired.rows[0]!.cells.length;
  const cellIds = Array.from({ length: rows * columns }, (_, index) => `${tableId}-cell-${index}`);
  const blocks: ProviderBlock[] = [{
    block_id: tableId,
    parent_id: 'root',
    block_type: 31,
    table: {
      property: {
        row_size: rows,
        column_size: columns,
        merge_info: Array.from({ length: rows * columns }, () => ({ row_span: 1, col_span: 1 })),
      },
      cells: cellIds,
    },
    children: cellIds,
  }];
  let cellIndex = 0;
  for (const row of desired.rows) {
    for (const cell of row.cells) {
      const cellId = cellIds[cellIndex]!;
      const content = mismatch && cellIndex === cellIds.length - 1
        ? [paragraph('WRONG')]
        : cell.content;
      const encoded = encodeCellContent(cellId, content);
      blocks.push({
        block_id: cellId,
        parent_id: tableId,
        block_type: 32,
        children: encoded.topLevelIds,
      }, ...encoded.blocks);
      cellIndex += 1;
    }
  }
  return blocks;
}

function encodeCellContent(parentId: string, content: DesiredNode[]): {
  topLevelIds: string[];
  blocks: ProviderBlock[];
} {
  const blocks: ProviderBlock[] = [];
  const topLevelIds: string[] = [];
  let next = 0;
  const create = (node: DesiredNode, parent: string): string[] => {
    if (node.kind === 'list') {
      return node.items.map((item) => {
        const id = `${parent}-item-${next++}`;
        const key = node.ordered ? 'ordered' : 'bullet';
        const childIds = item.children.flatMap((child) => create(child, id));
        blocks.push({
          block_id: id,
          parent_id: parent,
          block_type: node.ordered ? 13 : 12,
          [key]: textPayload(item.content.map(({ text }) => text).join('')),
          ...(childIds.length > 0 ? { children: childIds } : {}),
        });
        return id;
      });
    }
    const id = `${parent}-content-${next++}`;
    if (node.kind !== 'paragraph') throw new Error(`test encoder does not support ${node.kind}`);
    blocks.push({
      block_id: id,
      parent_id: parent,
      block_type: 2,
      text: {
        elements: node.content.map((item) => ({
          text_run: {
            content: item.text,
            text_element_style: item.kind === 'code' ? { ...style, inline_code: true } : style,
          },
        })),
        style: { align: 1 },
      },
    });
    return [id];
  };
  for (const node of content) topLevelIds.push(...create(node, parentId));
  return { topLevelIds, blocks };
}

function subtreeIds(blocks: ProviderBlock[], rootId: string): Set<string> {
  const byId = new Map(blocks.map((block) => [block.block_id!, block]));
  const ids = new Set<string>();
  const visit = (id: string): void => {
    if (ids.has(id)) return;
    ids.add(id);
    const block = byId.get(id);
    const children = block?.block_type === 31
      ? ((block.table as { cells?: string[] } | undefined)?.cells ?? [])
      : (block?.children ?? []).filter((child): child is string => typeof child === 'string');
    children.forEach(visit);
  };
  visit(rootId);
  return ids;
}

function svgText(svg: string): string {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/gi)].map((match) => match[1]).join(' ');
}

function journal(): MutationJournal & { entries: VerifiedOperationEvidence[] } {
  const entries: VerifiedOperationEvidence[] = [];
  return {
    entries,
    async recordVerified(evidence) {
      entries.push(structuredClone(evidence));
    },
  };
}

function prepare(transport: ResourceTransport, operations: MutationIntent[]) {
  return prepareMutationBatch({
    snapshot: transport.snapshot(),
    operations,
    idempotencyNamespace: 'table-whiteboard-test',
  });
}

async function apply(
  transport: ResourceTransport,
  operations: MutationIntent[],
  mutationJournal = journal(),
) {
  return createFeishuDocxEngine({ transport }).apply({
    batch: prepare(transport, operations),
    journal: mutationJournal,
  });
}

function insertTableIntent(): MutationIntent {
  return {
    operationId: 'insert-table',
    kind: 'insert',
    parentBlockId: 'root',
    insertAfterBlockId: 'before',
    insertBeforeBlockId: 'old-table',
    desired: [desiredTable()],
  };
}

function replaceTableIntent(transport: ResourceTransport): MutationIntent {
  return {
    operationId: 'replace-table',
    kind: 'replace',
    targetBlockId: 'old-table',
    expectedHash: transport.snapshot().nodes.find(({ blockId }) => blockId === 'old-table')!.canonicalHash,
    desired: desiredTable(),
  };
}

function boardIntent(
  transport: ResourceTransport,
  desired: Extract<MutationIntent, { kind: 'whiteboard-overwrite' }>['desired'],
  targetBlockId = 'board',
): MutationIntent {
  const target = transport.snapshot().nodes.find(({ blockId }) => blockId === targetBlockId)!;
  return {
    operationId: `board-${desired.kind}`,
    kind: 'whiteboard-overwrite',
    targetBlockId,
    ...(targetBlockId === 'board' ? { targetToken: 'target-board' } : {}),
    expectedTargetHash: target.canonicalHash,
    desired,
  };
}

describe('native table mutations', () => {
  it('inserts native table XML only at exact adjacent anchors and verifies every cell recursively', async () => {
    const transport = new ResourceTransport();
    const result = await apply(transport, [insertTableIntent()]);

    expect(transport.insertCalls).toEqual([expect.objectContaining({
      documentId: transport.documentId,
      blockId: 'before',
      format: 'xml',
      content: expect.stringMatching(/^<table>/),
    })]);
    expect(result.finalSnapshot.nodes.find(({ blockId }) => blockId === 'root')!.childBlockIds)
      .toEqual(['before', 'table-1', 'old-table', 'image', 'board', 'after']);
    expect(result.operations[0]!.createdBlockIds).toEqual(expect.arrayContaining([
      'table-1',
      'table-1-cell-0',
      'table-1-cell-3',
    ]));
  });

  it('replaces one table between exact adjacent anchors and reconciles a lost provider response', async () => {
    const transport = new ResourceTransport();
    transport.tableThrowAfterWrite = true;
    const result = await apply(transport, [replaceTableIntent(transport)]);

    expect(result.operations).toHaveLength(1);
    expect(result.finalSnapshot.nodes.find(({ blockId }) => blockId === 'root')!.childBlockIds)
      .toEqual(['before', 'table-1', 'image', 'board', 'after']);
  });

  it.each([
    ['cell mismatch', (transport: ResourceTransport) => { transport.tableCellMismatch = true; }],
    ['dimension mismatch', (transport: ResourceTransport) => { transport.tableDimensionMismatch = true; }],
    ['merge mismatch', (transport: ResourceTransport) => { transport.tableMergeMismatch = true; }],
    ['placement drift', (transport: ResourceTransport) => { transport.tablePlacementDrift = true; }],
    ['surrounding drift', (transport: ResourceTransport) => { transport.surroundingDrift = true; }],
    ['fixed revision mismatch', (transport: ResourceTransport) => { transport.staleProviderRevision = true; }],
  ])('fails closed on table %s and never journals the operation', async (_label, configure) => {
    const transport = new ResourceTransport();
    const mutationJournal = journal();
    configure(transport);

    await expect(apply(transport, [insertTableIntent()], mutationJournal)).rejects.toBeInstanceOf(PartialMutationError);
    expect(mutationJournal.entries).toEqual([]);
  });
});

describe('verified Whiteboard mutations', () => {
  it('copies source raw to the target token without translating it and records prewrite evidence', async () => {
    const transport = new ResourceTransport();
    const batch = prepare(transport, [boardIntent(transport, { kind: 'copy-token', sourceToken: 'source-board' })]);
    const result = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() });

    expect(transport.queryCalls).toEqual(['source-board', 'target-board', 'target-board']);
    expect(transport.overwriteCalls).toEqual([{
      token: 'target-board',
      format: 'raw',
      value: { version: 1, nodes: [{ id: 'source-text', type: 'text_shape', text: 'Source board' }] },
      idempotencyToken: batch.steps[0]!.idempotencyToken,
    }]);
    expect(canonicalHash(transport.rawByToken.get('target-board'))).toBe(
      canonicalHash(transport.rawByToken.get('source-board')),
    );
    expect(result.operations[0]).toMatchObject({
      resourceTokens: ['source-board', 'target-board'],
      prewriteResourceEvidence: [{
        resourceKind: 'whiteboard',
        token: 'target-board',
        rawHash: canonicalHash({
          version: 1,
          nodes: [{ id: 'target-old', type: 'text_shape', text: 'Old board' }],
        }),
        raw: {
          version: 1,
          nodes: [{ id: 'target-old', type: 'text_shape', text: 'Old board' }],
        },
      }],
    });
  });

  it('overwrites existing Whiteboard raw state and verifies canonical raw equality', async () => {
    const transport = new ResourceTransport();
    const desired = { version: 3, nodes: [{ id: 'new', type: 'text_shape', text: 'Recovered' }] };
    await apply(transport, [boardIntent(transport, { kind: 'raw', value: desired })]);

    expect(transport.overwriteCalls[0]).toMatchObject({
      token: 'target-board',
      format: 'raw',
      value: desired,
    });
    expect(canonicalHash(transport.rawByToken.get('target-board'))).toBe(canonicalHash(desired));
  });

  it('overwrites an existing Whiteboard from SVG and verifies nonempty changed raw with planned text', async () => {
    const transport = new ResourceTransport();
    await apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    })]);

    expect(transport.overwriteCalls[0]).toMatchObject({
      token: 'target-board',
      format: 'svg',
    });
    expect(transport.rawByToken.get('target-board')).toEqual(expect.objectContaining({
      nodes: [expect.objectContaining({ text: 'Diagram' })],
    }));
  });

  it('accepts an idempotent SVG replay when the unchanged raw already contains planned evidence', async () => {
    const transport = new ResourceTransport();
    transport.svgNoop = true;
    transport.rawByToken.set('target-board', {
      nodes: [{ id: 'existing', type: 'text_shape', text: 'Diagram' }],
    });

    const result = await apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    })]);

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.verifiedResourceEvidence?.[0]!.rawHash)
      .toBe(result.operations[0]!.prewriteResourceEvidence?.[0]!.rawHash);
  });

  it('accepts a shape-only SVG when provider readback is nonempty and changed', async () => {
    const transport = new ResourceTransport();
    const result = await apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><rect width="10" height="10"/></svg>',
    })]);

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.verifiedResourceEvidence?.[0]!.rawHash)
      .not.toBe(result.operations[0]!.prewriteResourceEvidence?.[0]!.rawHash);
  });

  it('retries transient applying updates and raw-not-ready queries with the same idempotency token', async () => {
    const transport = new ResourceTransport();
    transport.transientOverwriteFailures = 1;
    transport.transientQueryFailures = 1;
    const batch = prepare(transport, [boardIntent(transport, {
      kind: 'raw',
      value: { nodes: [{ id: 'retry', type: 'text_shape', text: 'Retry' }] },
    })]);

    const result = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() });

    expect(result.operations).toHaveLength(1);
    expect(transport.overwriteCalls).toHaveLength(2);
    expect(new Set(transport.overwriteCalls.map(({ idempotencyToken }) => idempotencyToken)))
      .toEqual(new Set([batch.steps[0]!.idempotencyToken]));
  });

  it('replaces an image with exact Whiteboard XML, discovers one token at the same position, and queries raw', async () => {
    const transport = new ResourceTransport();
    const result = await apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')]);

    expect(transport.replaceCalls).toEqual([expect.objectContaining({
      blockId: 'image',
      format: 'xml',
      content: '<whiteboard type="svg"><svg viewBox="0 0 100 100"><text>Diagram</text></svg></whiteboard>',
    })]);
    expect(transport.queryCalls).toEqual(['board-new-1-token']);
    expect(result.finalSnapshot.nodes.find(({ blockId }) => blockId === 'root')!.childBlockIds)
      .toEqual(['before', 'old-table', 'board-new-1', 'board', 'after']);
    expect(result.operations[0]).toMatchObject({
      createdBlockIds: ['board-new-1'],
      resourceTokens: ['board-new-1-token'],
    });
  });

  it('accepts a later image-replacement readback revision after exact structural and raw verification', async () => {
    const transport = new ResourceTransport();
    transport.staleProviderRevision = true;

    const result = await apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')]);

    expect(result.operations).toHaveLength(1);
    expect(result.finalSnapshot.revision).toBe('2');
    expect(transport.replaceCalls).toHaveLength(1);
  });

  it('waits for image-to-Whiteboard structure to materialize without repeating the replacement', async () => {
    vi.useFakeTimers();
    const transport = new ResourceTransport();
    transport.imageReplacementReadbackMisses = 2;
    try {
      const applying = apply(transport, [boardIntent(transport, {
        kind: 'svg',
        value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
      }, 'image')]);
      const resolved = expect(applying).resolves.toMatchObject({
        operations: [{
          createdBlockIds: ['board-new-1'],
          resourceTokens: ['board-new-1-token'],
          verified: true,
        }],
      });
      await vi.runAllTimersAsync();
      await resolved;
    } finally {
      vi.useRealTimers();
    }
    expect(transport.imageReplacementReadbacks).toBe(4);
    expect(transport.replaceCalls).toHaveLength(1);
  });

  it('keeps partial evidence when image-to-Whiteboard structure never materializes', async () => {
    vi.useFakeTimers();
    const transport = new ResourceTransport();
    transport.imageReplacementReadbackMisses = Number.MAX_SAFE_INTEGER;
    try {
      const applying = apply(transport, [boardIntent(transport, {
        kind: 'svg',
        value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
      }, 'image')]);
      const rejected = expect(applying).rejects.toMatchObject({
        name: 'PartialMutationError',
        evidence: {
          failedOperation: {
            operationId: 'board-svg',
            kind: 'verification',
            message: 'Image replacement did not produce one identifiable Whiteboard block.',
          },
          createdBlockIds: [],
          pendingOperationIds: [],
          recoveryDisposition: 'manual_inspection_required',
        },
      });
      await vi.runAllTimersAsync();
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(transport.imageReplacementReadbacks).toBe(8);
    expect(transport.replaceCalls).toHaveLength(1);
  });

  it('fails closed when image-replacement readback is behind the provider revision', async () => {
    const transport = new ResourceTransport();
    transport.futureProviderRevision = true;
    const mutationJournal = journal();

    await expect(apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')], mutationJournal)).rejects.toBeInstanceOf(PartialMutationError);
    expect(mutationJournal.entries).toEqual([]);
    expect(transport.replaceCalls).toHaveLength(1);
  });

  it('rejects unrelated document drift even when image-replacement readback advanced past the provider revision', async () => {
    const transport = new ResourceTransport();
    transport.staleProviderRevision = true;
    transport.surroundingDrift = true;
    const mutationJournal = journal();

    await expect(apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')], mutationJournal)).rejects.toBeInstanceOf(PartialMutationError);
    expect(mutationJournal.entries).toEqual([]);
    expect(transport.replaceCalls).toHaveLength(1);
    expect(transport.imageReplacementReadbacks).toBe(1);
  });

  it('returns manual partial evidence after an accepted overwrite whose readback is unavailable', async () => {
    const transport = new ResourceTransport();
    transport.failQueryAfterOverwrite = true;
    let thrown: unknown;
    try {
      await apply(transport, [boardIntent(transport, {
        kind: 'raw',
        value: { nodes: [{ id: 'new' }] },
      })]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'PartialMutationError',
      evidence: {
        failedOperation: { operationId: 'board-raw' },
        resourceTokens: ['target-board'],
        prewriteResourceEvidence: [{
          resourceKind: 'whiteboard',
          token: 'target-board',
          rawHash: expect.any(String),
        }],
        recoveryDisposition: 'manual_inspection_required',
      },
    });
  });

  it('reconciles an ambiguous accepted overwrite only when exact raw readback matches', async () => {
    const transport = new ResourceTransport();
    transport.whiteboardThrowAfterWrite = true;
    const result = await apply(transport, [boardIntent(transport, {
      kind: 'raw',
      value: { nodes: [{ id: 'new', type: 'text_shape', text: 'New' }] },
    })]);

    expect(result.operations).toHaveLength(1);
  });

  it('treats explicit no-write rejection as safe but ambiguous unchanged state as manual partial', async () => {
    const rejected = new ResourceTransport();
    rejected.whiteboardRejectWithoutWrite = true;
    await expect(apply(rejected, [boardIntent(rejected, {
      kind: 'raw',
      value: { nodes: [{ id: 'new' }] },
    })])).rejects.toMatchObject({
      name: 'EngineExecutionError',
      code: 'provider_failure',
    } satisfies Partial<EngineExecutionError>);

    const ambiguous = new ResourceTransport();
    ambiguous.whiteboardAmbiguousReject = true;
    await expect(apply(ambiguous, [boardIntent(ambiguous, {
      kind: 'raw',
      value: { nodes: [{ id: 'new' }] },
    })])).rejects.toMatchObject({
      name: 'PartialMutationError',
      evidence: { recoveryDisposition: 'manual_inspection_required' },
    });
  });

  it('fails before overwrite when copy source raw is empty and fails on ambiguous image replacement', async () => {
    const empty = new ResourceTransport();
    empty.rawByToken.set('source-board', { nodes: [] });
    await expect(apply(empty, [boardIntent(empty, {
      kind: 'copy-token',
      sourceToken: 'source-board',
    })])).rejects.toBeInstanceOf(EngineExecutionError);
    expect(empty.overwriteCalls).toEqual([]);

    const ambiguous = new ResourceTransport();
    ambiguous.imageReplacementAmbiguous = true;
    await expect(apply(ambiguous, [boardIntent(ambiguous, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')])).rejects.toBeInstanceOf(PartialMutationError);
    expect(ambiguous.imageReplacementReadbacks).toBe(1);
    expect(ambiguous.replaceCalls).toHaveLength(1);
  });

  it('never journals image replacement when provider response is lost and raw verification fails', async () => {
    const transport = new ResourceTransport();
    transport.tableThrowAfterWrite = true;
    transport.failCreatedBoardQuery = true;
    const mutationJournal = journal();

    await expect(apply(transport, [boardIntent(transport, {
      kind: 'svg',
      value: '<svg viewBox="0 0 100 100"><text>Diagram</text></svg>',
    }, 'image')], mutationJournal)).rejects.toBeInstanceOf(PartialMutationError);
    expect(mutationJournal.entries).toEqual([]);
  });
});
