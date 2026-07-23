import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  createDocumentSnapshot,
  createFeishuDocxEngine,
  prepareMutationBatch,
  preparedMutationBatchFingerprint,
  type DocxTransport,
  type DocumentSnapshot,
  type MutationIntent,
  type ProviderBlock,
  type ResourceStateEvidence,
  type VerifiedOperationEvidence,
} from '../src/index.js';

const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

function textBlock(blockId: string, text: string, parentId = 'root'): ProviderBlock {
  return {
    block_id: blockId,
    parent_id: parentId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: style } }],
      style: { align: 1 },
    },
  };
}

function snapshot(blocks: ProviderBlock[], revision = '1'): DocumentSnapshot {
  return createDocumentSnapshot({ documentId: 'doc-1', revision, blocks });
}

function baseBlocks(): ProviderBlock[] {
  return [
    { block_id: 'root', block_type: 1, children: ['a', 'b'] },
    textBlock('a', 'A'),
    textBlock('b', 'B'),
  ];
}

function paragraph(text: string) {
  return { kind: 'paragraph' as const, content: [{ kind: 'text' as const, text }] };
}

function prepared(before: DocumentSnapshot, operations: MutationIntent[]) {
  return prepareMutationBatch({
    snapshot: before,
    operations,
    idempotencyNamespace: 'recovery-test',
  });
}

function evidence(
  operationId: string,
  after: DocumentSnapshot,
  extras: Partial<VerifiedOperationEvidence> = {},
): VerifiedOperationEvidence {
  return {
    operationId,
    createdBlockIds: [],
    revision: after.revision,
    afterSnapshotHash: after.canonicalHash,
    verified: true,
    ...structuredClone(extras),
  };
}

class RecoveryTransport implements DocxTransport {
  writes = 0;
  fetches = 0;
  queries: string[] = [];
  raw = new Map<string, unknown>();

  constructor(readonly current: DocumentSnapshot) {}

