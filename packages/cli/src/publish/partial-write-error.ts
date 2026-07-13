import type { ScopedPatchOperation } from './scoped-patch-plan.js';

export class PartialWriteError extends Error {
  readonly completedOperations: ScopedPatchOperation[];
  readonly failedOperation: ScopedPatchOperation;
  readonly receiptWritten = false;

  constructor(input: {
    completedOperations: ScopedPatchOperation[];
    failedOperation: ScopedPatchOperation;
    cause: unknown;
  }) {
    const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Scoped publish partially failed at ${input.failedOperation.kind}: ${causeMessage}`);
    this.name = 'PartialWriteError';
    this.completedOperations = input.completedOperations;
    this.failedOperation = input.failedOperation;
  }
}
