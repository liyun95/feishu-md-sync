import { canonicalHash } from './hash.js';
import {
  assertNonEmptyWhiteboardRaw,
  canonicalCodeLanguage,
  canonicalWhiteboardRawHash,
  normalizeProviderLinkUrl,
  providerBlocksToXml,
  svgExpectedTexts,
  whiteboardRawContainsTexts,
} from './codec.js';
import type {
  ApplyMutationInput,
  AssessRecoveryInput,
  DesiredNode,
  DocumentSelector,
  DocumentSnapshot,
  FeishuDocxEngine,
  InlineContent,
  MutationOutcome,
  PartialMutationEvidence,
  PreparedMutationAction,
  PreparedMutationBatch,
  PreparedMutationStep,
  PreparedPreflightAssertion,
  PreparedProviderBlock,
  PreparedReadbackAssertion,
  RecoveryAssessment,
  ResourceStateEvidence,
  SnapshotNode,
  VerifiedOperationEvidence,
} from './model.js';
import { PartialMutationError } from './model.js';
import {
  ENGINE_SCHEMA_VERSION,
  ENGINE_VERSION,
  SUPPORTED_PREPARED_ENGINE_VERSIONS,
  assertPreparedMutationBatchIntegrity,
  prepareMutationBatch,
  supportsPreparedEngineVersion,
} from './prepare.js';
import { createDocumentSnapshot } from './snapshot.js';
import {
  createVerifiedStructuredTree,
  StructuredTreeProgressError,
} from './structured-tree.js';
import { assessRecovery } from './recovery.js';
import type { DocxTransport, ProviderBlock } from './transport.js';

const WHITEBOARD_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
const CREATED_CODE_READBACK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

export type EngineExecutionErrorCode =
  | 'document_mismatch'
  | 'journal_failure'
  | 'preflight_assertion_failed'
  | 'provider_failure'
  | 'readback_assertion_failed'
  | 'recovery_not_supported'
  | 'snapshot_failure'
  | 'stale_revision'
  | 'stale_snapshot'
  | 'unplanned_remote_change'
  | 'unsupported_engine_version'
  | 'unsupported_schema_version'
  | 'unsupported_action';

export class EngineExecutionError extends Error {
  readonly code: EngineExecutionErrorCode;
  readonly operationId?: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: EngineExecutionErrorCode,
    message: string,
    options: {
      operationId?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineExecutionError';
    this.code = code;
    this.operationId = options.operationId;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }
}

export function createFeishuDocxEngine(input: {
  transport: DocxTransport;
}): FeishuDocxEngine {
  const transport = input?.transport;
  if (!transport) throw new Error('createFeishuDocxEngine requires a Docx transport.');

  const snapshot = async (document: DocumentSelector): Promise<DocumentSnapshot> => {
    const resolved = await transport.resolveDocument(document);
    return fetchSnapshot(transport, resolved.documentId);
  };

  return Object.freeze({
    snapshot,
    prepare: prepareMutationBatch,
    apply: (applyInput: ApplyMutationInput) => applyMutationBatch(transport, applyInput),
    assessRecovery: (recoveryInput: AssessRecoveryInput): Promise<RecoveryAssessment> =>
      assessRecovery(transport, recoveryInput),
  });
}

async function applyMutationBatch(
  transport: DocxTransport,
  input: ApplyMutationInput,
): Promise<MutationOutcome> {
  if (!input?.batch || !input?.journal) {
    throw new EngineExecutionError('preflight_assertion_failed', 'Apply requires a batch and journal.');
  }
  const batch = input.batch;
  assertPreparedMutationBatchIntegrity(batch);
  if (batch.schemaVersion !== ENGINE_SCHEMA_VERSION) {
    throw new EngineExecutionError(
      'unsupported_schema_version',
      `Prepared mutation schema ${batch.schemaVersion} is not supported by schema ${ENGINE_SCHEMA_VERSION}.`,
      { context: { actualSchemaVersion: batch.schemaVersion, supportedSchemaVersion: ENGINE_SCHEMA_VERSION } },
    );
  }
  if (!supportsPreparedEngineVersion(batch.engineVersion)) {
    throw new EngineExecutionError(
      'unsupported_engine_version',
      `Prepared mutation engine ${batch.engineVersion} is not supported by engine ${ENGINE_VERSION}.`,
      {
        context: {
          actualEngineVersion: batch.engineVersion,
          supportedEngineVersions: [...SUPPORTED_PREPARED_ENGINE_VERSIONS],
        },
      },
    );
  }

  let current = await fetchSnapshot(transport, batch.documentId);
  assertBatchIdentity(batch, current);
  for (const step of batch.steps) {
    for (const assertion of step.assertions.preflight) {
      assertPreflight(assertion, current, step.operationId);
    }
    assertTaskSevenSupport(step);
  }

  const completed: VerifiedOperationEvidence[] = [];
  const allCreatedBlockIds: string[] = [];
  let hasVerifiedRemoteWrite = false;

  for (const [stepIndex, step] of batch.steps.entries()) {
    try {
      const preOperation = await fetchSnapshot(transport, batch.documentId);
      assertSameSnapshot(current, preOperation, step.operationId);
      assertCurrentActionPreconditions(step, preOperation);
      current = preOperation;
    } catch (cause) {
      if (hasVerifiedRemoteWrite) {
        throw partialError({
          batch,
          current,
          completed,
          failedStep: step,
          failedKind: 'preflight',
          cause,
          pendingSteps: batch.steps.slice(stepIndex + 1),
          createdBlockIds: allCreatedBlockIds,
        });
      }
      throw executionError(
        isExecutionError(cause) ? cause.code : 'snapshot_failure',
        step.operationId,
        `Operation preflight failed for ${step.operationId}.`,
        cause,
      );
    }
    const before = current;
    const stepCreatedBlockIds: string[] = [];
    const resourceTokens: string[] = [];
    const prewriteResourceEvidence: ResourceStateEvidence[] = [];
    const verifiedResourceEvidence: ResourceStateEvidence[] = [];
    let stepHasRemoteWrite = false;
    let latestProviderRevision: string | undefined;
    let reconciledReadback: DocumentSnapshot | undefined;
    let stepHasVerifiedStructuredTree = false;

    try {
      for (const [actionIndex, action] of step.actions.entries()) {
        const result = await executeAction(
          transport,
          batch.documentId,
          batch.fingerprint,
          step,
          action,
          actionIndex,
          current,
        );
        if (result.wrote) {
          stepHasRemoteWrite = true;
          hasVerifiedRemoteWrite = true;
        }
        if (result.providerRevision !== undefined) latestProviderRevision = result.providerRevision;
        appendUnique(stepCreatedBlockIds, result.createdBlockIds);
        appendUnique(resourceTokens, result.resourceTokens);
        appendResourceEvidence(prewriteResourceEvidence, result.prewriteResourceEvidence);
        appendResourceEvidence(verifiedResourceEvidence, result.verifiedResourceEvidence);
        if (result.snapshot) current = result.snapshot;
        if (result.structuredTree) stepHasVerifiedStructuredTree = true;
      }
    } catch (cause) {
      const actionProgress = cause instanceof ActionProgressError ? cause : undefined;
      if (actionProgress) {
        if (actionProgress.wrote) {
          stepHasRemoteWrite = true;
          hasVerifiedRemoteWrite = true;
        }
        appendUnique(stepCreatedBlockIds, actionProgress.createdBlockIds);
        appendUnique(resourceTokens, actionProgress.resourceTokens);
        appendResourceEvidence(prewriteResourceEvidence, actionProgress.prewriteResourceEvidence);
        appendResourceEvidence(verifiedResourceEvidence, actionProgress.verifiedResourceEvidence);
        current = actionProgress.lastSnapshot;
        if (actionProgress.providerRevision !== undefined) {
          latestProviderRevision = actionProgress.providerRevision;
        }
      }
      if (actionProgress?.attempted && actionProgress.phase === 'provider') {
        let observed: DocumentSnapshot;
        try {
          observed = await fetchSnapshot(transport, batch.documentId);
        } catch (readbackCause) {
          throw partialError({
            batch,
            current,
            completed,
            failedStep: step,
            failedKind: actionProgress.phase,
            cause: readbackCause,
            pendingSteps: batch.steps.slice(stepIndex + 1),
            createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
            resourceTokens,
            prewriteResourceEvidence,
            verifiedResourceEvidence,
            latestProviderRevision,
            recoveryDisposition: actionProgress.recoveryDisposition,
          });
        }
        if (sameSnapshot(before, observed)) {
          if (hasVerifiedRemoteWrite) {
            throw partialError({
              batch,
              current: observed,
              completed,
              failedStep: step,
              failedKind: 'provider',
              cause: actionProgress.cause ?? cause,
              pendingSteps: batch.steps.slice(stepIndex + 1),
              createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
              resourceTokens,
              prewriteResourceEvidence,
              verifiedResourceEvidence,
              recoveryDisposition: actionProgress.recoveryDisposition,
            });
          }
          throw executionError(
            'provider_failure',
            step.operationId,
            `Provider rejected operation ${step.operationId} without changing the document.`,
            actionProgress.cause ?? cause,
          );
        }
        try {
          verifyStepReadback(step, before, observed);
          appendUnique(stepCreatedBlockIds, plannedCreatedBlockIds(step, before, observed));
          reconciledReadback = observed;
          current = observed;
          stepHasRemoteWrite = true;
          hasVerifiedRemoteWrite = true;
        } catch (verificationCause) {
          throw partialError({
            batch,
            current: observed,
            completed,
            failedStep: step,
            failedKind: 'provider',
            cause: verificationCause,
            pendingSteps: batch.steps.slice(stepIndex + 1),
            createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
            resourceTokens,
            prewriteResourceEvidence,
            verifiedResourceEvidence,
            recoveryDisposition: actionProgress.recoveryDisposition,
          });
        }
      } else {
        if (hasVerifiedRemoteWrite) {
          throw partialError({
            batch,
            current,
            completed,
            failedStep: step,
            failedKind: actionProgress?.phase ?? 'provider',
            cause: actionProgress?.cause ?? cause,
            pendingSteps: batch.steps.slice(stepIndex + 1),
            createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
            resourceTokens,
            prewriteResourceEvidence,
            verifiedResourceEvidence,
            latestProviderRevision,
            recoveryDisposition: actionProgress?.recoveryDisposition,
          });
        }
        throw executionError(
          'provider_failure',
          step.operationId,
          `Provider mutation failed for operation ${step.operationId}.`,
          actionProgress?.cause ?? cause,
        );
      }
    }

    let readback: DocumentSnapshot;
    let lastObserved = current;
    let readbackObserved = reconciledReadback !== undefined;
    try {
      readback = reconciledReadback ?? await fetchSnapshot(transport, batch.documentId);
      readbackObserved = true;
      lastObserved = readback;
      if (latestProviderRevision !== undefined && stepContainsNativeTable(step)) {
        assertExactProviderRevision(latestProviderRevision, readback, step.operationId);
      }
      appendUnique(stepCreatedBlockIds, plannedCreatedBlockIds(step, before, readback));
      verifyStepReadback(step, before, readback);
    } catch (cause) {
      if (stepHasRemoteWrite || hasVerifiedRemoteWrite) {
        throw partialError({
          batch,
          current: lastObserved,
          completed,
          failedStep: step,
          failedKind: 'verification',
          cause,
          pendingSteps: batch.steps.slice(stepIndex + 1),
          createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
          resourceTokens,
          prewriteResourceEvidence,
          verifiedResourceEvidence,
          ...(!readbackObserved && latestProviderRevision !== undefined
            ? { latestProviderRevision }
            : {}),
        });
      }
      throw executionError(
        isExecutionError(cause) ? cause.code : 'readback_assertion_failed',
        step.operationId,
        `Readback verification failed for operation ${step.operationId}.`,
        cause,
      );
    }

    const evidence = deepFreeze({
      operationId: step.operationId,
      createdBlockIds: [...stepCreatedBlockIds],
      ...(resourceTokens.length > 0 ? { resourceTokens: [...resourceTokens] } : {}),
      ...(prewriteResourceEvidence.length > 0
        ? { prewriteResourceEvidence: structuredClone(prewriteResourceEvidence) }
        : {}),
      ...(verifiedResourceEvidence.length > 0
        ? { verifiedResourceEvidence: structuredClone(verifiedResourceEvidence) }
        : {}),
      revision: readback.revision,
      afterSnapshotHash: readback.canonicalHash,
      verified: true as const,
    });

    try {
      await input.journal.recordVerified(evidence);
    } catch (cause) {
      if (stepHasRemoteWrite || hasVerifiedRemoteWrite) {
        throw partialError({
          batch,
          current: readback,
          completed,
          failedStep: step,
          failedKind: 'journal',
          cause,
          pendingSteps: batch.steps.slice(stepIndex + 1),
          createdBlockIds: [...allCreatedBlockIds, ...stepCreatedBlockIds],
          resourceTokens,
          prewriteResourceEvidence,
          verifiedResourceEvidence,
          recoveryDisposition: stepHasVerifiedStructuredTree
            ? 'resume_possible'
            : undefined,
        });
      }
      throw executionError(
        'journal_failure',
        step.operationId,
        `Journal rejected verified evidence for operation ${step.operationId}.`,
        cause,
      );
    }

    completed.push(evidence);
    appendUnique(allCreatedBlockIds, stepCreatedBlockIds);
    current = readback;
  }

  return deepFreeze({ finalSnapshot: current, operations: [...completed] });
}

