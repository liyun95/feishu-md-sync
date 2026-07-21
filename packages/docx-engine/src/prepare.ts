import { calloutToXml, tableToXml, toProviderBlock, toProviderTree } from './codec.js';
import { canonicalHash } from './hash.js';
import type {
  DesiredNode,
  DocumentSnapshot,
  MutationIntent,
  PreparedInsertSegment,
  PreparedMutationAction,
  PreparedMutationAssertions,
  PreparedMutationBatch,
  PreparedMutationStep,
  PrepareMutationInput,
  SnapshotNode,
} from './model.js';

export const ENGINE_VERSION = '0.1.0';
export const ENGINE_SCHEMA_VERSION = 1;

export type MutationPreflightErrorCode =
  | 'anchor_missing'
  | 'batch_integrity_mismatch'
  | 'duplicate_block_id'
  | 'duplicate_operation_id'
  | 'hash_mismatch'
  | 'invalid_operation'
  | 'non_adjacent_anchors'
  | 'parent_mismatch'
  | 'parent_missing'
  | 'root_mutation_forbidden'
  | 'target_missing';

export interface MutationPreflightErrorOptions {
  operationId?: string;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export class MutationPreflightError extends Error {
  readonly code: MutationPreflightErrorCode;
  readonly operationId?: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: MutationPreflightErrorCode,
    message: string,
    options: MutationPreflightErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MutationPreflightError';
    this.code = code;
    this.operationId = options.operationId;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }
}

export function prepareMutationBatch(
  input: PrepareMutationInput,
): PreparedMutationBatch {
  validateInput(input);
  const nodes = indexSnapshot(input.snapshot);
  validateOperationIds(input.operations);

  const steps = input.operations.map((intent): PreparedMutationStep => {
    validateIntent(intent, input.snapshot, nodes);
    const clonedIntent = cloneSerializableIntent(intent);
    const compiled = compileIntent(clonedIntent, input.snapshot, nodes);
    return {
      operationId: intent.operationId,
      kind: intent.kind,
      idempotencyToken: canonicalHash({
        namespace: input.idempotencyNamespace,
        engineVersion: ENGINE_VERSION,
        documentId: input.snapshot.documentId,
        expectedRevision: input.snapshot.revision,
        beforeSnapshotHash: input.snapshot.canonicalHash,
        operationId: intent.operationId,
        kind: intent.kind,
        intent: clonedIntent,
        actions: compiled.actions,
        assertions: compiled.assertions,
      }),
      intent: clonedIntent,
      actions: compiled.actions,
      assertions: compiled.assertions,
    };
  });

  const payload = {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    documentId: input.snapshot.documentId,
    expectedRevision: input.snapshot.revision,
    beforeSnapshotHash: input.snapshot.canonicalHash,
    steps,
  } satisfies Omit<PreparedMutationBatch, 'fingerprint'>;

  const batch = {
    ...payload,
    fingerprint: canonicalHash(payload),
  };
  return deepFreeze(structuredClone(batch));
}

export function preparedMutationBatchFingerprint(
  batch: PreparedMutationBatch,
): string {
  return canonicalHash({
    schemaVersion: batch.schemaVersion,
    engineVersion: batch.engineVersion,
    documentId: batch.documentId,
    expectedRevision: batch.expectedRevision,
    beforeSnapshotHash: batch.beforeSnapshotHash,
    steps: batch.steps,
  });
}

export function assertPreparedMutationBatchIntegrity(
  batch: PreparedMutationBatch,
): void {
  let actualFingerprint: string;
  try {
    actualFingerprint = preparedMutationBatchFingerprint(batch);
  } catch (cause) {
    fail(
      'batch_integrity_mismatch',
      'Prepared mutation batch cannot be canonically fingerprinted.',
      { expectedFingerprint: batch?.fingerprint },
      undefined,
      cause,
    );
  }
  if (actualFingerprint !== batch.fingerprint) {
    fail('batch_integrity_mismatch', 'Prepared mutation batch fingerprint does not match its contents.', {
      expectedFingerprint: batch.fingerprint,
      actualFingerprint,
    });
  }
}

