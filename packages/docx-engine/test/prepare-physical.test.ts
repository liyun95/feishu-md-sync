import { describe, expect, it } from 'vitest';
import {
  assertPreparedMutationBatchIntegrity,
  canonicalHash,
  MutationPreflightError,
  preparedMutationBatchFingerprint,
  prepareMutationBatch,
  type DocumentSnapshot,
  type MutationIntent,
  type PreparedMutationBatch,
  type SnapshotNode,
} from '../src/index.js';

const plainStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

function textBlock(content: string) {
  return {
    block_type: 2,
    text: {
      elements: [{
        text_run: {
          content,
          text_element_style: plainStyle,
        },
      }],
      style: { align: 1 },
    },
  };
}

function node(
  blockId: string,
  kind: SnapshotNode['kind'],
  blockType: number,
  canonicalHash: string,
  parentBlockId: string | undefined,
  childBlockIds: string[] = [],
  raw: Record<string, unknown> = {},
): SnapshotNode {
  return {
    blockId,
    ...(parentBlockId ? { parentBlockId } : {}),
    childBlockIds,
    blockType,
    kind,
    canonicalHash,
    raw: { block_id: blockId, block_type: blockType, ...raw },
  };
}

function snapshot(extraNodes: SnapshotNode[] = []): DocumentSnapshot {
  const childIds = ['a', 'b', 'c', 'd', 'image', 'board', ...extraNodes.map(({ blockId }) => blockId)];
  return {
    documentId: 'doc-physical',
    revision: 'revision-9',
    rootBlockId: 'root',
    canonicalHash: 'snapshot-hash',
    nodes: [
      node('root', 'page', 1, 'hash-root', undefined, childIds),
      node('a', 'paragraph', 2, 'hash-a', 'root'),
      node('b', 'paragraph', 2, 'hash-b', 'root'),
      node('c', 'paragraph', 2, 'hash-c', 'root'),
      node('d', 'paragraph', 2, 'hash-d', 'root'),
      node('image', 'opaque', 27, 'hash-image', 'root', [], {
        image: { token: 'image-token' },
      }),
      node('board', 'whiteboard', 43, 'hash-board', 'root', [], {
        board: { token: 'board-token' },
      }),
      ...extraNodes,
    ],
  };
}

function paragraph(text: string) {
  return {
    kind: 'paragraph' as const,
    content: [{ kind: 'text' as const, text }],
  };
}

function prepare(operations: MutationIntent[], document = snapshot()) {
  return prepareMutationBatch({
    snapshot: document,
    operations,
    idempotencyNamespace: 'run-physical',
  });
}