async function fetchSnapshot(
  transport: DocxTransport,
  documentId: string,
): Promise<DocumentSnapshot> {
  try {
    const fetched = await transport.fetchBlocks(documentId);
    return createDocumentSnapshot({ documentId, ...fetched });
  } catch (cause) {
    if (isExecutionError(cause)) throw cause;
    throw new EngineExecutionError(
      'snapshot_failure',
      `Could not read Docx snapshot for ${documentId}.`,
      { context: { documentId }, cause },
    );
  }
}

function assertBatchIdentity(batch: PreparedMutationBatch, snapshot: DocumentSnapshot): void {
  if (snapshot.documentId !== batch.documentId) {
    throw new EngineExecutionError('document_mismatch', 'Prepared batch targets a different document.', {
      context: { expectedDocumentId: batch.documentId, actualDocumentId: snapshot.documentId },
    });
  }
  if (snapshot.revision !== batch.expectedRevision) {
    throw new EngineExecutionError('stale_revision', 'Document revision changed after mutation preparation.', {
      context: { expectedRevision: batch.expectedRevision, actualRevision: snapshot.revision },
    });
  }
  if (snapshot.canonicalHash !== batch.beforeSnapshotHash) {
    throw new EngineExecutionError('stale_snapshot', 'Document content changed after mutation preparation.', {
      context: {
        expectedSnapshotHash: batch.beforeSnapshotHash,
        actualSnapshotHash: snapshot.canonicalHash,
      },
    });
  }
}

function assertSameSnapshot(
  expected: DocumentSnapshot,
  actual: DocumentSnapshot,
  operationId: string,
): void {
  if (!sameSnapshot(expected, actual)) {
    throw new EngineExecutionError(
      expected.revision !== actual.revision ? 'stale_revision' : 'stale_snapshot',
      `Document changed before operation ${operationId}.`,
      {
        operationId,
        context: {
          expectedRevision: expected.revision,
          actualRevision: actual.revision,
          expectedSnapshotHash: expected.canonicalHash,
          actualSnapshotHash: actual.canonicalHash,
        },
      },
    );
  }
}

function sameSnapshot(expected: DocumentSnapshot, actual: DocumentSnapshot): boolean {
  return expected.documentId === actual.documentId &&
    expected.revision === actual.revision &&
    expected.canonicalHash === actual.canonicalHash;
}

function assertPreflight(
  assertion: PreparedPreflightAssertion,
  snapshot: DocumentSnapshot,
  operationId: string,
): void {
  const nodes = nodeIndex(snapshot);
  const fail = (message: string, context: Record<string, unknown> = {}): never => {
    throw new EngineExecutionError('preflight_assertion_failed', message, {
      operationId,
      context: { assertion, ...context },
    });
  };
  switch (assertion.kind) {
    case 'target-hash': {
      const node = nodes.get(assertion.blockId);
      if (node?.canonicalHash !== assertion.expectedHash) {
        fail(`Target hash preflight failed for ${assertion.blockId}.`, {
          actualHash: node?.canonicalHash,
        });
      }
      return;
    }
    case 'target-type': {
      const node = nodes.get(assertion.blockId);
      if (node?.kind !== assertion.expectedKind || node.blockType !== assertion.expectedBlockType) {
        fail(`Target type preflight failed for ${assertion.blockId}.`, {
          actualKind: node?.kind,
          actualBlockType: node?.blockType,
        });
      }
      return;
    }
    case 'block-parent':
      if (nodes.get(assertion.blockId)?.parentBlockId !== assertion.expectedParentBlockId) {
        fail(`Parent preflight failed for ${assertion.blockId}.`);
      }
      return;
    case 'parent-children': {
      const actual = nodes.get(assertion.parentBlockId)?.childBlockIds;
      if (!sameStrings(actual, assertion.expectedChildBlockIds)) {
        fail(`Child order preflight failed for ${assertion.parentBlockId}.`, { actual });
      }
      return;
    }
    case 'sibling-boundary': {
      const actual = nodes.get(assertion.parentBlockId)?.childBlockIds;
      if (!actual || !matchesBoundary(
        actual,
        assertion.parentBlockId,
        assertion.precedingBlockId,
        assertion.followingBlockId,
        assertion.blockIds,
      )) {
        fail(`Sibling boundary preflight failed for ${assertion.parentBlockId}.`, { actual });
      }
      return;
    }
    case 'insertion-boundary': {
      const actual = nodes.get(assertion.parentBlockId)?.childBlockIds;
      if (!actual || !emptyBoundaryMatches(
        actual,
        assertion.parentBlockId,
        assertion.precedingBlockId,
        assertion.followingBlockId,
      )) {
        fail(`Insertion boundary preflight failed for ${assertion.parentBlockId}.`, { actual });
      }
      return;
    }
    case 'resource-token': {
      const actual = resourceToken(nodes.get(assertion.blockId), assertion.resourceKind);
      if (actual !== assertion.expectedToken) {
        fail(`Resource token preflight failed for ${assertion.blockId}.`, { actual });
      }
      return;
    }
  }
}

function assertCurrentActionPreconditions(
  step: PreparedMutationStep,
  snapshot: DocumentSnapshot,
): void {
  for (const assertion of step.assertions.preflight) {
    if (assertion.kind === 'target-hash' || assertion.kind === 'target-type' ||
      assertion.kind === 'block-parent' || assertion.kind === 'resource-token') {
      assertPreflight(assertion, snapshot, step.operationId);
    }
  }
  if (stepContainsNativeTable(step) || step.kind === 'whiteboard-overwrite') {
    for (const assertion of step.assertions.preflight) {
      if (assertion.kind === 'sibling-boundary' || assertion.kind === 'insertion-boundary') {
        assertPreflight(assertion, snapshot, step.operationId);
      }
    }
  }
  const nodes = nodeIndex(snapshot);
  const fail = (message: string, context: Record<string, unknown> = {}): never => {
    throw new EngineExecutionError('preflight_assertion_failed', message, {
      operationId: step.operationId,
      context,
    });
  };
  for (const action of step.actions) {
    switch (action.kind) {
      case 'assert-node':
        if (!nodes.has(action.blockId)) fail(`Assert target ${action.blockId} disappeared.`);
        break;
      case 'replace-provider-block':
      case 'replace-provider-blocks':
      case 'replace-xml':
      case 'replace-image-with-svg':
        if (!nodes.has(action.targetBlockId)) fail(`Replace target ${action.targetBlockId} disappeared.`);
        break;
      case 'insert-segments': {
        const parent = nodes.get(action.parentBlockId);
        if (!parent) return fail(`Insert parent ${action.parentBlockId} disappeared.`);
        if (action.insertAfterBlockId !== parent.blockId &&
          !parent.childBlockIds.includes(action.insertAfterBlockId)) {
          fail(`Insert anchor ${action.insertAfterBlockId} disappeared.`);
        }
        if (action.insertBeforeBlockId !== undefined &&
          !parent.childBlockIds.includes(action.insertBeforeBlockId)) {
          fail(`Insert following anchor ${action.insertBeforeBlockId} disappeared.`);
        }
        break;
      }
      case 'delete-blocks':
        assertCurrentChildren(nodes, action.parentBlockId, action.blockIds, step.operationId, 'Delete');
        break;
      case 'move-blocks':
        assertCurrentChildren(nodes, action.parentBlockId, action.blockIds, step.operationId, 'Move');
        if (action.insertAfterBlockId !== action.parentBlockId &&
          !nodes.get(action.parentBlockId)!.childBlockIds.includes(action.insertAfterBlockId)) {
          fail(`Move anchor ${action.insertAfterBlockId} disappeared.`);
        }
        break;
      case 'overwrite-whiteboard':
        if (!nodes.has(action.targetBlockId)) fail(`Whiteboard target ${action.targetBlockId} disappeared.`);
        break;
    }
  }
}