function validateInput(input: PrepareMutationInput): void {
  if (!input || typeof input !== 'object') {
    fail('invalid_operation', 'Mutation preparation input must be an object.');
  }
  if (!input.snapshot || typeof input.snapshot !== 'object') {
    fail('invalid_operation', 'Mutation preparation requires a document snapshot.', {
      field: 'snapshot',
    });
  }
  for (const [field, value] of [
    ['snapshot.documentId', input.snapshot.documentId],
    ['snapshot.revision', input.snapshot.revision],
    ['snapshot.rootBlockId', input.snapshot.rootBlockId],
    ['snapshot.canonicalHash', input.snapshot.canonicalHash],
    ['idempotencyNamespace', input.idempotencyNamespace],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      fail('invalid_operation', `${field} must be a non-empty string.`, { field });
    }
  }
  if (!Array.isArray(input.snapshot.nodes)) {
    fail('invalid_operation', 'snapshot.nodes must be an array.', {
      field: 'snapshot.nodes',
    });
  }
  if (!Array.isArray(input.operations)) {
    fail('invalid_operation', 'operations must be an array.', { field: 'operations' });
  }
}

function indexSnapshot(snapshot: DocumentSnapshot): Map<string, SnapshotNode> {
  const nodes = new Map<string, SnapshotNode>();
  for (const [index, node] of snapshot.nodes.entries()) {
    if (!node || typeof node !== 'object' || typeof node.blockId !== 'string' || !node.blockId) {
      fail('invalid_operation', `Snapshot node ${index} has no non-empty block ID.`, {
        field: `snapshot.nodes[${index}].blockId`,
      });
    }
    if (nodes.has(node.blockId)) {
      fail('invalid_operation', `Snapshot contains duplicate block ID ${node.blockId}.`, {
        field: 'snapshot.nodes',
        blockId: node.blockId,
      });
    }
    nodes.set(node.blockId, node);
  }
  const root = nodes.get(snapshot.rootBlockId);
  if (!root || root.kind !== 'page') {
    fail('invalid_operation', `Snapshot root ${snapshot.rootBlockId} is missing or is not a page.`, {
      rootBlockId: snapshot.rootBlockId,
      actualKind: root?.kind,
    });
  }
  return nodes;
}

function validateOperationIds(operations: MutationIntent[]): void {
  const seen = new Set<string>();
  for (const [index, intent] of operations.entries()) {
    if (!intent || typeof intent !== 'object') {
      fail('invalid_operation', `Operation ${index} must be an object.`, {
        operationIndex: index,
      });
    }
    if (typeof intent.operationId !== 'string' || intent.operationId.trim().length === 0) {
      fail('invalid_operation', `Operation ${index} requires a non-empty operationId.`, {
        field: 'operationId',
        operationIndex: index,
      });
    }
    if (seen.has(intent.operationId)) {
      fail(
        'duplicate_operation_id',
        `Operation ID ${intent.operationId} appears more than once.`,
        { operationId: intent.operationId },
        intent.operationId,
      );
    }
    seen.add(intent.operationId);
  }
}

function validateIntent(
  intent: MutationIntent,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): void {
  switch (intent.kind) {
    case 'replace':
      validateReplace(intent, snapshot, nodes);
      return;
    case 'insert':
      validateInsert(intent, nodes);
      return;
    case 'delete':
      validateDelete(intent, snapshot, nodes);
      return;
    case 'move':
      validateMove(intent, snapshot, nodes);
      return;
    case 'assert':
      assertExpectedHash(intent.blockId, intent.expectedHash, intent.operationId, nodes);
      return;
    case 'whiteboard-overwrite':
      validateWhiteboardOverwrite(intent, nodes);
      return;
    default: {
      const unknown = intent as { operationId?: unknown; kind?: unknown };
      fail('invalid_operation', `Unsupported mutation kind ${String(unknown.kind)}.`, {
        operationId: unknown.operationId,
        kind: unknown.kind,
      }, typeof unknown.operationId === 'string' ? unknown.operationId : undefined);
    }
  }
}

type CompiledMutation = {
  actions: PreparedMutationAction[];
  assertions: PreparedMutationAssertions;
};

function compileIntent(
  intent: MutationIntent,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  switch (intent.kind) {
    case 'replace':
      return compileReplace(intent, snapshot, nodes);
    case 'insert':
      return compileInsert(intent, nodes);
    case 'delete':
      return compileDelete(intent, nodes);
    case 'move':
      return compileMove(intent, nodes);
    case 'assert':
      return compileAssert(intent, nodes);
    case 'whiteboard-overwrite':
      return compileWhiteboardOverwrite(intent, nodes);
  }
}

