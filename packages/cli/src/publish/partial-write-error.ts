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
  blockIds?: string[];
  parentBlockId?: string;
};

export class PartialWriteError extends Error {
  readonly completedOperations: PublishWriteOperationSummary[];
  readonly failedOperation: PublishWriteOperationSummary;
  readonly pendingOperations: PublishWriteOperationSummary[];
  readonly receiptWritten = false;
  readonly recoveryCheckpointWritten: boolean;
  readonly recoveryCheckpointRevision?: string;
  readonly causeDetails?: unknown;
  readonly document?: { documentId: string; url?: string };

  constructor(input: {
    completedOperations: PublishWriteOperationSummary[];
    failedOperation: PublishWriteOperationSummary;
    pendingOperations?: PublishWriteOperationSummary[];
    document?: { documentId: string; url?: string };
    recoveryCheckpointWritten?: boolean;
    recoveryCheckpointRevision?: string;
    cause: unknown;
  }) {
    const causeMessage = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Publish partially failed at ${input.failedOperation.kind}: ${causeMessage}`);
    this.name = 'PartialWriteError';
    this.completedOperations = input.completedOperations;
    this.failedOperation = input.failedOperation;
    this.pendingOperations = input.pendingOperations ?? [];
    this.document = input.document;
    this.recoveryCheckpointWritten = input.recoveryCheckpointWritten === true;
    if (input.recoveryCheckpointRevision !== undefined) {
      this.recoveryCheckpointRevision = input.recoveryCheckpointRevision;
    }
    this.causeDetails = cliFailureDetails(input.cause);
  }
}

function cliFailureDetails(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { details?: unknown; causeDetails?: unknown };
  if (record.causeDetails && typeof record.causeDetails === 'object') return record.causeDetails;
  const details = record.details;
  return details && typeof details === 'object' ? details : undefined;
}