function assertCurrentChildren(
  nodes: Map<string, SnapshotNode>,
  parentBlockId: string,
  blockIds: string[],
  operationId: string,
  label: string,
): void {
  const parent = nodes.get(parentBlockId);
  if (!parent || blockIds.some((blockId) => !parent.childBlockIds.includes(blockId))) {
    throw new EngineExecutionError(
      'preflight_assertion_failed',
      `${label} targets are no longer direct children of ${parentBlockId}.`,
      { operationId, context: { parentBlockId, blockIds } },
    );
  }
}

function assertTaskSevenSupport(step: PreparedMutationStep): void {
  const unsupported = (reason: string): never => {
    throw new EngineExecutionError('unsupported_action', reason, {
      operationId: step.operationId,
      context: { operationKind: step.kind },
    });
  };
  if (containsNestedList(step.intent) && step.intent.kind !== 'insert' &&
    !(step.intent.kind === 'replace' &&
      (step.intent.desired.kind === 'table' || step.intent.desired.kind === 'callout'))) {
    unsupported('Recursive nested-list replacement is not available in the ordinary mutation executor.');
  }
  for (const action of step.actions) {
    if (action.kind === 'replace-provider-blocks') {
      unsupported('Multi-block replacement cannot preserve an identical parent child order.');
    }
    if ((action.kind === 'replace-provider-block' && hasProviderChildren(action.block)) ||
      (action.kind === 'replace-provider-blocks' && action.blocks.some(hasProviderChildren))) {
      unsupported('Recursive provider-tree creation is not available in the ordinary mutation executor.');
    }
  }
}

type ActionResult = {
  wrote: boolean;
  createdBlockIds: string[];
  resourceTokens: string[];
  prewriteResourceEvidence: ResourceStateEvidence[];
  verifiedResourceEvidence: ResourceStateEvidence[];
  providerRevision?: string;
  snapshot?: DocumentSnapshot;
  structuredTree?: boolean;
};

class ActionProgressError extends Error {
  readonly wrote: boolean;
  readonly createdBlockIds: string[];
  readonly resourceTokens: string[];
  readonly prewriteResourceEvidence: ResourceStateEvidence[];
  readonly verifiedResourceEvidence: ResourceStateEvidence[];
  readonly lastSnapshot: DocumentSnapshot;
  readonly phase: 'provider' | 'verification';
  readonly attempted: boolean;
  readonly providerRevision?: string;
  readonly recoveryDisposition?: 'resume_possible' | 'manual_inspection_required';

  constructor(input: {
    cause: unknown;
    wrote: boolean;
    createdBlockIds: string[];
    resourceTokens?: string[];
    prewriteResourceEvidence?: ResourceStateEvidence[];
    verifiedResourceEvidence?: ResourceStateEvidence[];
    lastSnapshot: DocumentSnapshot;
    phase: 'provider' | 'verification';
    attempted: boolean;
    providerRevision?: string;
    recoveryDisposition?: 'resume_possible' | 'manual_inspection_required';
  }) {
    super(input.cause instanceof Error ? input.cause.message : String(input.cause), { cause: input.cause });
    this.name = 'ActionProgressError';
    this.wrote = input.wrote;
    this.createdBlockIds = [...input.createdBlockIds];
    this.resourceTokens = [...(input.resourceTokens ?? [])];
    this.prewriteResourceEvidence = structuredClone(input.prewriteResourceEvidence ?? []);
    this.verifiedResourceEvidence = structuredClone(input.verifiedResourceEvidence ?? []);
    this.lastSnapshot = input.lastSnapshot;
    this.phase = input.phase;
    this.attempted = input.attempted;
    this.providerRevision = input.providerRevision;
    this.recoveryDisposition = input.recoveryDisposition;
  }
}

function attemptedProviderError(
  cause: unknown,
  snapshot: DocumentSnapshot,
): ActionProgressError {
  return new ActionProgressError({
    cause,
    wrote: false,
    createdBlockIds: [],
    resourceTokens: [],
    prewriteResourceEvidence: [],
    verifiedResourceEvidence: [],
    lastSnapshot: snapshot,
    phase: 'provider',
    attempted: true,
  });
}

async function executeAction(
  transport: DocxTransport,
  documentId: string,
  batchFingerprint: string,
  step: PreparedMutationStep,
  action: PreparedMutationAction,
  actionIndex: number,
  current: DocumentSnapshot,
): Promise<ActionResult> {
  switch (action.kind) {
    case 'assert-node':
      return emptyActionResult(false);
    case 'replace-provider-block':
      {
        const content = providerBlocksToXml([action.block]);
        let result;
        try {
          result = await transport.replaceBlock({
            documentId,
            blockId: action.targetBlockId,
            content,
            format: 'xml',
          });
        } catch (cause) {
          throw attemptedProviderError(cause, current);
        }
        return {
          wrote: true,
          createdBlockIds: [],
          resourceTokens: [],
          prewriteResourceEvidence: [],
          verifiedResourceEvidence: [],
          ...(result.revision !== undefined ? { providerRevision: result.revision } : {}),
        };
      }
    case 'replace-provider-blocks': {
      let result;
      try {
        result = await transport.replaceBlock({
          documentId,
          blockId: action.targetBlockId,
          content: providerBlocksToXml(action.blocks),
          format: 'xml',
        });
      } catch (cause) {
        throw attemptedProviderError(cause, current);
      }
      return {
        wrote: true,
        createdBlockIds: [],
        resourceTokens: [],
        prewriteResourceEvidence: [],
        verifiedResourceEvidence: [],
        ...(result.revision !== undefined ? { providerRevision: result.revision } : {}),
      };
    }
    case 'replace-xml': {
      let result;
      try {
        result = await transport.replaceBlock({
          documentId,
          blockId: action.targetBlockId,
          content: action.xml,
          format: 'xml',
        });
      } catch (cause) {
        throw attemptedProviderError(cause, current);
      }
      return {
        wrote: true,
        createdBlockIds: [],
        resourceTokens: [],
        prewriteResourceEvidence: [],
        verifiedResourceEvidence: [],
        ...(result.revision !== undefined ? { providerRevision: result.revision } : {}),
      };
    }
    case 'insert-segments':
      return executeInsertSegments(
        transport,
        documentId,
        batchFingerprint,
        step,
        action,
        actionIndex,
        current,
      );
    case 'delete-blocks':
      try {
        await transport.deleteBlocks({ documentId, blockIds: [...action.blockIds] });
      } catch (cause) {
        throw attemptedProviderError(cause, current);
      }
      return emptyActionResult(true);
    case 'move-blocks':
      try {
        await transport.moveAfter({
          documentId,
          anchorBlockId: action.insertAfterBlockId,
          blockIds: [...action.blockIds],
        });
      } catch (cause) {
        throw attemptedProviderError(cause, current);
      }
      return emptyActionResult(true);
    case 'overwrite-whiteboard':
      return executeWhiteboardOverwrite(transport, documentId, step, action, current);
    case 'replace-image-with-svg':
      return executeImageWhiteboardReplacement(transport, documentId, step, action, current);
  }
}

async function executeWhiteboardOverwrite(
  transport: DocxTransport,
  documentId: string,
  step: PreparedMutationStep,
  action: Extract<PreparedMutationAction, { kind: 'overwrite-whiteboard' }>,
  current: DocumentSnapshot,
): Promise<ActionResult> {
  const resourceTokens = action.desired.kind === 'copy-token'
    ? [action.desired.sourceToken, action.targetToken]
    : [action.targetToken];
  let desiredRaw: unknown;
  if (action.desired.kind === 'copy-token') {
    try {
      desiredRaw = await queryWhiteboardWithRetry(transport, action.desired.sourceToken);
      assertNonEmptyWhiteboardRaw(desiredRaw);
    } catch (cause) {
      throw new ActionProgressError({
        cause,
        wrote: false,
        createdBlockIds: [],
        resourceTokens,
        lastSnapshot: current,
        phase: 'verification',
        attempted: false,
      });
    }
  } else if (action.desired.kind === 'raw') {
    desiredRaw = structuredClone(action.desired.value);
    try {
      assertNonEmptyWhiteboardRaw(desiredRaw);
    } catch (cause) {
      throw new ActionProgressError({
        cause,
        wrote: false,
        createdBlockIds: [],
        resourceTokens,
        lastSnapshot: current,
        phase: 'verification',
        attempted: false,
      });
    }
  }

  let prewriteRaw: unknown;
  let prewriteEvidence: ResourceStateEvidence;
  try {
    prewriteRaw = await queryWhiteboardWithRetry(transport, action.targetToken);
    prewriteEvidence = whiteboardEvidence(action.targetToken, prewriteRaw);
  } catch (cause) {
    throw new ActionProgressError({
      cause,
      wrote: false,
      createdBlockIds: [],
      resourceTokens,
      lastSnapshot: current,
      phase: 'verification',
      attempted: false,
    });
  }

  const overwriteInput = action.desired.kind === 'svg'
    ? {
        token: action.targetToken,
        format: 'svg' as const,
        value: action.desired.value,
        idempotencyToken: step.idempotencyToken,
      }
    : {
        token: action.targetToken,
        format: 'raw' as const,
        value: structuredClone(desiredRaw),
        idempotencyToken: step.idempotencyToken,
      };

  let providerCause: unknown;
  try {
    await overwriteWhiteboardWithRetry(transport, overwriteInput);
  } catch (cause) {
    providerCause = cause;
  }

  let readbackRaw: unknown;
  try {
    readbackRaw = await queryWhiteboardWithRetry(transport, action.targetToken);
    assertNonEmptyWhiteboardRaw(readbackRaw);
  } catch (cause) {
    throw new ActionProgressError({
      cause: providerCause ?? cause,
      wrote: true,
      createdBlockIds: [],
      resourceTokens,
      prewriteResourceEvidence: [prewriteEvidence],
      lastSnapshot: current,
      phase: 'verification',
      attempted: true,
      recoveryDisposition: 'manual_inspection_required',
    });
  }

  const verified = whiteboardEvidence(action.targetToken, readbackRaw);
  if (providerCause && providerProvedNoWrite(providerCause)) {
    throw new ActionProgressError({
      cause: providerCause,
      wrote: false,
      createdBlockIds: [],
      resourceTokens,
      prewriteResourceEvidence: [prewriteEvidence],
      verifiedResourceEvidence: [verified],
      lastSnapshot: current,
      phase: 'provider',
      attempted: true,
    });
  }
  const expectedSvgTexts = action.desired.kind === 'svg'
    ? svgExpectedTexts(action.desired.value)
    : [];
  const matches = action.desired.kind === 'svg'
    ? expectedSvgTexts.length > 0
      ? whiteboardRawContainsTexts(readbackRaw, expectedSvgTexts)
      : verified.rawHash !== prewriteEvidence.rawHash
    : verified.rawHash === canonicalWhiteboardRawHash(desiredRaw);
  if (matches) {
    return {
      wrote: true,
      createdBlockIds: [],
      resourceTokens,
      prewriteResourceEvidence: [prewriteEvidence],
      verifiedResourceEvidence: [verified],
      snapshot: current,
    };
  }

  throw new ActionProgressError({
    cause: providerCause ?? new EngineExecutionError(
      'readback_assertion_failed',
      `Whiteboard ${action.targetToken} readback does not match the prepared overwrite.`,
      { operationId: step.operationId },
    ),
    wrote: true,
    createdBlockIds: [],
    resourceTokens,
    prewriteResourceEvidence: [prewriteEvidence],
    verifiedResourceEvidence: [verified],
    lastSnapshot: current,
    phase: 'verification',
    attempted: true,
    recoveryDisposition: 'manual_inspection_required',
  });
}

