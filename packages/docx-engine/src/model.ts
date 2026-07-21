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

export type DesiredParagraphNode = {
  kind: 'paragraph';
  content: InlineContent[];
};

export type DesiredListNode = {
  kind: 'list';
  ordered: boolean;
  items: Array<{
    content: InlineContent[];
    children: DesiredListChildNode[];
  }>;
};

export type DesiredListChildNode = DesiredParagraphNode | DesiredListNode;

export type DesiredNode =
  | { kind: 'title'; content: InlineContent[] }
  | DesiredParagraphNode
  | {
      kind: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      content: InlineContent[];
    }
  | DesiredListNode
  | { kind: 'table'; rows: Array<{ cells: Array<{ content: DesiredNode[] }> }> }
  | { kind: 'code'; language: string; text: string; caption?: string }
  | { kind: 'quote'; content: InlineContent[] }
  | {
      kind: 'callout';
      calloutType: string;
      title?: string;
      children: DesiredNode[];
    };

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

export interface PreparedProviderBlock {
  block_type: number;
  [key: string]: unknown;
}

export type PreparedInsertSegment =
  | {
      kind: 'provider-blocks';
      desiredIndex: number;
      blocks: PreparedProviderBlock[];
    }
  | {
      kind: 'xml';
      desiredIndex: number;
      nodeKind: 'table' | 'callout';
      xml: string;
    };

export type PreparedMutationAction =
  | {
      kind: 'replace-provider-block';
      targetBlockId: string;
      block: PreparedProviderBlock;
    }
  | {
      kind: 'replace-provider-blocks';
      targetBlockId: string;
      blocks: PreparedProviderBlock[];
    }
  | {
      kind: 'replace-xml';
      targetBlockId: string;
      nodeKind: 'table' | 'callout';
      xml: string;
    }
  | {
      kind: 'insert-segments';
      parentBlockId: string;
      insertAfterBlockId: string;
      insertBeforeBlockId?: string;
      segments: PreparedInsertSegment[];
    }
  | { kind: 'delete-blocks'; parentBlockId: string; blockIds: string[] }
  | {
      kind: 'move-blocks';
      parentBlockId: string;
      blockIds: string[];
      insertAfterBlockId: string;
    }
  | { kind: 'assert-node'; blockId: string }
  | {
      kind: 'overwrite-whiteboard';
      targetBlockId: string;
      targetToken: string;
      desired: Extract<MutationIntent, { kind: 'whiteboard-overwrite' }>['desired'];
    }
  | { kind: 'replace-image-with-svg'; targetBlockId: string; svg: string };

export type PreparedPreflightAssertion =
  | { kind: 'target-hash'; blockId: string; expectedHash: string }
  | {
      kind: 'target-type';
      blockId: string;
      expectedKind: SnapshotNode['kind'];
      expectedBlockType: number;
    }
  | { kind: 'block-parent'; blockId: string; expectedParentBlockId: string }
  | {
      kind: 'parent-children';
      parentBlockId: string;
      expectedChildBlockIds: string[];
    }
  | {
      kind: 'sibling-boundary';
      parentBlockId: string;
      precedingBlockId: string;
      followingBlockId?: string;
      blockIds: string[];
    }
  | {
      kind: 'insertion-boundary';
      parentBlockId: string;
      precedingBlockId: string;
      followingBlockId?: string;
    }
  | {
      kind: 'resource-token';
      blockId: string;
      resourceKind: 'whiteboard';
      expectedToken: string;
    };

export type PreparedReadbackAssertion =
  | { kind: 'desired-node'; targetBlockId: string; desiredHash: string }
  | {
      kind: 'inserted-desired';
      parentBlockId: string;
      precedingBlockId: string;
      followingBlockId?: string;
      desiredHash: string;
    }
  | { kind: 'blocks-absent'; blockIds: string[] }
  | {
      kind: 'sibling-order';
      parentBlockId: string;
      expectedChildBlockIds: string[];
    }
  | { kind: 'node-hash'; blockId: string; expectedHash: string }
  | {
      kind: 'whiteboard-content';
      targetBlockId: string;
      targetToken: string;
      desiredHash: string;
    }
  | {
      kind: 'image-replaced-with-svg-whiteboard';
      targetBlockId: string;
      svgHash: string;
    };

export interface PreparedMutationAssertions {
  preflight: PreparedPreflightAssertion[];
  readback: PreparedReadbackAssertion[];
}

export interface PreparedMutationStep {
  operationId: string;
  kind: MutationIntent['kind'];
  idempotencyToken: string;
  intent: MutationIntent;
  actions: PreparedMutationAction[];
  assertions: PreparedMutationAssertions;
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
  prewriteResourceEvidence?: ResourceStateEvidence[];
  verifiedResourceEvidence?: ResourceStateEvidence[];
  revision: string;
  afterSnapshotHash: string;
  verified: true;
}

export interface ResourceStateEvidence {
  resourceKind: 'whiteboard';
  token: string;
  rawHash: string;
  raw: unknown;
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
  lastObservedSnapshotHash?: string;
  completedOperations: VerifiedOperationEvidence[];
  failedOperation: {
    operationId: string;
    kind: string;
    message: string;
    cause?: unknown;
  };
  pendingOperationIds: string[];
  createdBlockIds: string[];
  resourceTokens?: string[];
  prewriteResourceEvidence?: ResourceStateEvidence[];
  verifiedResourceEvidence?: ResourceStateEvidence[];
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

  constructor(evidence: PartialMutationEvidence, options: { cause?: unknown } = {}) {
    super(
      `Mutation batch partially failed at ${evidence.failedOperation.kind}: ${evidence.failedOperation.message}`,
      { cause: options.cause ?? evidence.failedOperation.cause },
    );
    this.name = 'PartialMutationError';
    this.evidence = evidence;
  }
}