function compileReplace(
  intent: Extract<MutationIntent, { kind: 'replace' }>,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const target = nodes.get(intent.targetBlockId)!;
  const actions = replaceActions(intent.targetBlockId, intent.desired);
  const preflight = [
    targetHashAssertion(target, intent.expectedHash),
    targetTypeAssertion(target),
  ] satisfies PreparedMutationAssertions['preflight'];
  if (target.parentBlockId) {
    const parent = nodes.get(target.parentBlockId)!;
    preflight.push(parentChildrenAssertion(parent));
    preflight.push(siblingBoundaryAssertion(parent, [target.blockId]));
  } else if (target.blockId !== snapshot.rootBlockId) {
    fail('invalid_operation', `Target ${target.blockId} has no parent.`, {
      targetBlockId: target.blockId,
    }, intent.operationId);
  }

  return {
    actions,
    assertions: {
      preflight,
      readback: [{
        kind: 'desired-node',
        targetBlockId: target.blockId,
        desiredHash: canonicalHash(intent.desired),
      }],
    },
  };
}

function replaceActions(
  targetBlockId: string,
  desired: DesiredNode,
): PreparedMutationAction[] {
  if (desired.kind === 'table') {
    return [{
      kind: 'replace-xml',
      targetBlockId,
      nodeKind: 'table',
      xml: tableToXml(desired),
    }];
  }
  if (desired.kind === 'callout') {
    return [{
      kind: 'replace-xml',
      targetBlockId,
      nodeKind: 'callout',
      xml: calloutToXml(desired),
    }];
  }
  const blocks = desired.kind === 'title'
    ? [toProviderBlock(desired)]
    : toProviderTree([desired]);
  return blocks.length === 1
    ? [{ kind: 'replace-provider-block', targetBlockId, block: blocks[0]! }]
    : [{ kind: 'replace-provider-blocks', targetBlockId, blocks }];
}

function compileInsert(
  intent: Extract<MutationIntent, { kind: 'insert' }>,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const parent = nodes.get(intent.parentBlockId)!;
  const afterIndex = intent.insertAfterBlockId === parent.blockId
    ? -1
    : parent.childBlockIds.indexOf(intent.insertAfterBlockId);
  const followingBlockId = parent.childBlockIds[afterIndex + 1];
  const segments = intent.desired.map((desired, desiredIndex) =>
    insertSegment(desired, desiredIndex)
  );
  const action: PreparedMutationAction = {
    kind: 'insert-segments',
    parentBlockId: parent.blockId,
    insertAfterBlockId: intent.insertAfterBlockId,
    ...(followingBlockId ? { insertBeforeBlockId: followingBlockId } : {}),
    segments,
  };
  const boundary = {
    kind: 'insertion-boundary' as const,
    parentBlockId: parent.blockId,
    precedingBlockId: intent.insertAfterBlockId,
    ...(followingBlockId ? { followingBlockId } : {}),
  };

  return {
    actions: [action],
    assertions: {
      preflight: [parentChildrenAssertion(parent), boundary],
      readback: [{
        kind: 'inserted-desired',
        parentBlockId: parent.blockId,
        precedingBlockId: intent.insertAfterBlockId,
        ...(followingBlockId ? { followingBlockId } : {}),
        desiredHash: canonicalHash(intent.desired),
      }],
    },
  };
}

function insertSegment(desired: DesiredNode, desiredIndex: number): PreparedInsertSegment {
  if (desired.kind === 'table') {
    return {
      kind: 'xml',
      desiredIndex,
      nodeKind: 'table',
      xml: tableToXml(desired),
    };
  }
  if (desired.kind === 'callout') {
    return {
      kind: 'xml',
      desiredIndex,
      nodeKind: 'callout',
      xml: calloutToXml(desired),
    };
  }
  return {
    kind: 'provider-blocks',
    desiredIndex,
    blocks: toProviderTree([desired]),
  };
}

function compileDelete(
  intent: Extract<MutationIntent, { kind: 'delete' }>,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const parent = nodes.get(intent.parentBlockId)!;
  const preflight: PreparedMutationAssertions['preflight'] = [];
  intent.blockIds.forEach((blockId, index) => {
    const target = nodes.get(blockId)!;
    preflight.push(targetHashAssertion(target, intent.expectedHashes[index]!));
    preflight.push({
      kind: 'block-parent',
      blockId,
      expectedParentBlockId: parent.blockId,
    });
  });
  preflight.push(parentChildrenAssertion(parent));
  preflight.push(siblingBoundaryAssertion(parent, intent.blockIds));
  return {
    actions: [{
      kind: 'delete-blocks',
      parentBlockId: parent.blockId,
      blockIds: [...intent.blockIds],
    }],
    assertions: {
      preflight,
      readback: [{ kind: 'blocks-absent', blockIds: [...intent.blockIds] }],
    },
  };
}