async function executeImageWhiteboardReplacement(
  transport: DocxTransport,
  documentId: string,
  step: PreparedMutationStep,
  action: Extract<PreparedMutationAction, { kind: 'replace-image-with-svg' }>,
  current: DocumentSnapshot,
): Promise<ActionResult> {
  let providerRevision: string | undefined;
  let providerCause: unknown;
  try {
    const result = await transport.replaceBlock({
      documentId,
      blockId: action.targetBlockId,
      content: `<whiteboard type="svg">${action.svg}</whiteboard>`,
      format: 'xml',
    });
    providerRevision = result.revision;
  } catch (cause) {
    providerCause = cause;
  }

  let observed: DocumentSnapshot;
  let lastObserved = current;
  try {
    let discovered: { blockId: string; token: string };
    for (let attempt = 0; ; attempt += 1) {
      observed = await fetchSnapshot(transport, documentId);
      lastObserved = observed;
      if (providerRevision !== undefined) {
        // Image-to-Whiteboard replacement is a compound provider operation. The returned
        // revision can identify an intermediate accepted write while Whiteboard materialization
        // advances the document again. Structural and raw-resource verification below still
        // proves the exact intended effect and rejects every unrelated block change.
        assertProviderRevisionReached(providerRevision, observed, step.operationId);
      }
      try {
        discovered = discoverImageReplacement(step, current, observed, action.targetBlockId);
        break;
      } catch (cause) {
        const delayMs = WHITEBOARD_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined ||
          !isPendingImageReplacementReadback(cause, step, current, observed, action.targetBlockId)) {
          throw cause;
        }
        await delay(delayMs);
      }
    }
    const raw = await queryWhiteboardWithRetry(transport, discovered.token);
    const verified = whiteboardEvidence(discovered.token, raw);
    const expectedTexts = svgExpectedTexts(action.svg);
    if (expectedTexts.length > 0 && !whiteboardRawContainsTexts(raw, expectedTexts)) {
      throw new EngineExecutionError(
        'readback_assertion_failed',
        'Image replacement Whiteboard raw state does not contain the prepared SVG evidence.',
        { operationId: step.operationId, context: { expectedTexts } },
      );
    }
    return {
      wrote: true,
      createdBlockIds: [discovered.blockId],
      resourceTokens: [discovered.token],
      prewriteResourceEvidence: [],
      verifiedResourceEvidence: [verified],
      snapshot: observed,
      ...(providerRevision !== undefined ? { providerRevision } : {}),
    };
  } catch (cause) {
    const candidates = imageReplacementCandidates(step, current, lastObserved);
    const candidateTokens = candidates.flatMap((blockId) => {
      const token = resourceToken(nodeIndex(lastObserved).get(blockId), 'whiteboard');
      return token ? [token] : [];
    });
    throw new ActionProgressError({
      cause: providerCause ?? cause,
      wrote: true,
      createdBlockIds: candidates,
      resourceTokens: candidateTokens,
      lastSnapshot: lastObserved,
      phase: 'verification',
      attempted: true,
      ...(providerRevision !== undefined ? { providerRevision } : {}),
      recoveryDisposition: 'manual_inspection_required',
    });
  }
}

function whiteboardEvidence(token: string, raw: unknown): ResourceStateEvidence {
  return {
    resourceKind: 'whiteboard',
    token,
    rawHash: canonicalWhiteboardRawHash(raw),
    raw: structuredClone(raw),
  };
}

function providerProvedNoWrite(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as { writeAccepted?: unknown; details?: { writeAccepted?: unknown } };
  return record.writeAccepted === false || record.details?.writeAccepted === false;
}

async function overwriteWhiteboardWithRetry(
  transport: DocxTransport,
  input: Parameters<DocxTransport['overwriteWhiteboard']>[0],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await transport.overwriteWhiteboard(input);
      return;
    } catch (cause) {
      const delayMs = WHITEBOARD_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isWhiteboardApplyingError(cause)) throw cause;
      await delay(delayMs);
    }
  }
}

async function queryWhiteboardWithRetry(
  transport: DocxTransport,
  token: string,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transport.queryWhiteboard(token);
    } catch (cause) {
      const delayMs = WHITEBOARD_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined ||
        (!isWhiteboardApplyingError(cause) && !isWhiteboardRawNotReadyError(cause))) throw cause;
      await delay(delayMs);
    }
  }
}

function isWhiteboardApplyingError(cause: unknown): boolean {
  if (cause && typeof cause === 'object') {
    const record = cause as {
      code?: unknown;
      details?: { providerCode?: unknown };
      cause?: unknown;
    };
    if (record.code === 4003101 || record.details?.providerCode === 4003101) return true;
    if (record.cause !== undefined && isWhiteboardApplyingError(record.cause)) return true;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:"code"\s*:\s*4003101\b|\b4003101\b)/.test(message) &&
    /(?:doc is applying|doc data is not ready|resource error|whiteboard)/i.test(message);
}

function isWhiteboardRawNotReadyError(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const record = cause as { details?: { subtype?: unknown }; cause?: unknown };
  if (record.details?.subtype === 'whiteboard_raw_not_ready') return true;
  return record.cause !== undefined && isWhiteboardRawNotReadyError(record.cause);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverImageReplacement(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  targetBlockId: string,
): { blockId: string; token: string } {
  const beforeTarget = nodeIndex(before).get(targetBlockId);
  const parentId = beforeTarget?.parentBlockId;
  if (!beforeTarget || !parentId) {
    throw new EngineExecutionError('readback_assertion_failed', 'Image replacement target has no parent.', {
      operationId: step.operationId,
    });
  }
  const beforeParent = nodeIndex(before).get(parentId)!;
  const afterParent = nodeIndex(after).get(parentId);
  assertParentSemanticUnchanged(beforeParent, afterParent, step.operationId);
  const targetIndex = beforeParent.childBlockIds.indexOf(targetBlockId);
  const preceding = targetIndex === 0 ? parentId : beforeParent.childBlockIds[targetIndex - 1]!;
  const following = beforeParent.childBlockIds[targetIndex + 1];
  const candidates = afterParent
    ? idsBetween(afterParent.childBlockIds, parentId, preceding, following)
    : [];
  if (candidates.length !== 1) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      `Image replacement produced ${candidates.length} blocks; exactly one Whiteboard is required.`,
      { operationId: step.operationId, context: { candidates } },
    );
  }
  const blockId = candidates[0]!;
  const board = nodeIndex(after).get(blockId);
  const token = resourceToken(board, 'whiteboard');
  if (!board || board.kind !== 'whiteboard' || board.blockType !== 43 || !token) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      'Image replacement did not produce one identifiable Whiteboard block.',
      { operationId: step.operationId, context: { blockId, actualKind: board?.kind } },
    );
  }
  const expectedChildren = [...beforeParent.childBlockIds];
  expectedChildren.splice(targetIndex, 1, blockId);
  if (!sameStrings(afterParent?.childBlockIds, expectedChildren)) {
    throw new EngineExecutionError('unplanned_remote_change', 'Image replacement changed surrounding siblings.', {
      operationId: step.operationId,
      context: { expectedChildBlockIds: expectedChildren, actualChildBlockIds: afterParent?.childBlockIds },
    });
  }
  const allowed = new Set([parentId, targetBlockId, blockId]);
  const unplanned = changedBlockIds(before, after).filter((id) => !allowed.has(id));
  if (unplanned.length > 0) {
    throw new EngineExecutionError('unplanned_remote_change', 'Image replacement changed unrelated blocks.', {
      operationId: step.operationId,
      context: { unplannedBlockIds: unplanned },
    });
  }
  return { blockId, token };
}

function imageReplacementCandidates(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): string[] {
  const action = step.actions.find((item) => item.kind === 'replace-image-with-svg');
  if (!action || action.kind !== 'replace-image-with-svg') return [];
  const target = nodeIndex(before).get(action.targetBlockId);
  if (!target?.parentBlockId) return [];
  const beforeParent = nodeIndex(before).get(target.parentBlockId);
  const afterParent = nodeIndex(after).get(target.parentBlockId);
  if (!beforeParent || !afterParent) return [];
  const index = beforeParent.childBlockIds.indexOf(action.targetBlockId);
  const preceding = index === 0 ? beforeParent.blockId : beforeParent.childBlockIds[index - 1]!;
  const following = beforeParent.childBlockIds[index + 1];
  return idsBetween(afterParent.childBlockIds, afterParent.blockId, preceding, following)
    .filter((blockId) => blockId !== action.targetBlockId);
}

function isPendingImageReplacementReadback(
  cause: unknown,
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  targetBlockId: string,
): boolean {
  if (!(cause instanceof EngineExecutionError) || cause.code !== 'readback_assertion_failed') return false;
  if (before.documentId !== after.documentId || before.canonicalHash !== after.canonicalHash) return false;
  const target = nodeIndex(after).get(targetBlockId);
  return target?.blockId === targetBlockId &&
    imageReplacementCandidates(step, before, after).length === 0;
}