function expectCode(
  operation: MutationIntent,
  code: MutationPreflightError['code'],
  document = snapshot(),
) {
  expect(() => prepare([operation], document)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe('compiled mutation steps', () => {
  it('compiles replace into an exact provider block action and physical assertions', () => {
    const desired = paragraph('Updated body');
    const batch = prepare([{
      operationId: 'replace-a',
      kind: 'replace',
      targetBlockId: 'a',
      expectedHash: 'hash-a',
      desired,
    }]);

    expect(batch.steps[0]).toEqual(expect.objectContaining({
      operationId: 'replace-a',
      kind: 'replace',
      intent: {
        operationId: 'replace-a',
        kind: 'replace',
        targetBlockId: 'a',
        expectedHash: 'hash-a',
        desired,
      },
      actions: [{
        kind: 'replace-provider-block',
        targetBlockId: 'a',
        block: textBlock('Updated body'),
      }],
      assertions: {
        preflight: [
          { kind: 'target-hash', blockId: 'a', expectedHash: 'hash-a' },
          {
            kind: 'target-type',
            blockId: 'a',
            expectedKind: 'paragraph',
            expectedBlockType: 2,
          },
          {
            kind: 'parent-children',
            parentBlockId: 'root',
            expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
          },
          {
            kind: 'sibling-boundary',
            parentBlockId: 'root',
            precedingBlockId: 'root',
            followingBlockId: 'b',
            blockIds: ['a'],
          },
        ],
        readback: [{
          kind: 'desired-node',
          targetBlockId: 'a',
          desiredHash: canonicalHash(desired),
        }],
      },
    }));
  });

  it('preserves mixed desired order as exact provider-block and XML insert segments', () => {
    const desired = [
      paragraph('Before table'),
      {
        kind: 'table' as const,
        rows: [{ cells: [{ content: [paragraph('Cell')] }] }],
      },
      {
        kind: 'callout' as const,
        calloutType: 'note',
        title: 'Remember',
        children: [paragraph('Inside')],
      },
      {
        kind: 'list' as const,
        ordered: false,
        items: [{
          content: [{ kind: 'text' as const, text: 'Item' }],
          children: [],
        }],
      },
    ];
    const batch = prepare([{
      operationId: 'insert-mixed',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b',
      desired,
    }]);

    expect(batch.steps[0]!.actions).toEqual([{
      kind: 'insert-segments',
      parentBlockId: 'root',
      insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b',
      segments: [
        { kind: 'provider-blocks', desiredIndex: 0, blocks: [textBlock('Before table')] },
        {
          kind: 'xml',
          desiredIndex: 1,
          nodeKind: 'table',
          xml: '<table><thead><tr><th><p>Cell</p></th></tr></thead><tbody></tbody></table>',
        },
        {
          kind: 'xml',
          desiredIndex: 2,
          nodeKind: 'callout',
          xml: '<callout emoji="📘" background-color="light-orange" border-color="orange">' +
            '<p>Remember</p><p>Inside</p></callout>',
        },
        {
          kind: 'provider-blocks',
          desiredIndex: 3,
          blocks: [{
            block_type: 12,
            bullet: {
              elements: [{
                text_run: {
                  content: 'Item',
                  text_element_style: plainStyle,
                },
              }],
              style: {},
            },
          }],
        },
      ],
    }]);
    expect(batch.steps[0]!.assertions).toEqual({
      preflight: [
        {
          kind: 'parent-children',
          parentBlockId: 'root',
          expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
        },
        {
          kind: 'insertion-boundary',
          parentBlockId: 'root',
          precedingBlockId: 'a',
          followingBlockId: 'b',
        },
      ],
      readback: [{
        kind: 'inserted-desired',
        parentBlockId: 'root',
        precedingBlockId: 'a',
        followingBlockId: 'b',
        desiredHash: canonicalHash(desired),
      }],
    });
  });

  it('requires increasing adjacent delete targets and compiles exact sibling boundaries', () => {
    const operation: MutationIntent = {
      operationId: 'delete-bc',
      kind: 'delete',
      parentBlockId: 'root',
      blockIds: ['b', 'c'],
      expectedHashes: ['hash-b', 'hash-c'],
    };
    const batch = prepare([operation]);

    expect(batch.steps[0]!.actions).toEqual([{
      kind: 'delete-blocks',
      parentBlockId: 'root',
      blockIds: ['b', 'c'],
    }]);
    expect(batch.steps[0]!.assertions).toEqual({
      preflight: [
        { kind: 'target-hash', blockId: 'b', expectedHash: 'hash-b' },
        { kind: 'block-parent', blockId: 'b', expectedParentBlockId: 'root' },
        { kind: 'target-hash', blockId: 'c', expectedHash: 'hash-c' },
        { kind: 'block-parent', blockId: 'c', expectedParentBlockId: 'root' },
        {
          kind: 'parent-children',
          parentBlockId: 'root',
          expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
        },
        {
          kind: 'sibling-boundary',
          parentBlockId: 'root',
          precedingBlockId: 'a',
          followingBlockId: 'd',
          blockIds: ['b', 'c'],
        },
      ],
      readback: [{ kind: 'blocks-absent', blockIds: ['b', 'c'] }],
    });

    expectCode({ ...operation, blockIds: ['c', 'b'], expectedHashes: ['hash-c', 'hash-b'] },
      'invalid_operation');
    expectCode({ ...operation, blockIds: ['a', 'c'], expectedHashes: ['hash-a', 'hash-c'] },
      'invalid_operation');
  });

  it('compiles move and assert operations with ordered physical and readback assertions', () => {
    const batch = prepare([
      {
        operationId: 'move-bc-first',
        kind: 'move',
        parentBlockId: 'root',
        blockIds: ['b', 'c'],
        insertAfterBlockId: 'root',
      },
      {
        operationId: 'assert-d',
        kind: 'assert',
        blockId: 'd',
        expectedHash: 'hash-d',
      },
    ]);

    expect(batch.steps[0]!.actions).toEqual([{
      kind: 'move-blocks',
      parentBlockId: 'root',
      blockIds: ['b', 'c'],
      insertAfterBlockId: 'root',
    }]);
    expect(batch.steps[0]!.assertions.preflight).toEqual([
      { kind: 'block-parent', blockId: 'b', expectedParentBlockId: 'root' },
      { kind: 'block-parent', blockId: 'c', expectedParentBlockId: 'root' },
      {
        kind: 'parent-children',
        parentBlockId: 'root',
        expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
      },
      {
        kind: 'insertion-boundary',
        parentBlockId: 'root',
        precedingBlockId: 'root',
        followingBlockId: 'a',
      },
    ]);
    expect(batch.steps[0]!.assertions.readback).toEqual([{
      kind: 'sibling-order',
      parentBlockId: 'root',
      expectedChildBlockIds: ['b', 'c', 'a', 'd', 'image', 'board'],
    }]);
    expect(batch.steps[1]!.actions).toEqual([{ kind: 'assert-node', blockId: 'd' }]);
    expect(batch.steps[1]!.assertions).toEqual({
      preflight: [
        { kind: 'target-hash', blockId: 'd', expectedHash: 'hash-d' },
        {
          kind: 'target-type',
          blockId: 'd',
          expectedKind: 'paragraph',
          expectedBlockType: 2,
        },
      ],
      readback: [{ kind: 'node-hash', blockId: 'd', expectedHash: 'hash-d' }],
    });
  });
});

describe('Whiteboard operation shapes', () => {
  it('compiles existing Whiteboard overwrite using the resolved real resource token', () => {
    const desired = { kind: 'copy-token' as const, sourceToken: 'source-board-token' };
    const batch = prepare([{
      operationId: 'mirror-board',
      kind: 'whiteboard-overwrite',
      targetBlockId: 'board',
      expectedTargetHash: 'hash-board',
      desired,
    }]);

    expect(batch.steps[0]!.actions).toEqual([{
      kind: 'overwrite-whiteboard',
      targetBlockId: 'board',
      targetToken: 'board-token',
      desired,
    }]);
    expect(batch.steps[0]!.assertions.preflight).toEqual([
      { kind: 'target-hash', blockId: 'board', expectedHash: 'hash-board' },
      {
        kind: 'target-type',
        blockId: 'board',
        expectedKind: 'whiteboard',
        expectedBlockType: 43,
      },
      {
        kind: 'parent-children',
        parentBlockId: 'root',
        expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
      },
      {
        kind: 'sibling-boundary',
        parentBlockId: 'root',
        precedingBlockId: 'image',
        blockIds: ['board'],
      },
      {
        kind: 'resource-token',
        blockId: 'board',
        resourceKind: 'whiteboard',
        expectedToken: 'board-token',
      },
    ]);
    expect(batch.steps[0]!.assertions.readback).toEqual([{
      kind: 'whiteboard-content',
      targetBlockId: 'board',
      targetToken: 'board-token',
      desiredHash: canonicalHash(desired),
    }]);
  });

  it('compiles SVG replacement of an image-compatible block without a target token', () => {
    const batch = prepare([{
      operationId: 'replace-image-svg',
      kind: 'whiteboard-overwrite',
      targetBlockId: 'image',
      expectedTargetHash: 'hash-image',
      desired: { kind: 'svg', value: '<svg><rect width="10" height="10"/></svg>' },
    }]);

    expect(batch.steps[0]!.actions).toEqual([{
      kind: 'replace-image-with-svg',
      targetBlockId: 'image',
      svg: '<svg><rect width="10" height="10"/></svg>',
    }]);
    expect(batch.steps[0]!.assertions).toEqual({
      preflight: [
        { kind: 'target-hash', blockId: 'image', expectedHash: 'hash-image' },
        {
          kind: 'target-type',
          blockId: 'image',
          expectedKind: 'opaque',
          expectedBlockType: 27,
        },
        {
          kind: 'parent-children',
          parentBlockId: 'root',
          expectedChildBlockIds: ['a', 'b', 'c', 'd', 'image', 'board'],
        },
        {
          kind: 'sibling-boundary',
          parentBlockId: 'root',
          precedingBlockId: 'd',
          followingBlockId: 'board',
          blockIds: ['image'],
        },
      ],
      readback: [{
        kind: 'image-replaced-with-svg-whiteboard',
        targetBlockId: 'image',
        svgHash: canonicalHash('<svg><rect width="10" height="10"/></svg>'),
      }],
    });
  });

  it('rejects arbitrary token-only operations and resolves only a unique snapshot token', () => {
    const tokenOnly: MutationIntent = {
      operationId: 'token-only',
      kind: 'whiteboard-overwrite',
      targetToken: 'board-token',
      expectedTargetHash: 'hash-board',
      desired: { kind: 'raw', value: { nodes: [{ id: 'raw-node' }] } },
    };
    const resolved = prepare([tokenOnly]);

    expect(resolved.steps[0]!.actions).toEqual([{
      kind: 'overwrite-whiteboard',
      targetBlockId: 'board',
      targetToken: 'board-token',
      desired: { kind: 'raw', value: { nodes: [{ id: 'raw-node' }] } },
    }]);

    expectCode({ ...tokenOnly, targetToken: 'arbitrary-token' }, 'target_missing');

    const duplicateBoard = node(
      'board-duplicate',
      'whiteboard',
      43,
      'hash-board-duplicate',
      'root',
      [],
      { whiteboard: { token: 'board-token' } },
    );
    expectCode(tokenOnly, 'invalid_operation', snapshot([duplicateBoard]));
  });

  it('rejects conflicting provider token fields on a Whiteboard target', () => {
    const conflicted = snapshot();
    const board = conflicted.nodes.find(({ blockId }) => blockId === 'board')!;
    board.raw.whiteboard = { token: 'different-board-token' };

    expectCode({
      operationId: 'conflicting-board-token',
      kind: 'whiteboard-overwrite',
      targetBlockId: 'board',
      expectedTargetHash: 'hash-board',
      desired: { kind: 'raw', value: { nodes: [{ id: 'raw-node' }] } },
    }, 'invalid_operation', conflicted);
  });
});

describe('prepared batch integrity', () => {
  it('deep-freezes the full batch and detects a forged mutable clone', () => {
    const batch = prepare([{
      operationId: 'replace-a',
      kind: 'replace',
      targetBlockId: 'a',
      expectedHash: 'hash-a',
      desired: paragraph('Updated'),
    }]);

    expect(preparedMutationBatchFingerprint(batch)).toBe(batch.fingerprint);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.steps)).toBe(true);
    expect(Object.isFrozen(batch.steps[0])).toBe(true);
    expect(Object.isFrozen(batch.steps[0]!.intent)).toBe(true);
    expect(Object.isFrozen(batch.steps[0]!.actions[0])).toBe(true);
    expect(Object.isFrozen((batch.steps[0]!.actions[0] as {
      block: Record<string, unknown>;
    }).block)).toBe(true);
    expect(Object.isFrozen(batch.steps[0]!.assertions.preflight)).toBe(true);
    expect(Object.isFrozen(batch.steps[0]!.assertions.preflight[0])).toBe(true);
    expect(() => {
      (batch.steps[0]!.actions[0] as { kind: string }).kind = 'forged';
    }).toThrow(TypeError);

    const forged = structuredClone(batch) as PreparedMutationBatch;
    (forged.steps[0]!.actions[0] as { kind: string }).kind = 'forged';
    expect(() => assertPreparedMutationBatchIntegrity(forged)).toThrowError(
      expect.objectContaining({ code: 'batch_integrity_mismatch' }),
    );

    const forgedAssertion = structuredClone(batch) as PreparedMutationBatch;
    (forgedAssertion.steps[0]!.assertions.preflight[0] as {
      expectedHash: string;
    }).expectedHash = 'forged-hash';
    expect(() => assertPreparedMutationBatchIntegrity(forgedAssertion)).toThrowError(
      expect.objectContaining({ code: 'batch_integrity_mismatch' }),
    );
  });
});