function compileMove(
  intent: Extract<MutationIntent, { kind: 'move' }>,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const parent = nodes.get(intent.parentBlockId)!;
  const preflight: PreparedMutationAssertions['preflight'] = intent.blockIds.map((blockId) => ({
    kind: 'block-parent',
    blockId,
    expectedParentBlockId: parent.blockId,
  }));
  preflight.push(parentChildrenAssertion(parent));
  const remaining = parent.childBlockIds.filter((blockId) => !intent.blockIds.includes(blockId));
  const destination = intent.insertAfterBlockId === parent.blockId
    ? 0
    : remaining.indexOf(intent.insertAfterBlockId) + 1;
  const followingBlockId = remaining[destination];
  preflight.push({
    kind: 'insertion-boundary',
    parentBlockId: parent.blockId,
    precedingBlockId: intent.insertAfterBlockId,
    ...(followingBlockId ? { followingBlockId } : {}),
  });
  const expectedChildBlockIds = [...remaining];
  expectedChildBlockIds.splice(destination, 0, ...intent.blockIds);

  return {
    actions: [{
      kind: 'move-blocks',
      parentBlockId: parent.blockId,
      blockIds: [...intent.blockIds],
      insertAfterBlockId: intent.insertAfterBlockId,
    }],
    assertions: {
      preflight,
      readback: [{
        kind: 'sibling-order',
        parentBlockId: parent.blockId,
        expectedChildBlockIds,
      }],
    },
  };
}

function compileAssert(
  intent: Extract<MutationIntent, { kind: 'assert' }>,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const target = nodes.get(intent.blockId)!;
  return {
    actions: [{ kind: 'assert-node', blockId: target.blockId }],
    assertions: {
      preflight: [
        targetHashAssertion(target, intent.expectedHash),
        targetTypeAssertion(target),
      ],
      readback: [{
        kind: 'node-hash',
        blockId: target.blockId,
        expectedHash: intent.expectedHash,
      }],
    },
  };
}

function compileWhiteboardOverwrite(
  intent: Extract<MutationIntent, { kind: 'whiteboard-overwrite' }>,
  nodes: Map<string, SnapshotNode>,
): CompiledMutation {
  const resolved = resolveWhiteboardTarget(intent, nodes);
  const preflight: PreparedMutationAssertions['preflight'] = [
    targetHashAssertion(resolved.node, intent.expectedTargetHash!),
    targetTypeAssertion(resolved.node),
  ];
  if (resolved.node.parentBlockId) {
    const parent = nodes.get(resolved.node.parentBlockId)!;
    preflight.push(parentChildrenAssertion(parent));
    preflight.push(siblingBoundaryAssertion(parent, [resolved.node.blockId]));
  }

  if (resolved.shape === 'image-svg') {
    return {
      actions: [{
        kind: 'replace-image-with-svg',
        targetBlockId: resolved.node.blockId,
        svg: resolved.svg,
      }],
      assertions: {
        preflight,
        readback: [{
          kind: 'image-replaced-with-svg-whiteboard',
          targetBlockId: resolved.node.blockId,
          svgHash: canonicalHash(resolved.svg),
        }],
      },
    };
  }

  preflight.push({
    kind: 'resource-token',
    blockId: resolved.node.blockId,
    resourceKind: 'whiteboard',
    expectedToken: resolved.token,
  });
  return {
    actions: [{
      kind: 'overwrite-whiteboard',
      targetBlockId: resolved.node.blockId,
      targetToken: resolved.token,
      desired: structuredClone(intent.desired),
    }],
    assertions: {
      preflight,
      readback: [{
        kind: 'whiteboard-content',
        targetBlockId: resolved.node.blockId,
        targetToken: resolved.token,
        desiredHash: canonicalHash(intent.desired),
      }],
    },
  };
}

function targetHashAssertion(
  node: SnapshotNode,
  expectedHash: string,
): PreparedMutationAssertions['preflight'][number] {
  return { kind: 'target-hash', blockId: node.blockId, expectedHash };
}

function targetTypeAssertion(
  node: SnapshotNode,
): PreparedMutationAssertions['preflight'][number] {
  return {
    kind: 'target-type',
    blockId: node.blockId,
    expectedKind: node.kind,
    expectedBlockType: node.blockType,
  };
}