async function executeInsertSegments(
  transport: DocxTransport,
  documentId: string,
  batchFingerprint: string,
  step: PreparedMutationStep,
  action: Extract<PreparedMutationAction, { kind: 'insert-segments' }>,
  actionIndex: number,
  initialSnapshot: DocumentSnapshot,
): Promise<ActionResult> {
  let snapshot = initialSnapshot;
  let anchorBlockId = action.insertAfterBlockId;
  const createdBlockIds: string[] = [];
  let wrote = false;
  let attempted = false;
  let providerRevision: string | undefined;
  let phase: 'provider' | 'verification' = 'provider';
  try {
    for (const [segmentIndex, segment] of action.segments.entries()) {
      const segmentBefore = snapshot;
      if (segment.kind === 'provider-blocks') {
        const parent = nodeIndex(snapshot).get(action.parentBlockId);
        if (!parent) throw new Error(`Insert parent ${action.parentBlockId} disappeared.`);
        const rawAnchorIndex = anchorBlockId === parent.blockId
          ? -1
          : parent.childBlockIds.indexOf(anchorBlockId);
        if (anchorBlockId !== parent.blockId && rawAnchorIndex < 0) {
          throw new Error(`Insert anchor ${anchorBlockId} disappeared.`);
        }
        const index = rawAnchorIndex + 1;
        if (segment.blocks.some(hasProviderChildren)) {
          try {
            const result = await createVerifiedStructuredTree({
              transport,
              documentId,
              batchFingerprint,
              operationId: step.operationId,
              actionIndex,
              segmentIndex,
              parentBlockId: action.parentBlockId,
              insertionIndex: index,
              desiredTrees: structuredClone(segment.blocks) as ProviderBlock[],
              operationBefore: segmentBefore,
              currentSnapshot: snapshot,
            });
            wrote = true;
            attempted = true;
            snapshot = result.snapshot;
            providerRevision = result.providerRevision ?? providerRevision;
            appendUnique(createdBlockIds, result.createdBlockIds);
            anchorBlockId = result.createdBlockIds.filter((blockId) =>
              nodeIndex(snapshot).get(blockId)?.parentBlockId === action.parentBlockId
            ).at(-1) ?? anchorBlockId;
            phase = 'provider';
            continue;
          } catch (cause) {
            if (cause instanceof StructuredTreeProgressError) {
              throw new ActionProgressError({
                cause: cause.cause ?? cause,
                wrote: wrote || cause.wrote,
                createdBlockIds: [
                  ...createdBlockIds,
                  ...cause.createdBlockIds.filter((blockId) => !createdBlockIds.includes(blockId)),
                ],
                lastSnapshot: cause.lastSnapshot,
                phase: cause.phase,
                attempted: cause.attempted,
                ...(cause.providerRevision !== undefined
                  ? { providerRevision: cause.providerRevision }
                  : {}),
                recoveryDisposition: cause.recoveryDisposition,
              });
            }
            throw cause;
          }
        }
        attempted = true;
        const result = await transport.createChildren({
          documentId,
          parentBlockId: action.parentBlockId,
          index,
          blocks: structuredClone(segment.blocks) as ProviderBlock[],
          clientToken: canonicalHash({
            idempotencyToken: step.idempotencyToken,
            actionIndex,
            segmentIndex,
          }),
        });
        wrote = true;
        if (result.revision !== undefined) providerRevision = result.revision;
        const ids = providerBlockIds(result.blocks);
        const topLevelIds = result.blocks.map((block) => block.block_id).filter(
          (blockId): blockId is string => typeof blockId === 'string' && blockId.length > 0,
        );
        appendUnique(createdBlockIds, ids);
        if (topLevelIds.length > 0) anchorBlockId = topLevelIds.at(-1)!;
        phase = 'verification';
        snapshot = await fetchAndVerifyCreatedProviderSegment({
          transport,
          documentId,
          step,
          action,
          desiredIndex: segment.desiredIndex,
          before: segmentBefore,
          topLevelIds,
          insertionIndex: index,
          retryEventuallyConsistentReadback: segment.blocks.length === 1 && segment.blocks[0]?.block_type === 14,
        });
      } else {
        const beforeParent = nodeIndex(segmentBefore).get(action.parentBlockId);
        if (!beforeParent) throw new Error(`Insert parent ${action.parentBlockId} disappeared.`);
        const rawAnchorIndex = anchorBlockId === beforeParent.blockId
          ? -1
          : beforeParent.childBlockIds.indexOf(anchorBlockId);
        if (anchorBlockId !== beforeParent.blockId && rawAnchorIndex < 0) {
          throw new Error(`Insert anchor ${anchorBlockId} disappeared.`);
        }
        attempted = true;
        const result = await transport.insertAfter({
          documentId,
          blockId: anchorBlockId,
          content: segment.xml,
          format: 'xml',
        });
        wrote = true;
        if (result.revision !== undefined) providerRevision = result.revision;
        phase = 'verification';
        snapshot = await fetchSnapshot(transport, documentId);
        if (result.revision !== undefined && segment.nodeKind === 'table') {
          assertExactProviderRevision(result.revision, snapshot, step.operationId);
        }
        const ids = insertedIdsBetween(
          segmentBefore,
          snapshot,
          action.parentBlockId,
          anchorBlockId,
          action.insertBeforeBlockId,
        );
        if (ids.length === 0) throw new Error('XML insert did not create a discoverable sibling block.');
        appendUnique(createdBlockIds, ids);
        verifyInsertSegmentPrefix(
          step,
          action,
          segment.desiredIndex,
          segmentBefore,
          snapshot,
          ids,
          rawAnchorIndex + 1,
        );
        anchorBlockId = ids.at(-1)!;
        phase = 'provider';
        continue;
      }
      phase = 'provider';
    }
  } catch (cause) {
    if (cause instanceof ActionProgressError) throw cause;
    throw new ActionProgressError({
      cause,
      wrote,
      createdBlockIds,
      lastSnapshot: snapshot,
      phase,
      attempted,
      ...(providerRevision !== undefined ? { providerRevision } : {}),
    });
  }
  return {
    wrote,
    createdBlockIds,
    resourceTokens: [],
    prewriteResourceEvidence: [],
    verifiedResourceEvidence: [],
    snapshot,
    structuredTree: action.segments.some(
      (segment) => segment.kind === 'provider-blocks' && segment.blocks.some(hasProviderChildren),
    ),
    ...(providerRevision !== undefined ? { providerRevision } : {}),
  };
}

async function fetchAndVerifyCreatedProviderSegment(input: {
  transport: DocxTransport;
  documentId: string;
  step: PreparedMutationStep;
  action: Extract<PreparedMutationAction, { kind: 'insert-segments' }>;
  desiredIndex: number;
  before: DocumentSnapshot;
  topLevelIds: string[];
  insertionIndex: number;
  retryEventuallyConsistentReadback: boolean;
}): Promise<DocumentSnapshot> {
  for (let attempt = 0; ; attempt += 1) {
    const snapshot = await fetchSnapshot(input.transport, input.documentId);
    try {
      verifyInsertSegmentPrefix(
        input.step,
        input.action,
        input.desiredIndex,
        input.before,
        snapshot,
        input.topLevelIds,
        input.insertionIndex,
      );
      return snapshot;
    } catch (cause) {
      const delayMs = CREATED_CODE_READBACK_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !input.retryEventuallyConsistentReadback ||
        !isPendingCreatedBlockReadback(cause, input.before, snapshot)) throw cause;
      await delay(delayMs);
    }
  }
}

function isPendingCreatedBlockReadback(
  cause: unknown,
  before: DocumentSnapshot,
  snapshot: DocumentSnapshot,
): boolean {
  return cause instanceof EngineExecutionError &&
    cause.code === 'readback_assertion_failed' &&
    cause.message === 'Insert segment returned block IDs that do not exist in readback.' &&
    before.documentId === snapshot.documentId &&
    before.canonicalHash === snapshot.canonicalHash;
}

function emptyActionResult(wrote: boolean): ActionResult {
  return {
    wrote,
    createdBlockIds: [],
    resourceTokens: [],
    prewriteResourceEvidence: [],
    verifiedResourceEvidence: [],
  };
}

function verifyInsertSegmentPrefix(
  step: PreparedMutationStep,
  action: Extract<PreparedMutationAction, { kind: 'insert-segments' }>,
  desiredIndex: number,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  insertedTopLevelIds: string[],
  insertionIndex: number,
): void {
  const beforeNodes = nodeIndex(before);
  const afterNodes = nodeIndex(after);
  const beforeParent = beforeNodes.get(action.parentBlockId);
  const afterParent = afterNodes.get(action.parentBlockId);
  if (!beforeParent || !afterParent) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      `Insert segment parent ${action.parentBlockId} disappeared.`,
      { operationId: step.operationId },
    );
  }
  if (insertedTopLevelIds.length === 0 || insertedTopLevelIds.some((id) => !afterNodes.has(id))) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      'Insert segment returned block IDs that do not exist in readback.',
      { operationId: step.operationId, context: { insertedTopLevelIds } },
    );
  }
  const expectedChildren = [...beforeParent.childBlockIds];
  expectedChildren.splice(insertionIndex, 0, ...insertedTopLevelIds);
  if (!sameStrings(afterParent.childBlockIds, expectedChildren)) {
    throw new EngineExecutionError(
      'unplanned_remote_change',
      'Insert segment changed the parent child sequence outside its exact prefix.',
      {
        operationId: step.operationId,
        context: {
          expectedChildBlockIds: expectedChildren,
          actualChildBlockIds: afterParent.childBlockIds,
        },
      },
    );
  }
  assertParentSemanticUnchanged(beforeParent, afterParent, step.operationId);
  if (step.intent.kind !== 'insert') {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      'Insert segment is not backed by a prepared insert intent.',
      { operationId: step.operationId },
    );
  }
  const desired = step.intent.desired[desiredIndex];
  if (!desired || !matchesDesiredIds(after, insertedTopLevelIds, [desired])) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      `Insert segment ${desiredIndex} does not match its prepared content.`,
      { operationId: step.operationId, context: { desiredIndex, insertedTopLevelIds } },
    );
  }
  const allowed = new Set<string>([action.parentBlockId]);
  const visit = (blockId: string): void => {
    if (allowed.has(blockId)) return;
    allowed.add(blockId);
    for (const childId of afterNodes.get(blockId)?.childBlockIds ?? []) visit(childId);
  };
  insertedTopLevelIds.forEach(visit);
  const unplanned = changedBlockIds(before, after).filter((blockId) => !allowed.has(blockId));
  if (unplanned.length > 0) {
    throw new EngineExecutionError(
      'unplanned_remote_change',
      'Insert segment changed unrelated blocks before the next segment.',
      { operationId: step.operationId, context: { unplannedBlockIds: unplanned } },
    );
  }
}

function assertReadback(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): void {
  for (const assertion of step.assertions.readback) {
    assertOneReadback(assertion, step, before, after);
  }
}