  async resolveDocument() { return { documentId: 'doc-1' }; }
  async fetchBlocks(documentId: string) {
    expect(documentId).toBe('doc-1');
    this.fetches += 1;
    return {
      revision: this.current.revision,
      blocks: this.current.nodes.map((node) => structuredClone(node.raw) as ProviderBlock),
    };
  }
  async queryWhiteboard(token: string) {
    this.queries.push(token);
    if (!this.raw.has(token)) throw new Error(`unreadable ${token}`);
    return structuredClone(this.raw.get(token));
  }
  async replaceBlock(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async insertAfter(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async createChildren(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async moveAfter(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async deleteBlocks(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async createDocument(): Promise<never> { this.writes += 1; throw new Error('write called'); }
  async overwriteWhiteboard(): Promise<never> { this.writes += 1; throw new Error('write called'); }
}

describe('read-only recovery assessment', () => {
  it('returns the exact completed prefix and unchanged pending suffix', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [
      { operationId: 'replace-a', kind: 'replace', targetBlockId: 'a', expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated') },
      { operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash },
    ]);
    const blocks = baseBlocks();
    (blocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Updated';
    const after = snapshot(blocks, '2');
    const transport = new RecoveryTransport(after);

    const result = await createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-a', after)] },
    });

    expect(result).toEqual({
      disposition: 'resume_possible',
      completedOperationIds: ['replace-a'],
      pendingOperationIds: ['assert-b'],
    });
    expect(transport.writes).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts an exact recursive descendant graph and native table placement', async () => {
    const before = snapshot(baseBlocks());
    const nested = {
      kind: 'list' as const,
      ordered: false,
      items: [{
        content: [{ kind: 'text' as const, text: 'Parent' }],
        children: [{
          kind: 'list' as const,
          ordered: true,
          items: [{ content: [{ kind: 'text' as const, text: 'Child' }], children: [] }],
        }],
      }],
    };
    const table = {
      kind: 'table' as const,
      rows: [{ cells: [{ content: [paragraph('Cell')] }] }],
    };
    const batch = prepared(before, [
      { operationId: 'insert-tree', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [nested, table] },
      { operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash },
    ]);
    const blocks: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['a', 'list-1', 'table-1', 'b'] },
      textBlock('a', 'A'),
      { block_id: 'list-1', parent_id: 'root', block_type: 12, children: ['list-2'], bullet: textPayload('Parent') },
      { block_id: 'list-2', parent_id: 'list-1', block_type: 13, ordered: textPayload('Child') },
      { block_id: 'table-1', parent_id: 'root', block_type: 31, children: ['cell-1'], table: { cells: ['cell-1'], property: { row_size: 1, column_size: 1 } } },
      { block_id: 'cell-1', parent_id: 'table-1', block_type: 32, children: ['cell-text'] },
      textBlock('cell-text', 'Cell', 'cell-1'),
      textBlock('b', 'B'),
    ];
    const after = snapshot(blocks, '2');
    const transport = new RecoveryTransport(after);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: {
        prewriteSnapshot: before,
        completedOperations: [evidence('insert-tree', after, { createdBlockIds: ['list-1', 'list-2', 'table-1', 'cell-1', 'cell-text'] })],
      },
    })).resolves.toMatchObject({ disposition: 'resume_possible', completedOperationIds: ['insert-tree'] });
    expect(transport.writes).toBe(0);
  });

  it.each([
    ['extra block', () => {
      const blocks = baseBlocks();
      (blocks[0]!.children as string[]).splice(1, 0, 'extra');
      blocks.push(textBlock('extra', 'unexpected'));
      return snapshot(blocks, '2');
    }],
    ['changed anchor', () => {
      const blocks = baseBlocks();
      (blocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'changed';
      return snapshot(blocks, '2');
    }],
  ])('requires manual inspection for %s', async (_label, makeCurrent) => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [paragraph('New')],
    }]);
    const transport = new RecoveryTransport(makeCurrent());
    const result = await createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [] },
    });
    expect(result).toEqual({ disposition: 'manual_inspection_required', reason: 'unexpected_remote_change' });
    expect(transport.writes).toBe(0);
  });

  it('rejects a completed insert when its preceding anchor disappeared even if checkpoint hash matches', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [paragraph('New')],
    }, {
      operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash,
    }]);
    const current = snapshot([
      { block_id: 'root', block_type: 1, children: ['new-1', 'b'] },
      textBlock('new-1', 'New'),
      textBlock('b', 'B'),
    ], '2');
    const transport = new RecoveryTransport(current);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('insert', current, { createdBlockIds: ['new-1'] })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'unexpected_remote_change' });
    expect(transport.writes).toBe(0);
  });

  it('rejects changed parent semantics and unrelated sibling content even with a matching checkpoint hash', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [paragraph('New')],
    }, {
      operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash,
    }]);
    const changedParent: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['a', 'new-1', 'b'], page: textPayload('Changed title') },
      textBlock('a', 'A'),
      textBlock('new-1', 'New'),
      textBlock('b', 'B'),
    ];
    const changedSibling = structuredClone(changedParent);
    delete changedSibling[0]!.page;
    (changedSibling[3]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Changed B';

    for (const current of [snapshot(changedParent, '2'), snapshot(changedSibling, '2')]) {
      const transport = new RecoveryTransport(current);
      await expect(createFeishuDocxEngine({ transport }).assessRecovery({
        batch,
        checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('insert', current, { createdBlockIds: ['new-1'] })] },
      })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'unexpected_remote_change' });
      expect(transport.writes).toBe(0);
    }
  });

  it('rejects checkpoint hashes that self-report wrong replace and table content', async () => {
    const before = snapshot(baseBlocks());
    const replaceBatch = prepared(before, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Expected'),
    }, {
      operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash,
    }]);
    const wrongBlocks = baseBlocks();
    (wrongBlocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'WRONG';
    const wrongReplace = snapshot(wrongBlocks, '2');

    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(wrongReplace) }).assessRecovery({
      batch: replaceBatch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-a', wrongReplace)] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'unexpected_remote_change' });

    const tableBefore = snapshot([
      { block_id: 'root', block_type: 1, children: ['a', 'b'] },
      textBlock('a', 'A'),
      textBlock('b', 'B'),
    ]);
    const tableBatch = prepared(tableBefore, [{
      operationId: 'insert-table', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      desired: [{ kind: 'table', rows: [{ cells: [{ content: [paragraph('Expected')] }] }] }],
    }, {
      operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: tableBefore.nodes[2]!.canonicalHash,
    }]);
    const wrongTable = snapshot([
      { block_id: 'root', block_type: 1, children: ['a', 'table', 'b'] },
      textBlock('a', 'A'),
      ...tableBlocks('table', 'WRONG'),
      textBlock('b', 'B'),
    ], '2');
    const created = wrongTable.nodes.filter(({ blockId }) => blockId.startsWith('table')).map(({ blockId }) => blockId);
    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(wrongTable) }).assessRecovery({
      batch: tableBatch,
      checkpoint: { prewriteSnapshot: tableBefore, completedOperations: [evidence('insert-table', wrongTable, { createdBlockIds: created })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'unexpected_remote_change' });
  });

  it('rejects self-consistent Whiteboard evidence that does not match prepared raw', async () => {
    const blocks: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['board', 'tail'] },
      { block_id: 'board', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-token' } },
      textBlock('tail', 'Tail'),
    ];
    const before = snapshot(blocks);
    const desiredRaw = { nodes: [{ id: 'expected', type: 'text_shape', text: 'Expected' }] };
    const wrongRaw = { nodes: [{ id: 'wrong', type: 'text_shape', text: 'WRONG' }] };
    const batch = prepared(before, [{
      operationId: 'board', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: before.nodes[1]!.canonicalHash, desired: { kind: 'raw', value: desiredRaw },
    }, {
      operationId: 'assert-tail', kind: 'assert', blockId: 'tail', expectedHash: before.nodes[2]!.canonicalHash,
    }]);
    const resource = { resourceKind: 'whiteboard' as const, token: 'board-token', rawHash: canonicalHash(wrongRaw), raw: wrongRaw };
    const transport = new RecoveryTransport(before);
    transport.raw.set('board-token', wrongRaw);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('board', before, {
        prewriteResourceEvidence: [resource], verifiedResourceEvidence: [resource],
      })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'resource_state_mismatch' });
    expect(transport.writes).toBe(0);
  });

  it('infers an exact accepted operation before journal persistence, including after a journaled prefix', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated A'),
    }, {
      operationId: 'replace-b', kind: 'replace', targetBlockId: 'b',
      expectedHash: before.nodes[2]!.canonicalHash, desired: paragraph('Updated B'),
    }, {
      operationId: 'assert-root', kind: 'assert', blockId: 'root', expectedHash: before.nodes[0]!.canonicalHash,
    }]);
    const firstBlocks = baseBlocks();
    (firstBlocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Updated A';
    const afterFirst = snapshot(firstBlocks, '2');
    const secondBlocks = structuredClone(firstBlocks);
    (secondBlocks[2]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Updated B';
    const afterSecond = snapshot(secondBlocks, '3');

    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(afterFirst) }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [] },
    })).resolves.toEqual({
      disposition: 'resume_possible', completedOperationIds: ['replace-a'], pendingOperationIds: ['replace-b', 'assert-root'],
    });
    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(afterSecond) }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-a', afterFirst)] },
    })).resolves.toEqual({
      disposition: 'resume_possible', completedOperationIds: ['replace-a', 'replace-b'], pendingOperationIds: ['assert-root'],
    });
  });

  it('returns validated reverse intents for an exactly completed insert', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [paragraph('New')],
    }]);
    const blocks = baseBlocks();
    (blocks[0]!.children as string[]).splice(1, 0, 'new-1');
    blocks.push(textBlock('new-1', 'New'));
    const after = snapshot(blocks, '2');
    const transport = new RecoveryTransport(after);

    const result = await createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('insert', after, { createdBlockIds: ['new-1'] })] },
    });

    expect(result).toEqual({
      disposition: 'reverse_possible',
      reverseIntents: [{
        operationId: 'reverse:insert',
        kind: 'delete',
        parentBlockId: 'root',
        blockIds: ['new-1'],
        expectedHashes: [after.nodes.find(({ blockId }) => blockId === 'new-1')!.canonicalHash],
      }],
    });
    expect(transport.writes).toBe(0);
  });

  it('builds safe ordinary replace, delete, and move reversals', async () => {
    const cases: Array<{
      intent: (before: DocumentSnapshot) => MutationIntent;
      current: () => DocumentSnapshot;
      expected: Record<string, unknown>;
    }> = [
      {
        intent: (before) => ({
          operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
          expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated'),
        }),
        current: () => {
          const blocks = baseBlocks();
          (blocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Updated';
          return snapshot(blocks, '2');
        },
        expected: { kind: 'replace', targetBlockId: 'a', desired: paragraph('A') },
      },
      {
        intent: (before) => ({
          operationId: 'delete-a', kind: 'delete', parentBlockId: 'root', blockIds: ['a'],
          expectedHashes: [before.nodes[1]!.canonicalHash],
        }),
        current: () => snapshot([
          { block_id: 'root', block_type: 1, children: ['b'] },
          textBlock('b', 'B'),
        ], '2'),
        expected: { kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'root', insertBeforeBlockId: 'b', desired: [paragraph('A')] },
      },
      {
        intent: () => ({
          operationId: 'move-b', kind: 'move', parentBlockId: 'root', blockIds: ['b'], insertAfterBlockId: 'root',
        }),
        current: () => snapshot([
          { block_id: 'root', block_type: 1, children: ['b', 'a'] },
          textBlock('b', 'B'),
          textBlock('a', 'A'),
        ], '2'),
        expected: { kind: 'move', parentBlockId: 'root', blockIds: ['b'], insertAfterBlockId: 'a' },
      },
    ];

    for (const item of cases) {
      const before = snapshot(baseBlocks());
      const intent = item.intent(before);
      const batch = prepared(before, [intent]);
      const current = item.current();
      const transport = new RecoveryTransport(current);
      const result = await createFeishuDocxEngine({ transport }).assessRecovery({
        batch,
        checkpoint: { prewriteSnapshot: before, completedOperations: [evidence(intent.operationId, current)] },
      });
      expect(result).toMatchObject({
        disposition: 'reverse_possible',
        reverseIntents: [expect.objectContaining(item.expected)],
      });
      expect(transport.writes).toBe(0);
    }
  });

  it('does not reverse provider semantics that DesiredNode cannot represent', async () => {
    const blocks = baseBlocks();
    ((blocks[1]!.text as { style: { align: number } }).style).align = 2;
    const before = snapshot(blocks);
    const batch = prepared(before, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated'),
    }]);
    const currentBlocks = baseBlocks();
    (currentBlocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'Updated';
    const current = snapshot(currentBlocks, '2');

    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(current) }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-a', current)] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'reverse_not_exactly_representable' });
  });

  it('does not claim one move can reverse a non-contiguous original selection', async () => {
    const before = snapshot([
      { block_id: 'root', block_type: 1, children: ['a', 'b', 'c', 'd', 'e'] },
      ...['a', 'b', 'c', 'd', 'e'].map((id) => textBlock(id, id.toUpperCase())),
    ]);
    const batch = prepared(before, [{
      operationId: 'move', kind: 'move', parentBlockId: 'root', blockIds: ['b', 'd'], insertAfterBlockId: 'root',
    }]);
    const current = snapshot([
      { block_id: 'root', block_type: 1, children: ['b', 'd', 'a', 'c', 'e'] },
      ...['b', 'd', 'a', 'c', 'e'].map((id) => textBlock(id, id.toUpperCase())),
    ], '2');
    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(current) }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('move', current)] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'reverse_not_exactly_representable' });
  });

  it('reconstructs a native table from durable prewrite tree evidence', async () => {
    const oldTable = tableBlocks('old-table', 'Old');
    const before = snapshot([
      { block_id: 'root', block_type: 1, children: ['a', 'old-table', 'b'] },
      textBlock('a', 'A'),
      ...oldTable,
      textBlock('b', 'B'),
    ]);
    const batch = prepared(before, [{
      operationId: 'replace-table', kind: 'replace', targetBlockId: 'old-table',
      expectedHash: before.nodes.find(({ blockId }) => blockId === 'old-table')!.canonicalHash,
      desired: { kind: 'table', rows: [{ cells: [{ content: [paragraph('New')] }] }] },
    }]);
    const current = snapshot([
      { block_id: 'root', block_type: 1, children: ['a', 'new-table', 'b'] },
      textBlock('a', 'A'),
      ...tableBlocks('new-table', 'New'),
      textBlock('b', 'B'),
    ], '2');
    const created = current.nodes
      .filter(({ blockId }) => blockId.startsWith('new-table'))
      .map(({ blockId }) => blockId);
    const transport = new RecoveryTransport(current);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-table', current, { createdBlockIds: created })] },
    })).resolves.toMatchObject({
      disposition: 'reverse_possible',
      reverseIntents: [{ kind: 'replace', targetBlockId: 'new-table', desired: {
        kind: 'table', rows: [{ cells: [{ content: [paragraph('Old')] }] }],
      } }],
    });
    expect(transport.writes).toBe(0);
  });

  it('does not reverse a merged prewrite table into an unmerged representation', async () => {
    const merged = tableBlocks('old-table', 'Old');
    ((merged[0]!.table as { property: Record<string, unknown> }).property).merge_info = [{ row_span: 2, col_span: 1 }];
    const before = snapshot([
      { block_id: 'root', block_type: 1, children: ['old-table', 'b'] },
      ...merged,
      textBlock('b', 'B'),
    ]);
    const batch = prepared(before, [{
      operationId: 'replace-table', kind: 'replace', targetBlockId: 'old-table',
      expectedHash: before.nodes.find(({ blockId }) => blockId === 'old-table')!.canonicalHash,
      desired: { kind: 'table', rows: [{ cells: [{ content: [paragraph('New')] }] }] },
    }]);
    const current = snapshot([
      { block_id: 'root', block_type: 1, children: ['new-table', 'b'] },
      ...tableBlocks('new-table', 'New'),
      textBlock('b', 'B'),
    ], '2');
    const created = current.nodes.filter(({ blockId }) => blockId.startsWith('new-table')).map(({ blockId }) => blockId);
    await expect(createFeishuDocxEngine({ transport: new RecoveryTransport(current) }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('replace-table', current, { createdBlockIds: created })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'reverse_not_exactly_representable' });
  });

  it('reverses an existing Whiteboard only with readable durable prewrite raw evidence', async () => {
    const oldRaw = { nodes: [{ id: 'old', type: 'text_shape', text: 'Old' }] };
    const newRaw = { nodes: [{ id: 'new', type: 'text_shape', text: 'New' }] };
    const blocks: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['board'] },
      { block_id: 'board', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-token' } },
    ];
    const before = snapshot(blocks);
    const batch = prepared(before, [{
      operationId: 'board', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: before.nodes[1]!.canonicalHash, desired: { kind: 'raw', value: newRaw },
    }]);
    const after = snapshot(blocks, '2');
    const prewrite: ResourceStateEvidence = {
      resourceKind: 'whiteboard', token: 'board-token', rawHash: canonicalHash(oldRaw), raw: oldRaw,
    };
    const verified: ResourceStateEvidence = {
      resourceKind: 'whiteboard', token: 'board-token', rawHash: canonicalHash(newRaw), raw: newRaw,
    };
    const transport = new RecoveryTransport(after);
    transport.raw.set('board-token', newRaw);

    const result = await createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('board', after, {
        prewriteResourceEvidence: [prewrite], verifiedResourceEvidence: [verified],
      })] },
    });

    expect(result).toEqual({ disposition: 'reverse_possible', reverseIntents: [{
      operationId: 'reverse:board', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: after.nodes[1]!.canonicalHash, desired: { kind: 'raw', value: oldRaw },
    }] });
    expect(transport.queries).toEqual(['board-token']);
    expect(transport.writes).toBe(0);
  });

  it('fails closed for unreadable Whiteboard raw', async () => {
    const boardBlocks: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['board'] },
      { block_id: 'board', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-token' } },
    ];
    const before = snapshot(boardBlocks);
    const batch = prepared(before, [{
      operationId: 'board', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: before.nodes[1]!.canonicalHash, desired: { kind: 'raw', value: { nodes: [{ id: 'new' }] } },
    }]);
    const after = snapshot(boardBlocks, '2');
    const raw = { nodes: [{ id: 'new' }] };
    const transport = new RecoveryTransport(after);
    const resource = { resourceKind: 'whiteboard' as const, token: 'board-token', rawHash: canonicalHash(raw), raw };

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('board', after, {
        prewriteResourceEvidence: [resource], verifiedResourceEvidence: [resource],
      })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'resource_state_unreadable' });
    expect(transport.writes).toBe(0);
  });

  it('never claims an image-to-Whiteboard replacement can be reversed', async () => {
    const before = snapshot([
      { block_id: 'root', block_type: 1, children: ['image'] },
      { block_id: 'image', parent_id: 'root', block_type: 27, image: { token: 'image-token' } },
    ]);
    const batch = prepared(before, [{
      operationId: 'image-board', kind: 'whiteboard-overwrite', targetBlockId: 'image',
      expectedTargetHash: before.nodes[1]!.canonicalHash,
      desired: { kind: 'svg', value: '<svg><text>Diagram</text></svg>' },
    }]);
    const current = snapshot([
      { block_id: 'root', block_type: 1, children: ['board-new'] },
      { block_id: 'board-new', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-new-token' } },
    ], '2');
    const raw = { nodes: [{ id: 'diagram', type: 'text_shape', text: 'Diagram' }] };
    const verified = { resourceKind: 'whiteboard' as const, token: 'board-new-token', rawHash: canonicalHash(raw), raw };
    const transport = new RecoveryTransport(current);
    transport.raw.set('board-new-token', raw);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('image-board', current, {
        createdBlockIds: ['board-new'], verifiedResourceEvidence: [verified],
      })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'reverse_not_exactly_representable' });
    expect(transport.writes).toBe(0);
  });

  it('rejects ambiguous image-to-Whiteboard created roots and unrelated resource evidence', async () => {
    const before = snapshot([
      { block_id: 'root', block_type: 1, children: ['image', 'existing', 'tail'] },
      { block_id: 'image', parent_id: 'root', block_type: 27, image: { token: 'image-token' } },
      { block_id: 'existing', parent_id: 'root', block_type: 43, whiteboard: { token: 'existing-token' } },
      textBlock('tail', 'Tail'),
    ]);
    const batch = prepared(before, [{
      operationId: 'image-board', kind: 'whiteboard-overwrite', targetBlockId: 'image',
      expectedTargetHash: before.nodes[1]!.canonicalHash,
      desired: { kind: 'svg', value: '<svg><text>Diagram</text></svg>' },
    }, {
      operationId: 'assert-tail', kind: 'assert', blockId: 'tail', expectedHash: before.nodes.at(-1)!.canonicalHash,
    }]);
    const raw = { nodes: [{ id: 'diagram', type: 'text_shape', text: 'Diagram' }] };
    const makeEvidence = (token: string) => ({
      resourceKind: 'whiteboard' as const, token, rawHash: canonicalHash(raw), raw,
    });
    const extraCurrent = snapshot([
      { block_id: 'root', block_type: 1, children: ['board-new', 'extra-new', 'existing', 'tail'] },
      { block_id: 'board-new', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-new-token' } },
      textBlock('extra-new', 'extra'),
      { block_id: 'existing', parent_id: 'root', block_type: 43, whiteboard: { token: 'existing-token' } },
      textBlock('tail', 'Tail'),
    ], '2');
    const wrongTokenCurrent = snapshot([
      { block_id: 'root', block_type: 1, children: ['board-new', 'existing', 'tail'] },
      { block_id: 'board-new', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-new-token' } },
      { block_id: 'existing', parent_id: 'root', block_type: 43, whiteboard: { token: 'existing-token' } },
      textBlock('tail', 'Tail'),
    ], '2');

    const cases = [
      { current: extraCurrent, created: ['board-new', 'extra-new'], verified: makeEvidence('board-new-token') },
      { current: wrongTokenCurrent, created: ['board-new'], verified: makeEvidence('existing-token') },
    ];
    for (const item of cases) {
      const transport = new RecoveryTransport(item.current);
      transport.raw.set(item.verified.token, raw);
      await expect(createFeishuDocxEngine({ transport }).assessRecovery({
        batch,
        checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('image-board', item.current, {
          createdBlockIds: item.created, verifiedResourceEvidence: [item.verified],
        })] },
      })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'ambiguous_created_blocks' });
      expect(transport.writes).toBe(0);
    }
  });

  it('requires manual inspection for shape-only SVG recovery without independent content evidence', async () => {
    const blocks: ProviderBlock[] = [
      { block_id: 'root', block_type: 1, children: ['board'] },
      { block_id: 'board', parent_id: 'root', block_type: 43, whiteboard: { token: 'board-token' } },
    ];
    const before = snapshot(blocks);
    const batch = prepared(before, [{
      operationId: 'shape', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: before.nodes[1]!.canonicalHash,
      desired: { kind: 'svg', value: '<svg><rect width="10" height="10"/></svg>' },
    }]);
    const oldRaw = { nodes: [{ id: 'old', type: 'shape' }] };
    const currentRaw = { nodes: [{ id: 'rect', type: 'shape' }] };
    const prewrite = { resourceKind: 'whiteboard' as const, token: 'board-token', rawHash: canonicalHash(oldRaw), raw: oldRaw };
    const verified = { resourceKind: 'whiteboard' as const, token: 'board-token', rawHash: canonicalHash(currentRaw), raw: currentRaw };
    const transport = new RecoveryTransport(before);
    transport.raw.set('board-token', currentRaw);
    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('shape', before, {
        prewriteResourceEvidence: [prewrite], verifiedResourceEvidence: [verified],
      })] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'resource_state_mismatch' });
  });

  it('validates incompatible batches and contradictory checkpoints before fetching', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'assert-a', kind: 'assert', blockId: 'a', expectedHash: before.nodes[1]!.canonicalHash,
    }]);
    const incompatible = structuredClone(batch);
    incompatible.engineVersion = '99.0.0';
    incompatible.fingerprint = canonicalHash({
      schemaVersion: incompatible.schemaVersion,
      engineVersion: incompatible.engineVersion,
      documentId: incompatible.documentId,
      expectedRevision: incompatible.expectedRevision,
      beforeSnapshotHash: incompatible.beforeSnapshotHash,
      steps: incompatible.steps,
    });
    const transport = new RecoveryTransport(before);
    const engine = createFeishuDocxEngine({ transport });

    await expect(engine.assessRecovery({
      batch: incompatible,
      checkpoint: { prewriteSnapshot: before, completedOperations: [] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'unsupported_engine_version' });
    await expect(engine.assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [evidence('not-a-prefix', before)] },
    })).resolves.toEqual({ disposition: 'manual_inspection_required', reason: 'checkpoint_not_prefix' });
    expect(transport.fetches).toBe(0);
    expect(transport.writes).toBe(0);
  });

  it('accepts an engine 0.1.0 prepared batch and checkpoint after the 0.1.1 patch upgrade', async () => {
    const before = snapshot(baseBlocks());
    const batch = structuredClone(prepared(before, [{
      operationId: 'assert-a', kind: 'assert', blockId: 'a',
      expectedHash: before.nodes[1]!.canonicalHash,
    }]));
    batch.engineVersion = '0.1.0';
    batch.fingerprint = preparedMutationBatchFingerprint(batch);
    const transport = new RecoveryTransport(before);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: {
        prewriteSnapshot: before,
        completedOperations: [evidence('assert-a', before)],
      },
    })).resolves.toEqual({
      disposition: 'resume_possible',
      completedOperationIds: ['assert-a'],
      pendingOperationIds: [],
    });
    expect(transport.fetches).toBe(1);
    expect(transport.writes).toBe(0);
  });

  it('does not mutate inputs and keeps assert-only recovery resumable', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'assert-a', kind: 'assert', blockId: 'a', expectedHash: before.nodes[1]!.canonicalHash,
    }]);
    const checkpoint = { prewriteSnapshot: before, completedOperations: [evidence('assert-a', before)] };
    const original = JSON.stringify({ batch, checkpoint });
    const transport = new RecoveryTransport(before);

    await expect(createFeishuDocxEngine({ transport }).assessRecovery({ batch, checkpoint }))
      .resolves.toEqual({ disposition: 'resume_possible', completedOperationIds: ['assert-a'], pendingOperationIds: [] });
    expect(JSON.stringify({ batch, checkpoint })).toBe(original);
    expect(transport.writes).toBe(0);
  });

  it('keeps an earlier assert valid when a later completed step changes only its asserted parent structure', async () => {
    const before = snapshot(baseBlocks());
    const batch = prepared(before, [{
      operationId: 'assert-root', kind: 'assert', blockId: 'root', expectedHash: before.nodes[0]!.canonicalHash,
    }, {
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a', desired: [paragraph('New')],
    }, {
      operationId: 'assert-b', kind: 'assert', blockId: 'b', expectedHash: before.nodes[2]!.canonicalHash,
    }]);
    const blocks = baseBlocks();
    (blocks[0]!.children as string[]).splice(1, 0, 'new-1');
    blocks.push(textBlock('new-1', 'New'));
    const current = snapshot(blocks, '2');
    const transport = new RecoveryTransport(current);
    await expect(createFeishuDocxEngine({ transport }).assessRecovery({
      batch,
      checkpoint: { prewriteSnapshot: before, completedOperations: [
        evidence('assert-root', before),
        evidence('insert', current, { createdBlockIds: ['new-1'] }),
      ] },
    })).resolves.toEqual({
      disposition: 'resume_possible',
      completedOperationIds: ['assert-root', 'insert'],
      pendingOperationIds: ['assert-b'],
    });
  });
});

function textPayload(text: string) {
  return {
    elements: [{ text_run: { content: text, text_element_style: style } }],
    style: { align: 1 },
  };
}

function tableBlocks(blockId: string, text: string): ProviderBlock[] {
  return [
    {
      block_id: blockId,
      parent_id: 'root',
      block_type: 31,
      children: [`${blockId}-cell`],
      table: { cells: [`${blockId}-cell`], property: { row_size: 1, column_size: 1 } },
    },
    {
      block_id: `${blockId}-cell`,
      parent_id: blockId,
      block_type: 32,
      children: [`${blockId}-text`],
      table_cell: {},
    },
    textBlock(`${blockId}-text`, text, `${blockId}-cell`),
  ];
}
