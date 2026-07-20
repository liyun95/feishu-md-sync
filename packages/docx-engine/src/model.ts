export type DocumentSelector =
  | { kind: 'docx'; token: string }
  | { kind: 'wiki'; token: string }
  | { kind: 'url'; url: string };

export type InlineContent =
  | {
      kind: 'text';
      text: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strike?: boolean;
    }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

export type DesiredNode =
  | { kind: 'title'; content: InlineContent[] }
  | { kind: 'paragraph'; content: InlineContent[] }
  | {
      kind: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      content: InlineContent[];
    }
  | {
      kind: 'list';
      ordered: boolean;
      items: Array<{
        content: InlineContent[];
        children: DesiredListNode[];
      }>;
    }
  | { kind: 'table'; rows: Array<{ cells: Array<{ content: DesiredNode[] }> }> }
  | { kind: 'code'; language: string; text: string; caption?: string }
  | { kind: 'quote'; content: InlineContent[] }
  | {
      kind: 'callout';
      calloutType: string;
      title?: string;
      children: DesiredNode[];
    };

export type DesiredListNode = Extract<DesiredNode, { kind: 'list' }>;

export interface SnapshotNode {
  blockId: string;
  parentBlockId?: string;
  childBlockIds: string[];
  blockType: number;
  kind:
    | DesiredNode['kind']
    | 'page'
    | 'whiteboard'
    | 'synced_source'
    | 'synced_reference'
    | 'opaque';
  canonicalHash: string;
  raw: Record<string, unknown>;
}

export interface DocumentSnapshot {
  documentId: string;
  revision: string;
  rootBlockId: string;
  canonicalHash: string;
  nodes: SnapshotNode[];
}

export type MutationIntent =
  | {
      operationId: string;
      kind: 'replace';
      targetBlockId: string;
      expectedHash: string;
      desired: DesiredNode;
    }
  | {
      operationId: string;
      kind: 'insert';
      parentBlockId: string;
      insertAfterBlockId: string;
      insertBeforeBlockId?: string;
      desired: DesiredNode[];
    }
  | {
      operationId: string;
      kind: 'delete';
      parentBlockId: string;
      blockIds: string[];
      expectedHashes: string[];
    }
  | {
      operationId: string;
      kind: 'move';
      parentBlockId: string;
      blockIds: string[];
      insertAfterBlockId: string;
    }
  | {
      operationId: string;
      kind: 'assert';
      blockId: string;
      expectedHash: string;
    }
  | {
      operationId: string;
      kind: 'whiteboard-overwrite';
      targetBlockId?: string;
      targetToken?: string;
      expectedTargetHash?: string;
      desired:
        | { kind: 'copy-token'; sourceToken: string }
        | { kind: 'raw'; value: unknown }
        | { kind: 'svg'; value: string };
    };

export interface PreparedMutationStep {
  operationId: string;
  kind: MutationIntent['kind'];
  idempotencyToken: string;
  intent: MutationIntent;
}

export interface PreparedMutationBatch {
  schemaVersion: 1;
  engineVersion: string;
  documentId: string;
  expectedRevision: string;
  beforeSnapshotHash: string;
  steps: PreparedMutationStep[];
  fingerprint: string;
}

export interface VerifiedOperationEvidence {
  operationId: string;
  createdBlockIds: string[];
  resourceTokens?: string[];
  revision: string;
  afterSnapshotHash: string;
  verified: true;
}

export interface MutationJournal {
  recordVerified(evidence: VerifiedOperationEvidence): Promise<void>;
}

export interface MutationOutcome {
  finalSnapshot: DocumentSnapshot;
  operations: VerifiedOperationEvidence[];
}

export interface PartialMutationEvidence {
  batchFingerprint: string;
  beforeSnapshotHash: string;
  lastObservedRevision: string;
  completedOperations: VerifiedOperationEvidence[];
  failedOperation: {
    operationId: string;
    kind: string;
    message: string;
    cause?: unknown;
  };
  pendingOperationIds: string[];
  createdBlockIds: string[];
  recoveryDisposition:
    | 'resume_possible'
    | 'reverse_possible'
    | 'manual_inspection_required';
}

export type RecoveryAssessment =
  | {
      disposition: 'resume_possible';
      completedOperationIds: string[];
      pendingOperationIds: string[];
    }
  | { disposition: 'reverse_possible'; reverseIntents: MutationIntent[] }
  | { disposition: 'manual_inspection_required'; reason: string };

export interface PrepareMutationInput {
  snapshot: DocumentSnapshot;
  operations: MutationIntent[];
  idempotencyNamespace: string;
}

export interface ApplyMutationInput {
  batch: PreparedMutationBatch;
  journal: MutationJournal;
}

export interface AssessRecoveryInput {
  batch: PreparedMutationBatch;
  checkpoint: {
    completedOperations: VerifiedOperationEvidence[];
    prewriteSnapshot: DocumentSnapshot;
  };
}

export interface FeishuDocxEngine {
  snapshot(document: DocumentSelector): Promise<DocumentSnapshot>;
  prepare(input: PrepareMutationInput): PreparedMutationBatch;
  apply(input: ApplyMutationInput): Promise<MutationOutcome>;
  assessRecovery(input: AssessRecoveryInput): Promise<RecoveryAssessment>;
}

export class PartialMutationError extends Error {
  readonly evidence: PartialMutationEvidence;

  constructor(evidence: PartialMutationEvidence) {
    super(
      `Mutation batch partially failed at ${evidence.failedOperation.kind}: ${evidence.failedOperation.message}`,
      { cause: evidence.failedOperation.cause },
    );
    this.name = 'PartialMutationError';
    this.evidence = evidence;
  }
}