function assertOneReadback(
  assertion: PreparedReadbackAssertion,
  step: PreparedMutationStep,
  _before: DocumentSnapshot,
  after: DocumentSnapshot,
): void {
  const nodes = nodeIndex(after);
  const fail = (message: string, context: Record<string, unknown> = {}): never => {
    throw new EngineExecutionError('readback_assertion_failed', message, {
      operationId: step.operationId,
      context: { assertion, ...context },
    });
  };
  switch (assertion.kind) {
    case 'node-hash':
      if (nodes.get(assertion.blockId)?.canonicalHash !== assertion.expectedHash) {
        fail(`Node hash readback failed for ${assertion.blockId}.`);
      }
      return;
    case 'blocks-absent':
      if (assertion.blockIds.some((blockId) => nodes.has(blockId))) {
        fail('Deleted blocks remain in provider readback.');
      }
      return;
    case 'sibling-order':
      if (!sameStrings(
        nodes.get(assertion.parentBlockId)?.childBlockIds,
        assertion.expectedChildBlockIds,
      )) {
        fail(`Sibling order readback failed for ${assertion.parentBlockId}.`);
      }
      return;
    case 'desired-node': {
      const intent = step.intent;
      if (intent.kind !== 'replace') return fail('Desired-node assertion requires a replace intent.');
      if (canonicalHash(intent.desired) !== assertion.desiredHash) {
        return fail('Desired-node assertion does not match its prepared replace intent.');
      }
      if (!matchesReplaceDesired(after, step, assertion.targetBlockId, intent.desired)) {
        fail(`Desired-node readback failed for ${assertion.targetBlockId}.`);
      }
      return;
    }
    case 'inserted-desired': {
      const intent = step.intent;
      if (intent.kind !== 'insert') return fail('Inserted-desired assertion requires an insert intent.');
      if (canonicalHash(intent.desired) !== assertion.desiredHash) {
        return fail('Inserted-desired assertion does not match its prepared insert intent.');
      }
      const parent = nodes.get(assertion.parentBlockId);
      if (!parent) return fail(`Insert parent ${assertion.parentBlockId} is missing.`);
      const ids = idsBetween(
        parent.childBlockIds,
        parent.blockId,
        assertion.precedingBlockId,
        assertion.followingBlockId,
      );
      if (!matchesDesiredIds(after, ids, intent.desired)) {
        fail('Inserted desired content does not match provider readback.', { insertedBlockIds: ids });
      }
      return;
    }
    case 'whiteboard-content':
      if (step.intent.kind !== 'whiteboard-overwrite') {
        return fail('Whiteboard-content assertion requires a Whiteboard overwrite intent.');
      }
      {
        const target = nodes.get(assertion.targetBlockId);
        if (!target || target.kind !== 'whiteboard' || target.blockType !== 43 ||
          resourceToken(target, 'whiteboard') !== assertion.targetToken) {
          fail('Whiteboard block identity changed during resource overwrite.');
        }
      }
      return;
    case 'image-replaced-with-svg-whiteboard': {
      if (step.intent.kind !== 'whiteboard-overwrite') {
        return fail('Image replacement assertion requires a Whiteboard overwrite intent.');
      }
      const action = step.actions.find((item) => item.kind === 'replace-image-with-svg');
      if (!action || action.kind !== 'replace-image-with-svg') {
        return fail('Image replacement assertion has no prepared replacement action.');
      }
      discoverImageReplacement(step, _before, after, action.targetBlockId);
      return;
    }
  }
}

function assertNoUnplannedChanges(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): void {
  const changed = changedBlockIds(before, after);
  const allowed = allowedChangedBlockIds(step, before, after);
  const unplanned = changed.filter((blockId) => !allowed.has(blockId));
  if (unplanned.length > 0) {
    throw new EngineExecutionError(
      'unplanned_remote_change',
      `Operation ${step.operationId} changed blocks outside its prepared scope.`,
      { operationId: step.operationId, context: { changedBlockIds: changed, unplannedBlockIds: unplanned } },
    );
  }
}

function verifyStepReadback(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): void {
  assertReadback(step, before, after);
  assertExactStructuralDelta(step, before, after);
  assertNoUnplannedChanges(step, before, after);
}

function assertExactStructuralDelta(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): void {
  const beforeNodes = nodeIndex(before);
  const afterNodes = nodeIndex(after);
  const fail = (message: string, context: Record<string, unknown>): never => {
    throw new EngineExecutionError('unplanned_remote_change', message, {
      operationId: step.operationId,
      context,
    });
  };
  switch (step.intent.kind) {
    case 'assert':
      if (!sameSnapshot(before, after)) {
        fail('Assert-only operation observed a document change.', {});
      }
      return;
    case 'replace': {
      const target = beforeNodes.get(step.intent.targetBlockId);
      const parentId = target?.parentBlockId;
      if (!parentId) {
        const beforeRoot = beforeNodes.get(before.rootBlockId);
        const afterRoot = afterNodes.get(after.rootBlockId);
        if (!sameStrings(afterRoot?.childBlockIds, beforeRoot?.childBlockIds ?? [])) {
          fail('Title replacement changed page child order.', {
            expectedChildBlockIds: beforeRoot?.childBlockIds,
            actualChildBlockIds: afterRoot?.childBlockIds,
          });
        }
        return;
      }
      const expected = [...(beforeNodes.get(parentId)?.childBlockIds ?? [])];
      const actual = afterNodes.get(parentId)?.childBlockIds;
      assertParentSemanticUnchanged(beforeNodes.get(parentId), afterNodes.get(parentId), step.operationId);
      const boundary = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
      if (!boundary || boundary.kind !== 'sibling-boundary' || !actual) {
        return fail('Replace operation has no exact prepared sibling boundary.', { parentBlockId: parentId });
      }
      const replacements = idsBetween(
        actual,
        parentId,
        boundary.precedingBlockId,
        boundary.followingBlockId,
      );
      if (replacements.length === 0) {
        fail('Replace operation did not produce a replacement block.', { replacements });
      }
      const index = expected.indexOf(step.intent.targetBlockId);
      expected.splice(index, 1, ...replacements);
      if (!sameStrings(actual, expected)) {
        fail('Replace operation changed parent child order.', {
          parentBlockId: parentId,
          expectedChildBlockIds: expected,
          actualChildBlockIds: actual,
        });
      }
      return;
    }
    case 'insert': {
      const beforeParent = beforeNodes.get(step.intent.parentBlockId);
      const afterParent = afterNodes.get(step.intent.parentBlockId);
      if (!beforeParent || !afterParent) return fail('Insert parent disappeared.', { parentBlockId: step.intent.parentBlockId });
      const assertion = step.assertions.readback.find((item) => item.kind === 'inserted-desired');
      if (!assertion || assertion.kind !== 'inserted-desired') {
        return fail('Insert operation has no prepared desired boundary.', {});
      }
      const inserted = idsBetween(
        afterParent.childBlockIds,
        afterParent.blockId,
        assertion.precedingBlockId,
        assertion.followingBlockId,
      );
      const rawAnchorIndex = assertion.precedingBlockId === beforeParent.blockId
        ? -1
        : beforeParent.childBlockIds.indexOf(assertion.precedingBlockId);
      if (assertion.precedingBlockId !== beforeParent.blockId && rawAnchorIndex < 0) {
        fail('Insert anchor disappeared from prewrite snapshot.', { anchorBlockId: assertion.precedingBlockId });
      }
      const expected = [...beforeParent.childBlockIds];
      assertParentSemanticUnchanged(beforeParent, afterParent, step.operationId);
      expected.splice(rawAnchorIndex + 1, 0, ...inserted);
      if (!sameStrings(afterParent.childBlockIds, expected)) {
        fail('Insert operation produced an unexpected parent child order.', {
          expectedChildBlockIds: expected,
          actualChildBlockIds: afterParent.childBlockIds,
        });
      }
      return;
    }
    case 'delete': {
      const intent = step.intent;
      const beforeParent = beforeNodes.get(intent.parentBlockId);
      const afterParent = afterNodes.get(intent.parentBlockId);
      const expected = (beforeParent?.childBlockIds ?? []).filter((id) => !intent.blockIds.includes(id));
      assertParentSemanticUnchanged(beforeParent, afterParent, step.operationId);
      if (!sameStrings(afterParent?.childBlockIds, expected)) {
        fail('Delete operation produced an unexpected parent child order.', {
          expectedChildBlockIds: expected,
          actualChildBlockIds: afterParent?.childBlockIds,
        });
      }
      return;
    }
    case 'move': {
      const intent = step.intent;
      const beforeParent = beforeNodes.get(intent.parentBlockId);
      const afterParent = afterNodes.get(intent.parentBlockId);
      const remaining = (beforeParent?.childBlockIds ?? []).filter((id) => !intent.blockIds.includes(id));
      assertParentSemanticUnchanged(beforeParent, afterParent, step.operationId);
      const rawAnchorIndex = intent.insertAfterBlockId === intent.parentBlockId
        ? -1
        : remaining.indexOf(intent.insertAfterBlockId);
      if (intent.insertAfterBlockId !== intent.parentBlockId && rawAnchorIndex < 0) {
        fail('Move anchor disappeared from prewrite snapshot.', { anchorBlockId: intent.insertAfterBlockId });
      }
      remaining.splice(rawAnchorIndex + 1, 0, ...intent.blockIds);
      if (!sameStrings(afterParent?.childBlockIds, remaining)) {
        fail('Move operation produced an unexpected parent child order.', {
          expectedChildBlockIds: remaining,
          actualChildBlockIds: afterParent?.childBlockIds,
        });
      }
      return;
    }
    case 'whiteboard-overwrite':
      if (step.actions.some((action) => action.kind === 'replace-image-with-svg')) {
        const action = step.actions.find((item) => item.kind === 'replace-image-with-svg')!;
        discoverImageReplacement(
          step,
          before,
          after,
          (action as Extract<PreparedMutationAction, { kind: 'replace-image-with-svg' }>).targetBlockId,
        );
      } else if (!sameSnapshot(before, after)) {
        fail('Existing Whiteboard overwrite changed the Docx block snapshot.', {});
      }
      return;
  }
}

function assertParentSemanticUnchanged(
  before: SnapshotNode | undefined,
  after: SnapshotNode | undefined,
  operationId: string,
): void {
  if (!before || !after || parentSemanticHash(before) !== parentSemanticHash(after)) {
    throw new EngineExecutionError(
      'unplanned_remote_change',
      `Operation ${operationId} changed parent content outside its child relationship.`,
      {
        operationId,
        context: {
          parentBlockId: before?.blockId ?? after?.blockId,
          expectedParentSemanticHash: before ? parentSemanticHash(before) : undefined,
          actualParentSemanticHash: after ? parentSemanticHash(after) : undefined,
        },
      },
    );
  }
}

function parentSemanticHash(node: SnapshotNode): string {
  const raw = structuredClone(node.raw);
  delete raw.block_id;
  delete raw.parent_id;
  delete raw.children;
  for (const key of Object.keys(raw)) {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (normalized === 'revision' || normalized === 'revisionid' ||
      normalized === 'documentrevision' || normalized === 'documentrevisionid') {
      delete raw[key];
    }
  }
  const table = asRecord(raw.table);
  if (table) delete table.cells;
  return canonicalHash({ blockType: node.blockType, kind: node.kind, raw });
}

