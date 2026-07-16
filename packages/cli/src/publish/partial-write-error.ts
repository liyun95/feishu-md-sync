import type { ScopedPatchOperation } from './scoped-patch-plan.js';
import type { SemanticLocator } from '../semantic/types.js';
import type { WhiteboardOperation } from '../whiteboards/whiteboard-plan.js';

export type PublishWriteOperationSummary = {
  kind:
    | ScopedPatchOperation['kind']
    | WhiteboardOperation['kind']
    | 'code-reconcile-create'
    | 'code-reconcile-update'
    | 'code-reconcile-move'
    | 'code-reconcile-delete'
    | 'code-readback'
    | 'authoring-token-readback'
    | 'callout-readback'
    | 'scoped-readback'
    | 'document-create'
    | 'created-document-planning'
    | 'created-document-readback'
    | 'receipt-write';
  locator?: SemanticLocator;
  assetKey?: string;
};

export class PartialWriteError extends Error {
  readonly completedOperations: PublishWriteOperationSummary[];
  readonly failedOperation: PublishWriteOperationSummary;
  readonly pendingOperations: PublishWriteOperationSummary[];
  readonly receiptWritten = false;
  readonly document?: { documentId: string; url?: string };

  constructor(input: {
    completedOperations: PublishWriteOperationSummary[];
    failedOperation: PublishWriteOperationSummary;
    pendingOperations?: PublishWriteOperationSummary[];
    document?: { documentId: string; url?: string };
    cause: unknown;
  }) {
    const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Publish partially failed at ${input.failedOperation.kind}: ${causeMessage}`);
    this.name = 'PartialWriteError';
    this.completedOperations = input.completedOperations;
    this.failedOperation = input.failedOperation;
    this.pendingOperations = input.pendingOperations ?? [];
    this.document = input.document;
  }
}