function parentChildrenAssertion(
  parent: SnapshotNode,
): PreparedMutationAssertions['preflight'][number] {
  return {
    kind: 'parent-children',
    parentBlockId: parent.blockId,
    expectedChildBlockIds: [...parent.childBlockIds],
  };
}

function siblingBoundaryAssertion(
  parent: SnapshotNode,
  blockIds: string[],
): PreparedMutationAssertions['preflight'][number] {
  const firstIndex = parent.childBlockIds.indexOf(blockIds[0]!);
  const lastIndex = parent.childBlockIds.indexOf(blockIds.at(-1)!);
  const precedingBlockId = firstIndex === 0
    ? parent.blockId
    : parent.childBlockIds[firstIndex - 1]!;
  const followingBlockId = parent.childBlockIds[lastIndex + 1];
  return {
    kind: 'sibling-boundary',
    parentBlockId: parent.blockId,
    precedingBlockId,
    ...(followingBlockId ? { followingBlockId } : {}),
    blockIds: [...blockIds],
  };
}

function validateReplace(
  intent: Extract<MutationIntent, { kind: 'replace' }>,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): void {
  const target = assertExpectedHash(
    intent.targetBlockId,
    intent.expectedHash,
    intent.operationId,
    nodes,
  );
  validateDesiredNode(intent.desired, intent.operationId);
  const targetIsRoot = target.blockId === snapshot.rootBlockId;
  if (targetIsRoot !== (intent.desired.kind === 'title')) {
    fail(
      'invalid_operation',
      targetIsRoot
        ? 'The page root can only be replaced by a title node.'
        : 'A title node can only replace the page root.',
      {
        targetBlockId: target.blockId,
        targetKind: target.kind,
        desiredKind: intent.desired.kind,
      },
      intent.operationId,
    );
  }
}

function validateInsert(
  intent: Extract<MutationIntent, { kind: 'insert' }>,
  nodes: Map<string, SnapshotNode>,
): void {
  const parent = requireParent(intent.parentBlockId, intent.operationId, nodes);
  const afterIndex = anchorIndex(
    parent,
    intent.insertAfterBlockId,
    intent.operationId,
    nodes,
  );

  if (intent.insertBeforeBlockId !== undefined) {
    const before = requireDirectChild(
      parent,
      intent.insertBeforeBlockId,
      intent.operationId,
      nodes,
      'anchor',
    );
    const expectedBeforeId = parent.childBlockIds[afterIndex + 1];
    if (before.blockId !== expectedBeforeId) {
      fail(
        'non_adjacent_anchors',
        `Insert anchors ${intent.insertAfterBlockId} and ${before.blockId} are not adjacent.`,
        {
          parentBlockId: parent.blockId,
          insertAfterBlockId: intent.insertAfterBlockId,
          insertBeforeBlockId: before.blockId,
          actualNextBlockId: expectedBeforeId,
        },
        intent.operationId,
      );
    }
  }

  if (!Array.isArray(intent.desired) || intent.desired.length === 0) {
    fail('invalid_operation', 'Insert operations require at least one desired node.', {
      field: 'desired',
    }, intent.operationId);
  }
  intent.desired.forEach((desired, desiredIndex) => {
    if (desired?.kind === 'title') {
      fail('invalid_operation', 'Title nodes cannot be inserted as document children.', {
        desiredIndex,
        desiredKind: 'title',
      }, intent.operationId);
    }
    validateDesiredNode(desired, intent.operationId, desiredIndex);
  });
}

function validateDelete(
  intent: Extract<MutationIntent, { kind: 'delete' }>,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): void {
  const parent = requireParent(intent.parentBlockId, intent.operationId, nodes);
  validateBlockIdList(intent.blockIds, intent.operationId);
  if (!Array.isArray(intent.expectedHashes) || intent.expectedHashes.length !== intent.blockIds.length) {
    fail(
      'invalid_operation',
      'Delete block IDs and expected hashes must align one-to-one.',
      {
        blockCount: intent.blockIds.length,
        hashCount: Array.isArray(intent.expectedHashes) ? intent.expectedHashes.length : undefined,
      },
      intent.operationId,
    );
  }

  const indexes = intent.blockIds.map((blockId, index) => {
    rejectRootMutation(blockId, snapshot.rootBlockId, intent.operationId);
    const child = requireDirectChild(parent, blockId, intent.operationId, nodes, 'target');
    assertHash(child, intent.expectedHashes[index]!, intent.operationId);
    return parent.childBlockIds.indexOf(blockId);
  });
  if (indexes.some((index, offset) => offset > 0 && index !== indexes[offset - 1]! + 1)) {
    fail('invalid_operation', 'Delete block IDs must be consecutive and in parent sibling order.', {
      reason: 'non_consecutive_block_ids',
      parentBlockId: parent.blockId,
      blockIds: [...intent.blockIds],
      siblingIndexes: indexes,
    }, intent.operationId);
  }
}