function allowedChangedBlockIds(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): Set<string> {
  const allowed = new Set<string>();
  const beforeNodes = nodeIndex(before);
  const afterNodes = nodeIndex(after);
  const addSubtree = (snapshot: DocumentSnapshot, blockId: string): void => {
    const index = nodeIndex(snapshot);
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      allowed.add(id);
      for (const childId of index.get(id)?.childBlockIds ?? []) visit(childId);
    };
    visit(blockId);
  };

  switch (step.intent.kind) {
    case 'assert':
      return allowed;
    case 'replace': {
      if (step.intent.targetBlockId === before.rootBlockId) {
        allowed.add(step.intent.targetBlockId);
      } else {
        addSubtree(before, step.intent.targetBlockId);
      }
      const targetBefore = beforeNodes.get(step.intent.targetBlockId);
      if (targetBefore?.parentBlockId) {
        allowed.add(targetBefore.parentBlockId);
        const boundary = step.assertions.preflight.find(
          (item) => item.kind === 'sibling-boundary',
        );
        if (boundary?.kind === 'sibling-boundary') {
          const parentAfter = afterNodes.get(boundary.parentBlockId);
          if (parentAfter) {
            for (const id of idsBetween(
              parentAfter.childBlockIds,
              parentAfter.blockId,
              boundary.precedingBlockId,
              boundary.followingBlockId,
            )) addSubtree(after, id);
          }
        }
      }
      if (step.intent.targetBlockId === after.rootBlockId) {
        allowed.add(step.intent.targetBlockId);
      } else {
        addSubtree(after, step.intent.targetBlockId);
      }
      return allowed;
    }
    case 'insert': {
      allowed.add(step.intent.parentBlockId);
      const parentAfter = afterNodes.get(step.intent.parentBlockId);
      const assertion = step.assertions.readback.find(
        (item) => item.kind === 'inserted-desired',
      );
      if (parentAfter) {
        for (const id of idsBetween(
          parentAfter.childBlockIds,
          parentAfter.blockId,
          assertion?.kind === 'inserted-desired'
            ? assertion.precedingBlockId
            : step.intent.insertAfterBlockId,
          assertion?.kind === 'inserted-desired'
            ? assertion.followingBlockId
            : step.intent.insertBeforeBlockId,
        )) addSubtree(after, id);
      }
      return allowed;
    }
    case 'delete':
      allowed.add(step.intent.parentBlockId);
      for (const id of step.intent.blockIds) addSubtree(before, id);
      return allowed;
    case 'move':
      allowed.add(step.intent.parentBlockId);
      return allowed;
    case 'whiteboard-overwrite':
      if (step.actions.some((action) => action.kind === 'replace-image-with-svg')) {
        const action = step.actions.find((item) => item.kind === 'replace-image-with-svg')!;
        const targetId = (action as Extract<PreparedMutationAction, { kind: 'replace-image-with-svg' }>).targetBlockId;
        const target = beforeNodes.get(targetId);
        if (target?.parentBlockId) {
          allowed.add(target.parentBlockId);
          addSubtree(before, targetId);
          const beforeParent = beforeNodes.get(target.parentBlockId);
          const afterParent = afterNodes.get(target.parentBlockId);
          if (beforeParent && afterParent) {
            const index = beforeParent.childBlockIds.indexOf(targetId);
            const preceding = index === 0 ? target.parentBlockId : beforeParent.childBlockIds[index - 1]!;
            const following = beforeParent.childBlockIds[index + 1];
            for (const id of idsBetween(afterParent.childBlockIds, target.parentBlockId, preceding, following)) {
              addSubtree(after, id);
            }
          }
        }
      }
      return allowed;
  }
}

function matchesReplaceDesired(
  snapshot: DocumentSnapshot,
  step: PreparedMutationStep,
  targetBlockId: string,
  desired: DesiredNode,
): boolean {
  const index = nodeIndex(snapshot);
  if (targetBlockId === snapshot.rootBlockId) {
    const root = index.get(targetBlockId);
    return Boolean(root && matchesDesiredNode(snapshot, root, desired));
  }
  const boundary = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
  if (boundary?.kind === 'sibling-boundary') {
    const parent = index.get(boundary.parentBlockId);
    if (!parent) return false;
    const ids = idsBetween(
      parent.childBlockIds,
      parent.blockId,
      boundary.precedingBlockId,
      boundary.followingBlockId,
    );
    return matchesDesiredIds(snapshot, ids, [desired]);
  }
  const target = index.get(targetBlockId);
  return Boolean(target && matchesDesiredNode(snapshot, target, desired));
}

function matchesDesiredIds(
  snapshot: DocumentSnapshot,
  ids: string[],
  desired: DesiredNode[],
): boolean {
  let cursor = 0;
  for (const node of desired) {
    if (node.kind === 'list') {
      const count = node.items.length;
      const actualIds = ids.slice(cursor, cursor + count);
      if (actualIds.length !== count || !matchesDesiredList(snapshot, actualIds, node)) return false;
      cursor += count;
    } else {
      const actual = nodeIndex(snapshot).get(ids[cursor] ?? '');
      if (!actual || !matchesDesiredNode(snapshot, actual, node)) return false;
      cursor += 1;
    }
  }
  return cursor === ids.length;
}

function matchesDesiredNode(
  snapshot: DocumentSnapshot,
  actual: SnapshotNode,
  desired: DesiredNode,
): boolean {
  if (desired.kind === 'table') return matchesTable(snapshot, actual, desired);
  if (desired.kind === 'callout') return matchesCallout(snapshot, actual, desired);
  if (desired.kind === 'list') return matchesDesiredList(snapshot, [actual.blockId], desired);
  const decoded = decodeOrdinaryNode(actual);
  return decoded !== undefined && canonicalHash(decoded) === canonicalHash(desired);
}

function matchesTable(
  snapshot: DocumentSnapshot,
  actual: SnapshotNode,
  desired: Extract<DesiredNode, { kind: 'table' }>,
): boolean {
  if (actual.kind !== 'table' || actual.blockType !== 31) return false;
  const table = asRecord(actual.raw.table);
  const property = asRecord(table?.property);
  const rows = property?.row_size;
  const columns = property?.column_size;
  const desiredRows = desired.rows.length;
  const desiredColumns = desired.rows[0]?.cells.length ?? 0;
  if (rows !== desiredRows || columns !== desiredColumns ||
    desiredRows === 0 || desiredColumns === 0 ||
    actual.childBlockIds.length !== desiredRows * desiredColumns) return false;
  if (!hasExactUnmergedCellSemantics(property?.merge_info, desiredRows * desiredColumns)) return false;
  const index = nodeIndex(snapshot);
  let cellIndex = 0;
  for (const row of desired.rows) {
    if (row.cells.length !== desiredColumns) return false;
    for (const cell of row.cells) {
      const actualCell = index.get(actual.childBlockIds[cellIndex++]!);
      if (!actualCell || actualCell.blockType !== 32 || actualCell.kind !== 'opaque') return false;
      if (!matchesDesiredIds(snapshot, actualCell.childBlockIds, cell.content)) return false;
    }
  }
  return true;
}

function hasExactUnmergedCellSemantics(value: unknown, cellCount: number): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== cellCount) return false;
  return value.every((entry) => {
    if (entry === null || entry === undefined) return true;
    const info = asRecord(entry);
    return info?.row_span === 1 && info.col_span === 1;
  });
}

function matchesDesiredList(
  snapshot: DocumentSnapshot,
  blockIds: string[],
  desired: Extract<DesiredNode, { kind: 'list' }>,
): boolean {
  if (blockIds.length !== desired.items.length) return false;
  const index = nodeIndex(snapshot);
  return blockIds.every((blockId, itemIndex) => {
    const block = index.get(blockId);
    const item = desired.items[itemIndex]!;
    if (!block || block.kind !== 'list' || block.blockType !== (desired.ordered ? 13 : 12)) return false;
    if (canonicalHash(decodeInline(block.raw, desired.ordered ? 'ordered' : 'bullet')) !== canonicalHash(item.content)) return false;
    return matchesDesiredIds(snapshot, block.childBlockIds, item.children);
  });
}

function matchesCallout(
  snapshot: DocumentSnapshot,
  actual: SnapshotNode,
  desired: Extract<DesiredNode, { kind: 'callout' }>,
): boolean {
  if (actual.kind !== 'callout') return false;
  const raw = asRecord(actual.raw.callout);
  const emoji = stringValue(raw?.emoji_id) ?? stringValue(raw?.emoji);
  const actualType = emoji === '❗' ? 'warning' : emoji === '📘' ? 'note' : undefined;
  if (actualType && actualType !== desired.calloutType) return false;
  const index = nodeIndex(snapshot);
  const childNodes = actual.childBlockIds.map((id) => index.get(id)).filter(Boolean) as SnapshotNode[];
  let offset = 0;
  if (desired.title !== undefined) {
    const title = childNodes[0] && decodeOrdinaryNode(childNodes[0]);
    if (!title || title.kind !== 'paragraph' || inlineText(title.content) !== desired.title) return false;
    offset = 1;
  }
  return matchesDesiredIds(snapshot, childNodes.slice(offset).map(({ blockId }) => blockId), desired.children);
}

function decodeOrdinaryNode(node: SnapshotNode): DesiredNode | undefined {
  if (node.kind === 'page') return { kind: 'title', content: decodeInline(node.raw, 'page') };
  if (node.kind === 'paragraph') return { kind: 'paragraph', content: decodeInline(node.raw, 'text') };
  if (node.kind === 'heading') {
    const level = Math.min(6, Math.max(1, node.blockType - 2)) as 1 | 2 | 3 | 4 | 5 | 6;
    return { kind: 'heading', level, content: decodeInline(node.raw, `heading${level}`) };
  }
  if (node.kind === 'quote' || node.blockType === 15) {
    return { kind: 'quote', content: decodeInline(node.raw, 'quote') };
  }
  if (node.kind === 'code') {
    const code = asRecord(node.raw.code);
    const style = asRecord(code?.style);
    return {
      kind: 'code',
      language: providerLanguageName(style?.language),
      text: inlineText(decodeInline(node.raw, 'code')),
      ...(typeof style?.caption === 'string' && style.caption !== '' ? { caption: style.caption } : {}),
    };
  }
  return undefined;
}

