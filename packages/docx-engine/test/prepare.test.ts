import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  ENGINE_VERSION,
  MutationPreflightError,
  prepareMutationBatch,
  type DocumentSnapshot,
  type MutationIntent,
  type PrepareMutationInput,
  type SnapshotNode,
} from '../src/index.js';

const ROOT_HASH = 'root-hash';
const FIRST_HASH = 'first-hash';
const SECOND_HASH = 'second-hash';
const NESTED_HASH = 'nested-hash';
const BOARD_HASH = 'board-hash';

function node(
  blockId: string,
  kind: SnapshotNode['kind'],
  canonicalHash: string,
  parentBlockId: string | undefined,
  childBlockIds: string[] = [],
  raw: Record<string, unknown> = {},
): SnapshotNode {
  return {
    blockId,
    ...(parentBlockId ? { parentBlockId } : {}),
    childBlockIds,
    blockType: kind === 'page' ? 1 : kind === 'whiteboard' ? 43 : 2,
    kind,
    canonicalHash,
    raw: { block_id: blockId, ...raw },
  };
}

function snapshot(): DocumentSnapshot {
  return {
    documentId: 'doc-1',
    revision: 'revision-7',
    rootBlockId: 'root',
    canonicalHash: 'before-snapshot-hash',
    nodes: [
      node('root', 'page', ROOT_HASH, undefined, ['first', 'second', 'board']),
      node('first', 'paragraph', FIRST_HASH, 'root', ['nested']),
      node('nested', 'paragraph', NESTED_HASH, 'first'),
      node('second', 'paragraph', SECOND_HASH, 'root'),
      node('board', 'whiteboard', BOARD_HASH, 'root', [], {
        block_type: 43,
        board: { token: 'target-board-token' },
      }),
    ],
  };
}

function paragraph(text: string) {
  return {
    kind: 'paragraph' as const,
    content: [{ kind: 'text' as const, text }],
  };
}

function validOperations(): MutationIntent[] {
  return [
    {
      operationId: 'replace-first',
      kind: 'replace',
      targetBlockId: 'first',
      expectedHash: FIRST_HASH,
      desired: paragraph('Updated'),
    },
    {
      operationId: 'insert-middle',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'first',
      insertBeforeBlockId: 'second',
      desired: [paragraph('Inserted')],
    },
    {
      operationId: 'assert-board',
      kind: 'assert',
      blockId: 'board',
      expectedHash: BOARD_HASH,
    },
  ];
}

function input(operations: MutationIntent[]): PrepareMutationInput {
  return {
    snapshot: snapshot(),
    operations,
    idempotencyNamespace: 'localization-run-1',
  };
}

function expectPreflightError(
  operations: MutationIntent[],
  code: MutationPreflightError['code'],
  expectedContext?: Record<string, unknown>,
): MutationPreflightError {
  try {
    prepareMutationBatch(input(operations));
  } catch (error) {
    expect(error).toBeInstanceOf(MutationPreflightError);
    const preflight = error as MutationPreflightError;
    expect(preflight.code).toBe(code);
    if (expectedContext) expect(preflight.context).toEqual(expect.objectContaining(expectedContext));
    return preflight;
  }
  throw new Error(`Expected prepareMutationBatch to fail with ${code}.`);
}