function validateMove(
  intent: Extract<MutationIntent, { kind: 'move' }>,
  snapshot: DocumentSnapshot,
  nodes: Map<string, SnapshotNode>,
): void {
  const parent = requireParent(intent.parentBlockId, intent.operationId, nodes);
  validateBlockIdList(intent.blockIds, intent.operationId);
  for (const blockId of intent.blockIds) {
    rejectRootMutation(blockId, snapshot.rootBlockId, intent.operationId);
    requireDirectChild(parent, blockId, intent.operationId, nodes, 'target');
  }

  anchorIndex(parent, intent.insertAfterBlockId, intent.operationId, nodes);
  if (intent.blockIds.includes(intent.insertAfterBlockId)) {
    fail('invalid_operation', 'A move anchor cannot be one of the moved blocks.', {
      reason: 'moving_anchor',
      insertAfterBlockId: intent.insertAfterBlockId,
    }, intent.operationId);
  }

  const remaining = parent.childBlockIds.filter((blockId) => !intent.blockIds.includes(blockId));
  const destination = intent.insertAfterBlockId === parent.blockId
    ? 0
    : remaining.indexOf(intent.insertAfterBlockId) + 1;
  const reordered = [...remaining];
  reordered.splice(destination, 0, ...intent.blockIds);
  if (sameStrings(reordered, parent.childBlockIds)) {
    fail('invalid_operation', 'Move operation would preserve the current sibling order.', {
      reason: 'self_placement',
      parentBlockId: parent.blockId,
      blockIds: [...intent.blockIds],
      insertAfterBlockId: intent.insertAfterBlockId,
    }, intent.operationId);
  }
}

function validateWhiteboardOverwrite(
  intent: Extract<MutationIntent, { kind: 'whiteboard-overwrite' }>,
  nodes: Map<string, SnapshotNode>,
): void {
  const desired = intent.desired;
  if (!desired || typeof desired !== 'object') {
    fail('invalid_operation', 'Whiteboard desired payload must be an object.', {
      field: 'desired',
    }, intent.operationId);
  }
  switch (desired.kind) {
    case 'copy-token':
      requireNonEmptyString(desired.sourceToken, 'desired.sourceToken', intent.operationId);
      break;
    case 'svg':
      requireNonEmptyString(desired.value, 'desired.value', intent.operationId);
      break;
    case 'raw':
      if (desired.value === undefined) {
        fail('invalid_operation', 'Raw Whiteboard desired data cannot be undefined.', {
          field: 'desired.value',
        }, intent.operationId);
      }
      try {
        structuredClone(desired.value);
        canonicalHash(desired.value);
      } catch (cause) {
        fail('invalid_operation', 'Raw Whiteboard desired data must be JSON-serializable.', {
          field: 'desired.value',
        }, intent.operationId, cause);
      }
      break;
    default:
      fail('invalid_operation', `Unsupported Whiteboard desired kind ${String((desired as { kind?: unknown }).kind)}.`, {
        field: 'desired.kind',
        kind: (desired as { kind?: unknown }).kind,
      }, intent.operationId);
  }

  const resolved = resolveWhiteboardTarget(intent, nodes);
  if (
    resolved.shape === 'whiteboard' &&
    desired.kind === 'copy-token' &&
    desired.sourceToken === resolved.token
  ) {
    fail('invalid_operation', 'Whiteboard source and target tokens must differ.', {
      reason: 'self_copy',
      targetToken: resolved.token,
    }, intent.operationId);
  }
}

type ResolvedWhiteboardTarget =
  | { shape: 'image-svg'; node: SnapshotNode; svg: string }
  | { shape: 'whiteboard'; node: SnapshotNode; token: string };