function decodeInline(rawBlock: Record<string, unknown>, key: string): InlineContent[] {
  const payload = asRecord(rawBlock[key]);
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  return elements.flatMap((value): InlineContent[] => {
    const element = asRecord(value);
    const run = asRecord(element?.text_run);
    if (!run || typeof run.content !== 'string') return [];
    const style = asRecord(run.text_element_style);
    const link = asRecord(style?.link);
    if (typeof link?.url === 'string') {
      return [{ kind: 'link', text: run.content, url: normalizeProviderLinkUrl(link.url) }];
    }
    if (style?.inline_code === true) return [{ kind: 'code', text: run.content }];
    return [{
      kind: 'text',
      text: run.content,
      ...(style?.bold === true ? { bold: true } : {}),
      ...(style?.italic === true ? { italic: true } : {}),
      ...(style?.underline === true ? { underline: true } : {}),
      ...(style?.strikethrough === true ? { strike: true } : {}),
    }];
  });
}

function providerLanguageName(value: unknown): string {
  if (typeof value === 'string') return canonicalCodeLanguage(value);
  const known: Record<number, string> = {
    1: 'plaintext', 7: 'bash', 9: 'cpp', 10: 'c', 12: 'css', 15: 'dart',
    18: 'dockerfile', 19: 'erlang', 22: 'go', 23: 'groovy', 24: 'html', 26: 'http',
    27: 'haskell', 28: 'json', 29: 'java', 30: 'javascript', 32: 'kotlin', 33: 'latex',
    34: 'lisp', 36: 'lua', 37: 'matlab', 38: 'makefile', 40: 'markdown', 41: 'nginx',
    44: 'php', 45: 'perl', 47: 'powershell', 48: 'protobuf', 49: 'python', 50: 'python',
    52: 'ruby', 53: 'rust', 55: 'scss', 56: 'scheme', 57: 'sql', 58: 'scala',
    59: 'swift', 60: 'thrift', 62: 'shell', 64: 'typescript', 65: 'vb', 66: 'xml',
    67: 'yaml', 68: 'cmake', 69: 'diff', 70: 'gherkin', 71: 'graphql',
    73: 'properties', 74: 'solidity', 75: 'toml',
  };
  return typeof value === 'number' ? known[value] ?? 'plaintext' : 'plaintext';
}

function changedBlockIds(before: DocumentSnapshot, after: DocumentSnapshot): string[] {
  const beforeNodes = nodeIndex(before);
  const afterNodes = nodeIndex(after);
  return [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])]
    .filter((blockId) => beforeNodes.get(blockId)?.canonicalHash !== afterNodes.get(blockId)?.canonicalHash)
    .sort();
}

function addedBlockIds(before: DocumentSnapshot, after: DocumentSnapshot): string[] {
  const beforeIds = new Set(before.nodes.map(({ blockId }) => blockId));
  return after.nodes.filter(({ blockId }) => !beforeIds.has(blockId)).map(({ blockId }) => blockId);
}

function plannedCreatedBlockIds(
  step: PreparedMutationStep,
  before: DocumentSnapshot,
  after: DocumentSnapshot,
): string[] {
  const allowed = allowedChangedBlockIds(step, before, after);
  return addedBlockIds(before, after).filter((blockId) => allowed.has(blockId));
}

function insertedIdsBetween(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  parentBlockId: string,
  precedingBlockId: string,
  followingBlockId?: string,
): string[] {
  const beforeIds = new Set(before.nodes.map(({ blockId }) => blockId));
  const parent = nodeIndex(after).get(parentBlockId);
  if (!parent) return [];
  return idsBetween(parent.childBlockIds, parentBlockId, precedingBlockId, followingBlockId)
    .filter((blockId) => !beforeIds.has(blockId));
}

function idsBetween(
  childIds: string[],
  parentBlockId: string,
  precedingBlockId: string,
  followingBlockId?: string,
): string[] {
  const rawPrecedingIndex = precedingBlockId === parentBlockId
    ? -1
    : childIds.indexOf(precedingBlockId);
  if (precedingBlockId !== parentBlockId && rawPrecedingIndex < 0) return [];
  const start = rawPrecedingIndex + 1;
  const end = followingBlockId === undefined ? childIds.length : childIds.indexOf(followingBlockId);
  if (end < 0 || end < start) return [];
  return childIds.slice(start, end);
}

function matchesBoundary(
  childIds: string[],
  parentBlockId: string,
  precedingBlockId: string,
  followingBlockId: string | undefined,
  blockIds: string[],
): boolean {
  const actual = idsBetween(childIds, parentBlockId, precedingBlockId, followingBlockId);
  return sameStrings(actual, blockIds);
}

function emptyBoundaryMatches(
  childIds: string[],
  parentBlockId: string,
  precedingBlockId: string,
  followingBlockId?: string,
): boolean {
  return idsBetween(childIds, parentBlockId, precedingBlockId, followingBlockId).length === 0;
}

function resourceToken(node: SnapshotNode | undefined, kind: 'whiteboard'): string | undefined {
  const payload = asRecord(node?.raw[kind]) ?? asRecord(node?.raw.board);
  return stringValue(payload?.token);
}

function containsNestedList(intent: PreparedMutationStep['intent']): boolean {
  const desired = intent.kind === 'replace'
    ? [intent.desired]
    : intent.kind === 'insert'
      ? intent.desired
      : [];
  const nested = (node: DesiredNode): boolean => {
    if (node.kind === 'list') {
      return node.items.some((item) => item.children.length > 0);
    }
    if (node.kind === 'callout') return node.children.some(nested);
    if (node.kind === 'table') return node.rows.some((row) => row.cells.some((cell) => cell.content.some(nested)));
    return false;
  };
  return desired.some(nested);
}

function hasProviderChildren(block: PreparedProviderBlock): boolean {
  return Array.isArray(block.children) && block.children.length > 0;
}

function providerBlockIds(blocks: ProviderBlock[]): string[] {
  const ids: string[] = [];
  const visit = (block: ProviderBlock): void => {
    if (block.block_id) ids.push(block.block_id);
    for (const child of block.children ?? []) {
      if (typeof child !== 'string') visit(child);
    }
  };
  blocks.forEach(visit);
  return ids;
}

function nodeIndex(snapshot: DocumentSnapshot): Map<string, SnapshotNode> {
  return new Map(snapshot.nodes.map((node) => [node.blockId, node]));
}

function sameStrings(actual: string[] | undefined, expected: string[]): boolean {
  return actual !== undefined && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function appendUnique(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function appendResourceEvidence(
  target: ResourceStateEvidence[],
  values: ResourceStateEvidence[],
): void {
  for (const value of values) {
    const existing = target.find((entry) => entry.resourceKind === value.resourceKind &&
      entry.token === value.token && entry.rawHash === value.rawHash);
    if (!existing) target.push(structuredClone(value));
  }
}

function stepContainsNativeTable(step: PreparedMutationStep): boolean {
  return step.actions.some((action) =>
    (action.kind === 'replace-xml' && action.nodeKind === 'table') ||
    (action.kind === 'insert-segments' && action.segments.some(
      (segment) => segment.kind === 'xml' && segment.nodeKind === 'table',
    ))
  );
}

function assertExactProviderRevision(
  expectedRevision: string,
  snapshot: DocumentSnapshot,
  operationId: string,
): void {
  if (snapshot.revision !== expectedRevision) {
    throw new EngineExecutionError(
      'readback_assertion_failed',
      `Fixed-revision readback expected ${expectedRevision} but observed ${snapshot.revision}.`,
      { operationId, context: { expectedRevision, actualRevision: snapshot.revision } },
    );
  }
}

function assertProviderRevisionReached(
  expectedRevision: string,
  snapshot: DocumentSnapshot,
  operationId: string,
): void {
  if (/^\d+$/.test(expectedRevision) && /^\d+$/.test(snapshot.revision)) {
    if (BigInt(snapshot.revision) >= BigInt(expectedRevision)) return;
    throw new EngineExecutionError(
      'readback_assertion_failed',
      `Provider-revision readback expected at least ${expectedRevision} but observed ${snapshot.revision}.`,
      { operationId, context: { expectedRevision, actualRevision: snapshot.revision } },
    );
  }
  assertExactProviderRevision(expectedRevision, snapshot, operationId);
}

function inlineText(content: InlineContent[]): string {
  return content.map((item) => item.text).join('');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function executionError(
  code: EngineExecutionErrorCode,
  operationId: string,
  message: string,
  cause: unknown,
): EngineExecutionError {
  return isExecutionError(cause)
    ? cause
    : new EngineExecutionError(code, message, { operationId, cause });
}

function isExecutionError(error: unknown): error is EngineExecutionError {
  return error instanceof EngineExecutionError;
}

function partialError(input: {
  batch: PreparedMutationBatch;
  current: DocumentSnapshot;
  completed: VerifiedOperationEvidence[];
  failedStep: PreparedMutationStep;
  failedKind: string;
  cause: unknown;
  pendingSteps: PreparedMutationStep[];
  createdBlockIds: string[];
  resourceTokens?: string[];
  prewriteResourceEvidence?: ResourceStateEvidence[];
  verifiedResourceEvidence?: ResourceStateEvidence[];
  latestProviderRevision?: string;
  recoveryDisposition?: 'resume_possible' | 'manual_inspection_required';
}): PartialMutationError {
  const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
  const evidence: PartialMutationEvidence = {
    batchFingerprint: input.batch.fingerprint,
    beforeSnapshotHash: input.batch.beforeSnapshotHash,
    lastObservedRevision: input.latestProviderRevision ?? input.current.revision,
    lastObservedSnapshotHash: input.current.canonicalHash,
    completedOperations: structuredClone(input.completed),
    failedOperation: {
      operationId: input.failedStep.operationId,
      kind: input.failedKind,
      message,
      cause: sanitizeCause(input.cause),
    },
    pendingOperationIds: input.pendingSteps.map(({ operationId }) => operationId),
    createdBlockIds: [...new Set(input.createdBlockIds)],
    ...(input.resourceTokens && input.resourceTokens.length > 0
      ? { resourceTokens: [...new Set(input.resourceTokens)] }
      : {}),
    ...(input.prewriteResourceEvidence && input.prewriteResourceEvidence.length > 0
      ? { prewriteResourceEvidence: structuredClone(input.prewriteResourceEvidence) }
      : {}),
    ...(input.verifiedResourceEvidence && input.verifiedResourceEvidence.length > 0
      ? { verifiedResourceEvidence: structuredClone(input.verifiedResourceEvidence) }
      : {}),
    recoveryDisposition: input.recoveryDisposition ?? 'manual_inspection_required',
  };
  return new PartialMutationError(deepFreeze(evidence), { cause: input.cause });
}

function sanitizeCause(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'string' ||
    typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const result: Record<string, unknown> = { name: value.name, message: value.message };
    for (const [key, child] of Object.entries(value)) result[key] = sanitizeCause(child, seen);
    return result;
  }
  if (Array.isArray(value)) return value.map((child) => sanitizeCause(child, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeCause(child, seen)]),
  );
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || value instanceof Error) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