describe('prepareMutationBatch', () => {
  it('builds a deterministic immutable batch through the public engine API', () => {
    const prepareInput = input(validOperations());
    const before = structuredClone(prepareInput);

    const first = prepareMutationBatch(prepareInput);
    const second = prepareMutationBatch(structuredClone(prepareInput));
    const payload = {
      schemaVersion: 1 as const,
      engineVersion: ENGINE_VERSION,
      documentId: 'doc-1',
      expectedRevision: 'revision-7',
      beforeSnapshotHash: 'before-snapshot-hash',
      steps: first.steps,
    };

    expect(first).toEqual(second);
    expect(first).toEqual({ ...payload, fingerprint: canonicalHash(payload) });
    expect(first.steps.map((step) => [step.operationId, step.kind])).toEqual([
      ['replace-first', 'replace'],
      ['insert-middle', 'insert'],
      ['assert-board', 'assert'],
    ]);
    expect(first.steps.every((step) => /^[a-f0-9]{64}$/.test(step.idempotencyToken))).toBe(true);
    expect(prepareInput).toEqual(before);
    expect(first.steps[0]!.intent).not.toBe(prepareInput.operations[0]);
  });

  it('changes tokens for meaningful intent or namespace changes and fingerprints for operation order', () => {
    const operations = validOperations();
    const original = prepareMutationBatch(input(operations));
    const changedIntent = prepareMutationBatch(input([
      { ...operations[0]!, desired: paragraph('Meaningfully changed') },
      ...operations.slice(1),
    ]));
    const changedNamespace = prepareMutationBatch({
      ...input(operations),
      idempotencyNamespace: 'localization-run-2',
    });
    const reversed = prepareMutationBatch(input([...operations].reverse()));

    expect(changedIntent.steps[0]!.idempotencyToken).not.toBe(
      original.steps[0]!.idempotencyToken,
    );
    expect(changedNamespace.steps[0]!.idempotencyToken).not.toBe(
      original.steps[0]!.idempotencyToken,
    );
    expect(reversed.fingerprint).not.toBe(original.fingerprint);
    expect(reversed.steps.find((step) => step.operationId === 'replace-first')!.idempotencyToken)
      .toBe(original.steps[0]!.idempotencyToken);
  });

  it('requires a non-empty namespace and unique non-empty operation IDs', () => {
    expect(() => prepareMutationBatch({
      ...input(validOperations()),
      idempotencyNamespace: '  ',
    })).toThrowError(expect.objectContaining({ code: 'invalid_operation' }));

    expectPreflightError([
      { ...validOperations()[0]!, operationId: '  ' },
    ], 'invalid_operation', { field: 'operationId' });

    expectPreflightError([
      validOperations()[0]!,
      { ...validOperations()[2]!, operationId: 'replace-first' },
    ], 'duplicate_operation_id', { operationId: 'replace-first' });
  });

  it('validates replace and assert identities and exact canonical hashes', () => {
    expectPreflightError([{
      operationId: 'replace-missing',
      kind: 'replace',
      targetBlockId: 'missing',
      expectedHash: FIRST_HASH,
      desired: paragraph('Updated'),
    }], 'target_missing', { blockId: 'missing' });

    expectPreflightError([{
      operationId: 'replace-drifted',
      kind: 'replace',
      targetBlockId: 'first',
      expectedHash: 'stale-hash',
      desired: paragraph('Updated'),
    }], 'hash_mismatch', { blockId: 'first', actualHash: FIRST_HASH });

    expectPreflightError([{
      operationId: 'assert-drifted',
      kind: 'assert',
      blockId: 'second',
      expectedHash: 'stale-hash',
    }], 'hash_mismatch', { blockId: 'second', actualHash: SECOND_HASH });

    expectPreflightError([{
      operationId: 'replace-root-as-body',
      kind: 'replace',
      targetBlockId: 'root',
      expectedHash: ROOT_HASH,
      desired: paragraph('Not a page title'),
    }], 'invalid_operation', { targetBlockId: 'root' });

    expectPreflightError([{
      operationId: 'replace-malformed',
      kind: 'replace',
      targetBlockId: 'first',
      expectedHash: FIRST_HASH,
      desired: undefined,
    } as unknown as MutationIntent], 'invalid_operation');

    expect(() => prepareMutationBatch(input([{
      operationId: 'replace-title',
      kind: 'replace',
      targetBlockId: 'root',
      expectedHash: ROOT_HASH,
      desired: { kind: 'title', content: [{ kind: 'text', text: 'New title' }] },
    }]))).not.toThrow();
  });

  it('validates delete membership, identities, hashes, and root protection', () => {
    const validDelete: MutationIntent = {
      operationId: 'delete-second',
      kind: 'delete',
      parentBlockId: 'root',
      blockIds: ['second'],
      expectedHashes: [SECOND_HASH],
    };

    expect(() => prepareMutationBatch(input([validDelete]))).not.toThrow();
    expectPreflightError([{ ...validDelete, blockIds: [], expectedHashes: [] }], 'invalid_operation');
    expectPreflightError([{
      ...validDelete,
      blockIds: ['second', 'second'],
      expectedHashes: [SECOND_HASH, SECOND_HASH],
    }], 'duplicate_block_id', { blockId: 'second' });
    expectPreflightError([{
      ...validDelete,
      blockIds: ['root'],
      expectedHashes: [ROOT_HASH],
    }], 'root_mutation_forbidden', { blockId: 'root' });
    expectPreflightError([{ ...validDelete, parentBlockId: 'missing' }], 'parent_missing');
    expectPreflightError([{
      ...validDelete,
      parentBlockId: 'first',
    }], 'parent_mismatch', { blockId: 'second', actualParentBlockId: 'root' });
    expectPreflightError([{ ...validDelete, expectedHashes: [] }], 'invalid_operation', {
      blockCount: 1,
      hashCount: 0,
    });
    expectPreflightError([{ ...validDelete, expectedHashes: ['stale-hash'] }], 'hash_mismatch', {
      blockId: 'second',
      actualHash: SECOND_HASH,
    });
    expectPreflightError([{ ...validDelete, blockIds: ['missing'] }], 'target_missing', {
      blockId: 'missing',
    });
  });

  it('validates move membership, anchors, root protection, and self placement', () => {
    const validMove: MutationIntent = {
      operationId: 'move-second-first',
      kind: 'move',
      parentBlockId: 'root',
      blockIds: ['second'],
      insertAfterBlockId: 'root',
    };

    expect(() => prepareMutationBatch(input([validMove]))).not.toThrow();
    expectPreflightError([{ ...validMove, blockIds: [] }], 'invalid_operation');
    expectPreflightError([{ ...validMove, blockIds: ['second', 'second'] }], 'duplicate_block_id');
    expectPreflightError([{ ...validMove, blockIds: ['root'] }], 'root_mutation_forbidden');
    expectPreflightError([{ ...validMove, parentBlockId: 'missing' }], 'parent_missing');
    expectPreflightError([{ ...validMove, blockIds: ['nested'] }], 'parent_mismatch', {
      actualParentBlockId: 'first',
    });
    expectPreflightError([{ ...validMove, insertAfterBlockId: 'missing' }], 'anchor_missing');
    expectPreflightError([{ ...validMove, insertAfterBlockId: 'nested' }], 'parent_mismatch', {
      blockId: 'nested',
    });
    expectPreflightError([{ ...validMove, insertAfterBlockId: 'second' }], 'invalid_operation', {
      reason: 'moving_anchor',
    });
    expectPreflightError([{
      ...validMove,
      operationId: 'move-first-noop',
      blockIds: ['first'],
      insertAfterBlockId: 'root',
    }], 'invalid_operation', { reason: 'self_placement' });
  });

  it('validates insert boundaries and supports the parent start sentinel', () => {
    const validInsert: MutationIntent = {
      operationId: 'insert-middle',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'first',
      insertBeforeBlockId: 'second',
      desired: [paragraph('Inserted')],
    };

    expect(() => prepareMutationBatch(input([validInsert]))).not.toThrow();
    expect(() => prepareMutationBatch(input([{
      ...validInsert,
      operationId: 'insert-first',
      insertAfterBlockId: 'root',
      insertBeforeBlockId: 'first',
    }]))).not.toThrow();
    expectPreflightError([{ ...validInsert, parentBlockId: 'missing' }], 'parent_missing');
    expectPreflightError([{ ...validInsert, insertAfterBlockId: 'missing' }], 'anchor_missing');
    expectPreflightError([{ ...validInsert, insertAfterBlockId: 'nested' }], 'parent_mismatch');
    expectPreflightError([{ ...validInsert, insertBeforeBlockId: 'missing' }], 'anchor_missing');
    expectPreflightError([{ ...validInsert, insertBeforeBlockId: 'nested' }], 'parent_mismatch');
    expectPreflightError([{ ...validInsert, insertBeforeBlockId: 'board' }], 'non_adjacent_anchors', {
      insertAfterBlockId: 'first',
      insertBeforeBlockId: 'board',
    });
    expectPreflightError([{ ...validInsert, desired: [] }], 'invalid_operation');
    expectPreflightError([{
      ...validInsert,
      desired: [{ kind: 'title', content: [{ kind: 'text', text: 'Page title' }] }],
    }], 'invalid_operation', { desiredIndex: 0 });
  });

  it('accepts structured nodes through their proper codec boundary and rejects malformed desired data', () => {
    expect(() => prepareMutationBatch(input([{
      operationId: 'insert-table',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'second',
      desired: [{
        kind: 'table',
        rows: [{ cells: [{ content: [paragraph('Cell')] }] }],
      }],
    }]))).not.toThrow();

    expect(() => prepareMutationBatch(input([{
      operationId: 'replace-callout',
      kind: 'replace',
      targetBlockId: 'second',
      expectedHash: SECOND_HASH,
      desired: {
        kind: 'callout',
        calloutType: 'note',
        children: [paragraph('Note')],
      },
    }]))).not.toThrow();

    expectPreflightError([{
      operationId: 'insert-malformed-table',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'second',
      desired: [{ kind: 'table', rows: [] }],
    }], 'invalid_operation', { desiredIndex: 0 });
  });

  it('validates Whiteboard target identity, token, hash, and desired payload', () => {
    const validWhiteboard: MutationIntent = {
      operationId: 'mirror-board',
      kind: 'whiteboard-overwrite',
      targetBlockId: 'board',
      targetToken: 'target-board-token',
      expectedTargetHash: BOARD_HASH,
      desired: { kind: 'copy-token', sourceToken: 'source-board-token' },
    };

    expect(() => prepareMutationBatch(input([validWhiteboard]))).not.toThrow();
    expect(prepareMutationBatch(input([{
      ...validWhiteboard,
      targetBlockId: undefined,
    }])).steps[0]!.actions).toEqual([expect.objectContaining({
      kind: 'overwrite-whiteboard',
      targetBlockId: 'board',
      targetToken: 'target-board-token',
    })]);
    expectPreflightError([{ ...validWhiteboard, targetBlockId: 'missing' }], 'target_missing');
    expectPreflightError([{
      ...validWhiteboard,
      targetBlockId: 'second',
      expectedTargetHash: SECOND_HASH,
    }], 'invalid_operation', {
      actualKind: 'paragraph',
    });
    expectPreflightError([{ ...validWhiteboard, targetToken: 'wrong-token' }], 'invalid_operation', {
      actualTargetToken: 'target-board-token',
    });
    expectPreflightError([{ ...validWhiteboard, expectedTargetHash: 'stale-hash' }], 'hash_mismatch', {
      actualHash: BOARD_HASH,
    });
    expectPreflightError([{
      ...validWhiteboard,
      desired: { kind: 'copy-token', sourceToken: '' },
    }], 'invalid_operation', { field: 'desired.sourceToken' });
    expectPreflightError([{
      ...validWhiteboard,
      desired: { kind: 'svg', value: '' },
    }], 'invalid_operation', { field: 'desired.value' });
    expect(() => prepareMutationBatch(input([{
      ...validWhiteboard,
      desired: { kind: 'raw', value: { nodes: [{ id: '1' }] } },
    }]))).not.toThrow();
    expectPreflightError([{
      ...validWhiteboard,
      desired: { kind: 'raw', value: { callback: () => undefined } },
    }], 'invalid_operation', { field: 'desired.value' });
  });

  it('fails closed for an unknown operation kind with stable machine-readable context', () => {
    const malformed = {
      operationId: 'unknown-op',
      kind: 'future-operation',
    } as unknown as MutationIntent;

    expectPreflightError([malformed], 'invalid_operation', {
      operationId: 'unknown-op',
      kind: 'future-operation',
    });
  });

  it('wraps non-serializable intent data in the structured preflight taxonomy', () => {
    const malformed = {
      operationId: 'replace-nonserializable',
      kind: 'replace',
      targetBlockId: 'first',
      expectedHash: FIRST_HASH,
      desired: {
        ...paragraph('Updated'),
        callback: () => undefined,
      },
    } as unknown as MutationIntent;

    expectPreflightError([malformed], 'invalid_operation', { field: 'intent' });
  });
});