function resolveWhiteboardTarget(
  intent: Extract<MutationIntent, { kind: 'whiteboard-overwrite' }>,
  nodes: Map<string, SnapshotNode>,
): ResolvedWhiteboardTarget {
  requireNonEmptyString(intent.expectedTargetHash, 'expectedTargetHash', intent.operationId);

  if (intent.targetBlockId !== undefined) {
    requireNonEmptyString(intent.targetBlockId, 'targetBlockId', intent.operationId);
    const target = requireNode(intent.targetBlockId, intent.operationId, nodes, 'target');
    assertHash(target, intent.expectedTargetHash!, intent.operationId);
    if (target.blockType === 27) {
      if (intent.desired.kind !== 'svg' || intent.targetToken !== undefined) {
        fail('invalid_operation', 'Image-compatible targets only support tokenless SVG replacement.', {
          targetBlockId: target.blockId,
          actualBlockType: target.blockType,
          desiredKind: intent.desired.kind,
          targetToken: intent.targetToken,
        }, intent.operationId);
      }
      return { shape: 'image-svg', node: target, svg: intent.desired.value };
    }
    if (target.kind !== 'whiteboard' || target.blockType !== 43) {
      fail('invalid_operation', `Target ${target.blockId} is not a Whiteboard or image-compatible block.`, {
        targetBlockId: target.blockId,
        actualKind: target.kind,
        actualBlockType: target.blockType,
      }, intent.operationId);
    }
    const tokens = whiteboardTokens(target);
    if (tokens.length === 0) {
      fail('invalid_operation', `Whiteboard ${target.blockId} has no provider resource token.`, {
        targetBlockId: target.blockId,
        reason: 'target_identity_incomplete',
      }, intent.operationId);
    }
    if (tokens.length !== 1) {
      fail('invalid_operation', `Whiteboard ${target.blockId} has conflicting provider resource tokens.`, {
        targetBlockId: target.blockId,
        reason: 'conflicting_resource_tokens',
        tokens,
      }, intent.operationId);
    }
    const token = tokens[0]!;
    if (intent.targetToken !== undefined && intent.targetToken !== token) {
      fail('invalid_operation', `Whiteboard token for ${target.blockId} does not match the snapshot.`, {
        targetBlockId: target.blockId,
        expectedTargetToken: intent.targetToken,
        actualTargetToken: token,
      }, intent.operationId);
    }
    return { shape: 'whiteboard', node: target, token };
  }

  requireNonEmptyString(intent.targetToken, 'targetToken', intent.operationId);
  const matches = [...nodes.values()].filter((node) => {
    if (node.kind !== 'whiteboard' || node.blockType !== 43) return false;
    return whiteboardTokens(node).includes(intent.targetToken!);
  });
  if (matches.length === 0) {
    fail('target_missing', `No snapshot Whiteboard resolves token ${intent.targetToken}.`, {
      targetToken: intent.targetToken,
    }, intent.operationId);
  }
  if (matches.length !== 1) {
    fail('invalid_operation', `Snapshot token ${intent.targetToken} resolves multiple Whiteboards.`, {
      reason: 'ambiguous_target',
      targetToken: intent.targetToken,
      matchingBlockIds: matches.map(({ blockId }) => blockId),
    }, intent.operationId);
  }
  const target = matches[0]!;
  const tokens = whiteboardTokens(target);
  if (tokens.length !== 1) {
    fail('invalid_operation', `Whiteboard ${target.blockId} has conflicting provider resource tokens.`, {
      targetBlockId: target.blockId,
      reason: 'conflicting_resource_tokens',
      tokens,
    }, intent.operationId);
  }
  assertHash(target, intent.expectedTargetHash!, intent.operationId);
  return { shape: 'whiteboard', node: target, token: intent.targetToken! };
}

function validateDesiredNode(
  desired: DesiredNode,
  operationId: string,
  desiredIndex?: number,
): void {
  if (!desired || typeof desired !== 'object') {
    fail('invalid_operation', 'Desired node must be an object.', {
      desiredIndex,
    }, operationId);
  }
  try {
    if (desired.kind === 'callout') {
      calloutToXml(desired);
    } else if (desired.kind === 'table') {
      tableToXml(desired);
    } else if (desired.kind === 'title') {
      toProviderBlock(desired);
    } else {
      toProviderTree([desired]);
    }
  } catch (cause) {
    fail('invalid_operation', `Desired node cannot be encoded: ${errorMessage(cause)}`, {
      desiredIndex,
      desiredKind: (desired as { kind?: unknown }).kind,
    }, operationId, cause);
  }
}

