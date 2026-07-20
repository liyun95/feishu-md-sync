import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  PartialMutationError,
  type MutationIntent,
  type PartialMutationEvidence,
  type PreparedMutationBatch,
  type PreparedMutationStep,
} from '../src/index.js';

function insert(operationId: string): MutationIntent {
  return {
    operationId,
    kind: 'insert',
    parentBlockId: 'root',
    insertAfterBlockId: 'anchor',
    desired: [
      {
        kind: 'paragraph',
        content: [{ kind: 'text', text: operationId }],
      },
    ],
  };
}

function preparedBatch(operations: MutationIntent[]): PreparedMutationBatch {
  const steps: PreparedMutationStep[] = operations.map((intent) => ({
    operationId: intent.operationId,
    kind: intent.kind,
    idempotencyToken: `namespace:${intent.operationId}`,
    intent,
  }));
  const payload = {
    schemaVersion: 1 as const,
    engineVersion: '0.1.0',
    documentId: 'doc-1',
    expectedRevision: 'revision-1',
    beforeSnapshotHash: 'before-hash',
    steps,
  };

  return {
    ...payload,
    fingerprint: canonicalHash(payload),
  };
}

describe('typed mutation contract', () => {
  it('produces a stable SHA-256 batch fingerprint for equivalent inputs', () => {
    const batch = preparedBatch([insert('op-a'), insert('op-b')]);
    const equivalentPayloadWithDifferentKeyOrder = {
      steps: batch.steps,
      beforeSnapshotHash: batch.beforeSnapshotHash,
      expectedRevision: batch.expectedRevision,
      documentId: batch.documentId,
      engineVersion: batch.engineVersion,
      schemaVersion: batch.schemaVersion,
    };
    const expected = createHash('sha256')
      .update(
        '{"beforeSnapshotHash":"before-hash","documentId":"doc-1","engineVersion":"0.1.0","expectedRevision":"revision-1","schemaVersion":1,"steps":[{"idempotencyToken":"namespace:op-a","intent":{"desired":[{"content":[{"kind":"text","text":"op-a"}],"kind":"paragraph"}],"insertAfterBlockId":"anchor","kind":"insert","operationId":"op-a","parentBlockId":"root"},"kind":"insert","operationId":"op-a"},{"idempotencyToken":"namespace:op-b","intent":{"desired":[{"content":[{"kind":"text","text":"op-b"}],"kind":"paragraph"}],"insertAfterBlockId":"anchor","kind":"insert","operationId":"op-b","parentBlockId":"root"},"kind":"insert","operationId":"op-b"}]}',
      )
      .digest('hex');

    expect(batch.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(batch.fingerprint).toBe(expected);
    expect(canonicalHash(equivalentPayloadWithDifferentKeyOrder)).toBe(
      batch.fingerprint,
    );
    expect(preparedBatch([insert('op-a'), insert('op-b')]).fingerprint).toBe(
      batch.fingerprint,
    );
  });

  it('preserves operation order when computing the batch fingerprint', () => {
    expect(preparedBatch([insert('op-b'), insert('op-a')]).fingerprint).not.toBe(
      preparedBatch([insert('op-a'), insert('op-b')]).fingerprint,
    );
  });

  it('sorts integer-like object keys lexicographically at every depth', () => {
    const value = {
      '2': 'top-level-two',
      '10': {
        '2': 'nested-two',
        '10': 'nested-ten',
      },
    };
    const canonicalJson =
      '{"10":{"10":"nested-ten","2":"nested-two"},"2":"top-level-two"}';
    const expected = createHash('sha256').update(canonicalJson).digest('hex');

    expect(canonicalHash(value)).toBe(expected);
  });

  it('preserves structured provider failures on partial mutation errors', () => {
    const providerFailure = {
      code: 1770001,
      requestId: 'request-1',
      details: { field: 'block_id' },
    };
    const evidence: PartialMutationEvidence = {
      batchFingerprint: 'a'.repeat(64),
      beforeSnapshotHash: 'before-hash',
      lastObservedRevision: 'revision-2',
      completedOperations: [],
      failedOperation: {
        operationId: 'op-a',
        kind: 'insert',
        message: 'provider rejected the mutation',
        cause: providerFailure,
      },
      pendingOperationIds: ['op-a', 'op-b'],
      createdBlockIds: [],
      recoveryDisposition: 'manual_inspection_required',
    };

    const error = new PartialMutationError(evidence);

    expect(error.evidence).toBe(evidence);
    expect(error.cause).toBe(providerFailure);
  });
});