function validateBlockIdList(blockIds: string[], operationId: string): void {
  if (!Array.isArray(blockIds) || blockIds.length === 0) {
    fail('invalid_operation', 'Mutation requires at least one block ID.', {
      field: 'blockIds',
    }, operationId);
  }
  const seen = new Set<string>();
  for (const [index, blockId] of blockIds.entries()) {
    if (typeof blockId !== 'string' || blockId.length === 0) {
      fail('invalid_operation', `Block ID at index ${index} must be non-empty.`, {
        field: `blockIds[${index}]`,
      }, operationId);
    }
    if (seen.has(blockId)) {
      fail('duplicate_block_id', `Block ID ${blockId} appears more than once.`, {
        blockId,
      }, operationId);
    }
    seen.add(blockId);
  }
}

function requireParent(
  parentBlockId: string,
  operationId: string,
  nodes: Map<string, SnapshotNode>,
): SnapshotNode {
  const parent = nodes.get(parentBlockId);
  if (!parent) {
    fail('parent_missing', `Parent block ${parentBlockId} is missing from the snapshot.`, {
      parentBlockId,
    }, operationId);
  }
  return parent;
}

function requireNode(
  blockId: string,
  operationId: string,
  nodes: Map<string, SnapshotNode>,
  role: 'anchor' | 'target',
): SnapshotNode {
  const node = nodes.get(blockId);
  if (!node) {
    fail(role === 'anchor' ? 'anchor_missing' : 'target_missing',
      `${role === 'anchor' ? 'Anchor' : 'Target'} block ${blockId} is missing from the snapshot.`,
      { blockId },
      operationId);
  }
  return node;
}

function requireDirectChild(
  parent: SnapshotNode,
  blockId: string,
  operationId: string,
  nodes: Map<string, SnapshotNode>,
  role: 'anchor' | 'target',
): SnapshotNode {
  const child = requireNode(blockId, operationId, nodes, role);
  if (child.parentBlockId !== parent.blockId || !parent.childBlockIds.includes(blockId)) {
    fail('parent_mismatch', `Block ${blockId} is not a direct child of ${parent.blockId}.`, {
      blockId,
      expectedParentBlockId: parent.blockId,
      actualParentBlockId: child.parentBlockId,
    }, operationId);
  }
  return child;
}

function anchorIndex(
  parent: SnapshotNode,
  blockId: string,
  operationId: string,
  nodes: Map<string, SnapshotNode>,
): number {
  if (blockId === parent.blockId) return -1;
  requireDirectChild(parent, blockId, operationId, nodes, 'anchor');
  return parent.childBlockIds.indexOf(blockId);
}

function assertExpectedHash(
  blockId: string,
  expectedHash: string,
  operationId: string,
  nodes: Map<string, SnapshotNode>,
): SnapshotNode {
  const target = requireNode(blockId, operationId, nodes, 'target');
  assertHash(target, expectedHash, operationId);
  return target;
}

function assertHash(node: SnapshotNode, expectedHash: string, operationId: string): void {
  if (typeof expectedHash !== 'string' || expectedHash !== node.canonicalHash) {
    fail('hash_mismatch', `Canonical hash for block ${node.blockId} does not match.`, {
      blockId: node.blockId,
      expectedHash,
      actualHash: node.canonicalHash,
    }, operationId);
  }
}

function rejectRootMutation(blockId: string, rootBlockId: string, operationId: string): void {
  if (blockId === rootBlockId) {
    fail('root_mutation_forbidden', `Operation cannot delete or move page root ${rootBlockId}.`, {
      blockId,
      rootBlockId,
    }, operationId);
  }
}

function whiteboardTokens(node: SnapshotNode): string[] {
  const tokens = new Set<string>();
  for (const value of [node.raw.board, node.raw.whiteboard]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const token = (value as Record<string, unknown>).token;
    if (typeof token === 'string' && token.length > 0) tokens.add(token);
  }
  return [...tokens];
}

function requireNonEmptyString(value: unknown, field: string, operationId: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('invalid_operation', `${field} must be a non-empty string.`, {
      field,
    }, operationId);
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneSerializableIntent(intent: MutationIntent): MutationIntent {
  try {
    const cloned = structuredClone(intent);
    canonicalHash(cloned);
    return cloned;
  } catch (cause) {
    fail('invalid_operation', 'Mutation intent must be serializable and canonically hashable.', {
      field: 'intent',
    }, intent.operationId, cause);
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(
  code: MutationPreflightErrorCode,
  message: string,
  context: Record<string, unknown> = {},
  operationId?: string,
  cause?: unknown,
): never {
  throw new MutationPreflightError(code, message, {
    ...(operationId === undefined ? {} : { operationId }),
    context,
    ...(cause === undefined ? {} : { cause }),
  });
}
