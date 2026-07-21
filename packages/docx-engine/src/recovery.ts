import {
  canonicalWhiteboardRawHash,
  normalizeProviderLinkUrl,
  svgExpectedTexts,
  toProviderBlock,
  whiteboardRawContainsTexts,
} from './codec.js';
import { canonicalHash } from './hash.js';
import type {
  AssessRecoveryInput,
  DesiredNode,
  DocumentSnapshot,
  InlineContent,
  MutationIntent,
  PreparedMutationBatch,
  PreparedMutationStep,
  RecoveryAssessment,
  ResourceStateEvidence,
  SnapshotNode,
  VerifiedOperationEvidence,
} from './model.js';
import {
  ENGINE_SCHEMA_VERSION,
  ENGINE_VERSION,
  assertPreparedMutationBatchIntegrity,
  prepareMutationBatch,
} from './prepare.js';
import { createDocumentSnapshot } from './snapshot.js';
import type { DocxTransport, ProviderBlock } from './transport.js';

export type RecoveryReason =
  | 'ambiguous_created_blocks'
  | 'checkpoint_not_prefix'
  | 'checkpoint_snapshot_mismatch'
  | 'invalid_batch_integrity'
  | 'invalid_checkpoint'
  | 'resource_evidence_missing'
  | 'resource_state_mismatch'
  | 'resource_state_unreadable'
  | 'reverse_not_exactly_representable'
  | 'unsupported_engine_version'
  | 'unsupported_schema_version'
  | 'unexpected_remote_change';

/** Read and classify a recovery checkpoint without invoking any mutation transport method. */
export async function assessRecovery(
  transport: DocxTransport,
  input: AssessRecoveryInput,
): Promise<RecoveryAssessment> {
  const validated = validateBeforeRead(input);
  if (validated) return manual(validated);

  let current: DocumentSnapshot;
  try {
    const fetched = await transport.fetchBlocks(input.batch.documentId);
    current = createDocumentSnapshot({
      documentId: input.batch.documentId,
      revision: fetched.revision,
      blocks: fetched.blocks,
    });
  } catch {
    return manual('unexpected_remote_change');
  }

  const completed = input.checkpoint.completedOperations;
  const expected = completed.at(-1);
  const expectedHash = expected?.afterSnapshotHash ?? input.checkpoint.prewriteSnapshot.canonicalHash;
  const expectedRevision = expected?.revision ?? input.checkpoint.prewriteSnapshot.revision;
  if (current.documentId !== input.batch.documentId) {
    return manual('unexpected_remote_change');
  }
  if (current.canonicalHash !== expectedHash || current.revision !== expectedRevision) {
    const inferred = await inferAcceptedNextOperation(
      transport,
      input.batch,
      input.checkpoint.prewriteSnapshot,
      current,
      completed,
    );
    if (inferred) return inferred;
    return manual('unexpected_remote_change');
  }

  const graphReason = verifyCompletedGraphs(input.batch, completed, current);
  if (graphReason) return manual(graphReason);
  if (!unrelatedDocumentIsUnchanged(
    input.batch,
    completed,
    input.checkpoint.prewriteSnapshot,
    current,
  )) return manual('unexpected_remote_change');

  const resources = await readCompletedResources(transport, completed);
  if ('reason' in resources) return manual(resources.reason);
  const desiredReason = await verifyCompletedDesiredStates(
    transport,
    input.batch,
    completed,
    current,
    resources.rawByToken,
  );
  if (desiredReason) return manual(desiredReason);

  const completedOperationIds = completed.map(({ operationId }) => operationId);
  const pendingOperationIds = input.batch.steps
    .slice(completedOperationIds.length)
    .map(({ operationId }) => operationId);

  if (pendingOperationIds.length > 0 || input.batch.steps.every(({ kind }) => kind === 'assert')) {
    return frozen({ disposition: 'resume_possible', completedOperationIds, pendingOperationIds });
  }

  const reverse = buildReverseIntents(input.batch, input.checkpoint.prewriteSnapshot, current, completed);
  if ('reason' in reverse) return manual(reverse.reason);
  if (reverse.intents.length === 0) {
    return frozen({ disposition: 'resume_possible', completedOperationIds, pendingOperationIds });
  }

  try {
    prepareMutationBatch({
      snapshot: current,
      operations: reverse.intents,
      idempotencyNamespace: `recovery:${input.batch.fingerprint}`,
    });
  } catch {
    return manual('reverse_not_exactly_representable');
  }
  return frozen({ disposition: 'reverse_possible', reverseIntents: reverse.intents });
}

function unrelatedDocumentIsUnchanged(
  batch: PreparedMutationBatch,
  completed: VerifiedOperationEvidence[],
  before: DocumentSnapshot,
  current: DocumentSnapshot,
): boolean {
  const beforeNodes = nodeIndex(before);
  const currentNodes = nodeIndex(current);
  const allowedBefore = new Set<string>();
  const allowedCurrent = new Set<string>();
  const structuralParents = new Set<string>();

  const addSubtree = (rootId: string, nodes: Map<string, SnapshotNode>, target: Set<string>): void => {
    if (target.has(rootId)) return;
    const node = nodes.get(rootId);
    if (!node) return;
    target.add(rootId);
    node.childBlockIds.forEach((childId) => addSubtree(childId, nodes, target));
  };

  for (const [index, entry] of completed.entries()) {
    const step = batch.steps[index]!;
    switch (step.intent.kind) {
      case 'assert':
        break;
      case 'insert':
        structuralParents.add(step.intent.parentBlockId);
        allowedBefore.add(step.intent.parentBlockId);
        allowedCurrent.add(step.intent.parentBlockId);
        entry.createdBlockIds.forEach((id) => allowedCurrent.add(id));
        break;
      case 'delete':
        structuralParents.add(step.intent.parentBlockId);
        allowedBefore.add(step.intent.parentBlockId);
        allowedCurrent.add(step.intent.parentBlockId);
        step.intent.blockIds.forEach((id) => addSubtree(id, beforeNodes, allowedBefore));
        break;
      case 'move':
        structuralParents.add(step.intent.parentBlockId);
        allowedBefore.add(step.intent.parentBlockId);
        allowedCurrent.add(step.intent.parentBlockId);
        break;
      case 'replace': {
        if (step.intent.targetBlockId === before.rootBlockId) {
          allowedBefore.add(step.intent.targetBlockId);
          allowedCurrent.add(step.intent.targetBlockId);
        } else {
          addSubtree(step.intent.targetBlockId, beforeNodes, allowedBefore);
          if (currentNodes.has(step.intent.targetBlockId)) {
            addSubtree(step.intent.targetBlockId, currentNodes, allowedCurrent);
          } else {
            entry.createdBlockIds.forEach((id) => allowedCurrent.add(id));
          }
        }
        const parentId = beforeNodes.get(step.intent.targetBlockId)?.parentBlockId;
        if (parentId) {
          structuralParents.add(parentId);
          allowedBefore.add(parentId);
          allowedCurrent.add(parentId);
        }
        break;
      }
      case 'whiteboard-overwrite': {
        if (step.actions.some(({ kind }) => kind === 'replace-image-with-svg')) {
          const targetId = step.intent.targetBlockId;
          if (!targetId) return false;
          addSubtree(targetId, beforeNodes, allowedBefore);
          entry.createdBlockIds.forEach((id) => allowedCurrent.add(id));
          const parentId = beforeNodes.get(targetId)?.parentBlockId;
          if (parentId) {
            structuralParents.add(parentId);
            allowedBefore.add(parentId);
            allowedCurrent.add(parentId);
          }
        }
        break;
      }
    }
  }

  for (const parentId of structuralParents) {
    const left = beforeNodes.get(parentId);
    const right = currentNodes.get(parentId);
    if (!left || !right || semanticRawHash(left.raw) !== semanticRawHash(right.raw)) return false;
  }
  for (const [blockId, node] of beforeNodes) {
    if (allowedBefore.has(blockId)) continue;
    if (currentNodes.get(blockId)?.canonicalHash !== node.canonicalHash) return false;
  }
  for (const blockId of currentNodes.keys()) {
    if (!beforeNodes.has(blockId) && !allowedCurrent.has(blockId)) return false;
  }
  return true;
}

function semanticRawHash(raw: Record<string, unknown>): string {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (normalized === 'revision' || normalized === 'revisionid' ||
      normalized === 'documentrevision' || normalized === 'documentrevisionid' ||
      key === 'block_id' || key === 'parent_id' || key === 'children') continue;
    if (key === 'table') {
      const table = asRecord(value);
      if (table) {
        entries.push([key, Object.fromEntries(Object.entries(table).filter(([tableKey]) => tableKey !== 'cells'))]);
        continue;
      }
    }
    entries.push([key, value]);
  }
  return canonicalHash(Object.fromEntries(entries));
}

function verifyCompletedGraphs(
  batch: PreparedMutationBatch,
  completed: VerifiedOperationEvidence[],
  current: DocumentSnapshot,
): RecoveryReason | undefined {
  const nodes = nodeIndex(current);
  for (const [index, entry] of completed.entries()) {
    if (entry.createdBlockIds.length === 0) continue;
    const step = batch.steps[index]!;
    const created = new Set(entry.createdBlockIds);
    const roots = entry.createdBlockIds.filter((id) => {
      const node = nodes.get(id);
      return node !== undefined && (node.parentBlockId === undefined || !created.has(node.parentBlockId));
    });
    if (roots.length === 0 || !createdGraphIsExact(roots, created, nodes)) {
      return 'ambiguous_created_blocks';
    }
    if (step.intent.kind === 'insert') {
      const parent = nodes.get(step.intent.parentBlockId);
      const boundary = step.assertions.readback.find((item) => item.kind === 'inserted-desired');
      if (!parent || !boundary || boundary.kind !== 'inserted-desired' ||
        canonicalHash(idsBetween(
          parent.childBlockIds,
          parent.blockId,
          boundary.precedingBlockId,
          boundary.followingBlockId,
        )) !== canonicalHash(roots)) {
        return 'unexpected_remote_change';
      }
    }
    if (step.intent.kind === 'replace' && nodes.has(step.intent.targetBlockId)) {
      const targetBlockId = step.intent.targetBlockId;
      if (roots.some((id) => nodes.get(id)?.parentBlockId !== targetBlockId)) {
        return 'ambiguous_created_blocks';
      }
    } else if (step.intent.kind === 'replace' ||
      step.actions.some(({ kind }) => kind === 'replace-image-with-svg')) {
      const sibling = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
      if (!sibling || sibling.kind !== 'sibling-boundary') return 'invalid_checkpoint';
      const parent = nodes.get(sibling.parentBlockId);
      if (!parent || canonicalHash(idsBetween(
        parent.childBlockIds,
        parent.blockId,
        sibling.precedingBlockId,
        sibling.followingBlockId,
      )) !== canonicalHash(roots)) {
        return 'unexpected_remote_change';
      }
      if (step.actions.some(({ kind }) => kind === 'replace-image-with-svg')) {
        const verified = entry.verifiedResourceEvidence ?? [];
        const root = roots.length === 1 ? nodes.get(roots[0]!) : undefined;
        if (!root || root.kind !== 'whiteboard' || root.blockType !== 43 || verified.length !== 1 ||
          resourceToken(root) !== verified[0]!.token) return 'ambiguous_created_blocks';
      }
    }
  }
  return undefined;
}

function validateBeforeRead(input: AssessRecoveryInput): RecoveryReason | undefined {
  if (!input?.batch || !input?.checkpoint) return 'invalid_checkpoint';
  try {
    assertPreparedMutationBatchIntegrity(input.batch);
  } catch {
    return 'invalid_batch_integrity';
  }
  if (input.batch.schemaVersion !== ENGINE_SCHEMA_VERSION) return 'unsupported_schema_version';
  if (input.batch.engineVersion !== ENGINE_VERSION) return 'unsupported_engine_version';

  const { prewriteSnapshot, completedOperations } = input.checkpoint;
  if (!prewriteSnapshot || !Array.isArray(prewriteSnapshot.nodes) || !Array.isArray(completedOperations)) {
    return 'invalid_checkpoint';
  }
  if (prewriteSnapshot.documentId !== input.batch.documentId ||
    prewriteSnapshot.revision !== input.batch.expectedRevision ||
    prewriteSnapshot.canonicalHash !== input.batch.beforeSnapshotHash ||
    !snapshotIsSelfConsistent(prewriteSnapshot)) {
    return 'checkpoint_snapshot_mismatch';
  }
  if (!batchStructureMatchesCompiler(input.batch, prewriteSnapshot)) return 'invalid_batch_integrity';
  if (completedOperations.length > input.batch.steps.length) return 'checkpoint_not_prefix';

  for (const [index, entry] of completedOperations.entries()) {
    const step = input.batch.steps[index];
    if (!step || entry?.operationId !== step.operationId || entry.verified !== true ||
      typeof entry.revision !== 'string' || entry.revision.length === 0 ||
      typeof entry.afterSnapshotHash !== 'string' || entry.afterSnapshotHash.length === 0 ||
      !Array.isArray(entry.createdBlockIds) || new Set(entry.createdBlockIds).size !== entry.createdBlockIds.length) {
      return 'checkpoint_not_prefix';
    }
    if (!resourceEvidenceIsConsistent(entry.prewriteResourceEvidence) ||
      !resourceEvidenceIsConsistent(entry.verifiedResourceEvidence)) {
      return 'invalid_checkpoint';
    }
    if (step.kind === 'insert' && entry.createdBlockIds.length === 0) return 'invalid_checkpoint';
    if (step.actions.some(({ kind }) => kind === 'replace-image-with-svg') &&
      entry.createdBlockIds.length === 0) return 'invalid_checkpoint';
    if (step.actions.some(({ kind }) => kind === 'overwrite-whiteboard')) {
      const action = step.actions.find((item) => item.kind === 'overwrite-whiteboard');
      if (!action || action.kind !== 'overwrite-whiteboard' ||
        uniqueResourceEvidence(entry.verifiedResourceEvidence, action.targetToken) === undefined) {
        return 'resource_evidence_missing';
      }
    }
  }
  return undefined;
}

function batchStructureMatchesCompiler(
  batch: PreparedMutationBatch,
  snapshot: DocumentSnapshot,
): boolean {
  try {
    const compiled = prepareMutationBatch({
      snapshot,
      operations: batch.steps.map(({ intent }) => structuredClone(intent)),
      idempotencyNamespace: 'recovery-validation',
    });
    if (compiled.steps.length !== batch.steps.length) return false;
    return compiled.steps.every((step, index) => {
      const actual = batch.steps[index];
      return actual !== undefined && step.operationId === actual.operationId &&
        step.kind === actual.kind && canonicalHash(step.intent) === canonicalHash(actual.intent) &&
        canonicalHash(step.actions) === canonicalHash(actual.actions) &&
        canonicalHash(step.assertions) === canonicalHash(actual.assertions) &&
        typeof actual.idempotencyToken === 'string' && actual.idempotencyToken.length > 0;
    });
  } catch {
    return false;
  }
}

function snapshotIsSelfConsistent(snapshot: DocumentSnapshot): boolean {
  try {
    const rebuilt = createDocumentSnapshot({
      documentId: snapshot.documentId,
      revision: snapshot.revision,
      blocks: snapshot.nodes.map(({ raw }) => structuredClone(raw) as ProviderBlock),
    });
    return rebuilt.rootBlockId === snapshot.rootBlockId && rebuilt.canonicalHash === snapshot.canonicalHash &&
      rebuilt.nodes.length === snapshot.nodes.length && rebuilt.nodes.every((node, index) =>
        node.blockId === snapshot.nodes[index]?.blockId &&
        node.canonicalHash === snapshot.nodes[index]?.canonicalHash
      );
  } catch {
    return false;
  }
}

function resourceEvidenceIsConsistent(entries: ResourceStateEvidence[] | undefined): boolean {
  if (entries === undefined) return true;
  if (!Array.isArray(entries)) return false;
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || entry.resourceKind !== 'whiteboard' || typeof entry.token !== 'string' || !entry.token ||
      typeof entry.rawHash !== 'string') return false;
    try {
      if (canonicalWhiteboardRawHash(entry.raw) !== entry.rawHash) return false;
    } catch {
      return false;
    }
    const previous = seen.get(entry.token);
    if (previous !== undefined && previous !== entry.rawHash) return false;
    seen.set(entry.token, entry.rawHash);
  }
  return true;
}

async function readCompletedResources(
  transport: DocxTransport,
  completed: VerifiedOperationEvidence[],
): Promise<{ rawByToken: Map<string, unknown> } | { reason: RecoveryReason }> {
  const expected = new Map<string, string>();
  for (const entry of completed) {
    for (const evidence of entry.verifiedResourceEvidence ?? []) {
      const previous = expected.get(evidence.token);
      if (previous !== undefined && previous !== evidence.rawHash) return { reason: 'invalid_checkpoint' };
      expected.set(evidence.token, evidence.rawHash);
    }
  }
  const rawByToken = new Map<string, unknown>();
  for (const [token, rawHash] of expected) {
    let raw: unknown;
    try {
      raw = await transport.queryWhiteboard(token);
    } catch {
      return { reason: 'resource_state_unreadable' };
    }
    try {
      if (canonicalWhiteboardRawHash(raw) !== rawHash) return { reason: 'resource_state_mismatch' };
    } catch {
      return { reason: 'resource_state_unreadable' };
    }
    rawByToken.set(token, structuredClone(raw));
  }
  return { rawByToken };
}

async function verifyCompletedDesiredStates(
  transport: DocxTransport,
  batch: PreparedMutationBatch,
  completed: VerifiedOperationEvidence[],
  current: DocumentSnapshot,
  rawByToken: Map<string, unknown>,
): Promise<RecoveryReason | undefined> {
  const nodes = nodeIndex(current);
  for (const [index, entry] of completed.entries()) {
    const step = batch.steps[index]!;
    switch (step.intent.kind) {
      case 'assert':
      {
        const blockId = step.intent.blockId;
        if (!batch.steps.slice(index + 1, completed.length).some((later) =>
          stepChangesBlock(later, blockId)
        ) && nodes.get(blockId)?.canonicalHash !== step.intent.expectedHash) {
          return 'unexpected_remote_change';
        }
        break;
      }
      case 'replace':
        if (!matchesReplaceDesired(current, step, step.intent.desired)) return 'unexpected_remote_change';
        break;
      case 'insert': {
        const parent = nodes.get(step.intent.parentBlockId);
        const assertion = step.assertions.readback.find((item) => item.kind === 'inserted-desired');
        if (!parent || !assertion || assertion.kind !== 'inserted-desired' || !matchesDesiredIds(
          current,
          idsBetween(parent.childBlockIds, parent.blockId, assertion.precedingBlockId, assertion.followingBlockId),
          step.intent.desired,
        )) return 'unexpected_remote_change';
        break;
      }
      case 'delete':
        if (step.intent.blockIds.some((id) => nodes.has(id))) return 'unexpected_remote_change';
        break;
      case 'move': {
        const assertion = step.assertions.readback.find((item) => item.kind === 'sibling-order');
        if (!assertion || assertion.kind !== 'sibling-order' ||
          canonicalHash(nodes.get(assertion.parentBlockId)?.childBlockIds) !== canonicalHash(assertion.expectedChildBlockIds)) {
          return 'unexpected_remote_change';
        }
        break;
      }
      case 'whiteboard-overwrite': {
        const imageAction = step.actions.find((item) => item.kind === 'replace-image-with-svg');
        if (imageAction?.kind === 'replace-image-with-svg') {
          const verified = entry.verifiedResourceEvidence ?? [];
          if (verified.length !== 1) return 'resource_evidence_missing';
          const raw = rawByToken.get(verified[0]!.token);
          if (raw === undefined || !matchesSvgRaw(raw, imageAction.svg, verified[0]!.rawHash)) {
            return 'resource_state_mismatch';
          }
          break;
        }
        const action = step.actions.find((item) => item.kind === 'overwrite-whiteboard');
        if (!action || action.kind !== 'overwrite-whiteboard') return 'invalid_checkpoint';
        const raw = rawByToken.get(action.targetToken);
        if (raw === undefined) return 'resource_state_unreadable';
        if (action.desired.kind === 'raw') {
          if (canonicalWhiteboardRawHash(raw) !== canonicalWhiteboardRawHash(action.desired.value)) {
            return 'resource_state_mismatch';
          }
        } else if (action.desired.kind === 'svg') {
          const verified = uniqueResourceEvidence(entry.verifiedResourceEvidence, action.targetToken);
          if (!verified || !matchesSvgRaw(raw, action.desired.value, verified.rawHash)) {
            return 'resource_state_mismatch';
          }
        } else {
          let sourceRaw: unknown;
          try {
            sourceRaw = action.desired.sourceToken === action.targetToken
              ? raw
              : await transport.queryWhiteboard(action.desired.sourceToken);
          } catch {
            return 'resource_state_unreadable';
          }
          try {
            if (canonicalWhiteboardRawHash(raw) !== canonicalWhiteboardRawHash(sourceRaw)) {
              return 'resource_state_mismatch';
            }
          } catch {
            return 'resource_state_unreadable';
          }
        }
        break;
      }
    }
  }
  return undefined;
}

function stepChangesBlock(step: PreparedMutationStep, blockId: string): boolean {
  switch (step.intent.kind) {
    case 'assert':
      return false;
    case 'insert':
    case 'delete':
    case 'move':
      return step.intent.parentBlockId === blockId ||
        ('blockIds' in step.intent && step.intent.blockIds.includes(blockId));
    case 'replace': {
      if (step.intent.targetBlockId === blockId) return true;
      const parent = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
      return parent?.kind === 'sibling-boundary' && parent.parentBlockId === blockId;
    }
    case 'whiteboard-overwrite': {
      if (!step.actions.some(({ kind }) => kind === 'replace-image-with-svg')) return false;
      if (step.intent.targetBlockId === blockId) return true;
      const parent = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
      return parent?.kind === 'sibling-boundary' && parent.parentBlockId === blockId;
    }
  }
}

function matchesSvgRaw(raw: unknown, svg: string, verifiedHash: string): boolean {
  const expectedTexts = svgExpectedTexts(svg);
  return expectedTexts.length > 0 &&
    canonicalWhiteboardRawHash(raw) === verifiedHash &&
    whiteboardRawContainsTexts(raw, expectedTexts);
}

async function inferAcceptedNextOperation(
  transport: DocxTransport,
  batch: PreparedMutationBatch,
  before: DocumentSnapshot,
  current: DocumentSnapshot,
  completed: VerifiedOperationEvidence[],
): Promise<RecoveryAssessment | undefined> {
  const step = batch.steps[completed.length];
  if (!step || step.kind === 'assert') return undefined;
  const beforeIds = new Set(before.nodes.map(({ blockId }) => blockId));
  const priorCreated = new Set(completed.flatMap(({ createdBlockIds }) => createdBlockIds));
  const createdBlockIds = current.nodes
    .filter(({ blockId }) => !beforeIds.has(blockId) && !priorCreated.has(blockId))
    .map(({ blockId }) => blockId);
  const inferred: VerifiedOperationEvidence = {
    operationId: step.operationId,
    createdBlockIds,
    revision: current.revision,
    afterSnapshotHash: current.canonicalHash,
    verified: true,
  };
  const cumulative = [...completed, inferred];
  if (verifyCompletedGraphs(batch, cumulative, current) ||
    !unrelatedDocumentIsUnchanged(batch, cumulative, before, current)) return undefined;

  const completedResources = await readCompletedResources(transport, completed);
  if ('reason' in completedResources) return undefined;
  const rawByToken = completedResources.rawByToken;
  if (step.kind === 'whiteboard-overwrite') {
    const imageAction = step.actions.find((item) => item.kind === 'replace-image-with-svg');
    if (!imageAction || imageAction.kind !== 'replace-image-with-svg') return undefined;
    const tokens = createdBlockIds.flatMap((id) => {
      const node = nodeIndex(current).get(id);
      const token = node ? resourceToken(node) : undefined;
      return token ? [token] : [];
    });
    if (tokens.length !== 1) return undefined;
    let raw: unknown;
    try {
      raw = await transport.queryWhiteboard(tokens[0]!);
      canonicalWhiteboardRawHash(raw);
    } catch {
      return undefined;
    }
    const verified: ResourceStateEvidence = {
      resourceKind: 'whiteboard', token: tokens[0]!, rawHash: canonicalWhiteboardRawHash(raw), raw,
    };
    inferred.verifiedResourceEvidence = [verified];
    rawByToken.set(tokens[0]!, raw);
  }
  if (await verifyCompletedDesiredStates(transport, batch, cumulative, current, rawByToken)) return undefined;
  return frozen({
    disposition: 'resume_possible',
    completedOperationIds: cumulative.map(({ operationId }) => operationId),
    pendingOperationIds: batch.steps.slice(cumulative.length).map(({ operationId }) => operationId),
  });
}

type ReverseResult = { intents: MutationIntent[] } | { reason: RecoveryReason };

function buildReverseIntents(
  batch: PreparedMutationBatch,
  before: DocumentSnapshot,
  current: DocumentSnapshot,
  completed: VerifiedOperationEvidence[],
): ReverseResult {
  const intents: MutationIntent[] = [];
  const beforeNodes = nodeIndex(before);
  const currentNodes = nodeIndex(current);
  if (batch.steps.slice(0, completed.length).filter(({ kind }) => kind !== 'assert').length > 1) {
    return { reason: 'reverse_not_exactly_representable' };
  }

  for (let index = completed.length - 1; index >= 0; index -= 1) {
    const step = batch.steps[index]!;
    const entry = completed[index]!;
    const reversed = reverseStep(step, entry, before, current, beforeNodes, currentNodes);
    if ('reason' in reversed) return reversed;
    intents.push(...reversed.intents);
  }
  return { intents: structuredClone(intents) };
}

function reverseStep(
  step: PreparedMutationStep,
  evidence: VerifiedOperationEvidence,
  before: DocumentSnapshot,
  current: DocumentSnapshot,
  beforeNodes: Map<string, SnapshotNode>,
  currentNodes: Map<string, SnapshotNode>,
): ReverseResult {
  switch (step.intent.kind) {
    case 'assert':
      return { intents: [] };
    case 'insert': {
      const created = new Set(evidence.createdBlockIds);
      if (created.size === 0) return { reason: 'resource_evidence_missing' };
      const roots = currentNodes.get(step.intent.parentBlockId)?.childBlockIds.filter((id) => created.has(id)) ?? [];
      if (roots.length === 0 || !createdGraphIsExact(roots, created, currentNodes)) {
        return { reason: 'ambiguous_created_blocks' };
      }
      return { intents: [{
        operationId: `reverse:${step.operationId}`,
        kind: 'delete',
        parentBlockId: step.intent.parentBlockId,
        blockIds: roots,
        expectedHashes: roots.map((id) => currentNodes.get(id)!.canonicalHash),
      }] };
    }
    case 'delete': {
      const desired = decodeRoots(before, step.intent.blockIds);
      if (!desired) return { reason: 'reverse_not_exactly_representable' };
      const boundary = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
      if (!boundary || boundary.kind !== 'sibling-boundary') return { reason: 'invalid_checkpoint' };
      return { intents: [{
        operationId: `reverse:${step.operationId}`,
        kind: 'insert',
        parentBlockId: step.intent.parentBlockId,
        insertAfterBlockId: boundary.precedingBlockId,
        ...(boundary.followingBlockId ? { insertBeforeBlockId: boundary.followingBlockId } : {}),
        desired,
      }] };
    }
    case 'move': {
      const beforeParent = beforeNodes.get(step.intent.parentBlockId);
      if (!beforeParent) return { reason: 'invalid_checkpoint' };
      const indices = step.intent.blockIds.map((id) => beforeParent.childBlockIds.indexOf(id));
      const first = Math.min(...indices);
      if (first < 0 || indices.some((value, index) => value !== first + index)) {
        return { reason: 'reverse_not_exactly_representable' };
      }
      const preceding = first === 0 ? beforeParent.blockId : beforeParent.childBlockIds[first - 1]!;
      return { intents: [{
        operationId: `reverse:${step.operationId}`,
        kind: 'move',
        parentBlockId: step.intent.parentBlockId,
        blockIds: [...step.intent.blockIds],
        insertAfterBlockId: preceding,
      }] };
    }
    case 'replace': {
      const oldDesired = decodeExactlyRepresentableNode(before, beforeNodes.get(step.intent.targetBlockId));
      if (!oldDesired) return { reason: 'reverse_not_exactly_representable' };
      let targetBlockId = step.intent.targetBlockId;
      if (!currentNodes.has(targetBlockId)) {
        const boundary = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
        if (!boundary || boundary.kind !== 'sibling-boundary') return { reason: 'ambiguous_created_blocks' };
        const parent = currentNodes.get(boundary.parentBlockId);
        if (!parent) return { reason: 'unexpected_remote_change' };
        const candidates = idsBetween(parent.childBlockIds, parent.blockId, boundary.precedingBlockId, boundary.followingBlockId);
        if (candidates.length !== 1 || !evidence.createdBlockIds.includes(candidates[0]!)) {
          return { reason: 'ambiguous_created_blocks' };
        }
        targetBlockId = candidates[0]!;
      }
      return { intents: [{
        operationId: `reverse:${step.operationId}`,
        kind: 'replace',
        targetBlockId,
        expectedHash: currentNodes.get(targetBlockId)!.canonicalHash,
        desired: oldDesired,
      }] };
    }
    case 'whiteboard-overwrite': {
      if (step.actions.some(({ kind }) => kind === 'replace-image-with-svg')) {
        return { reason: 'reverse_not_exactly_representable' };
      }
      const action = step.actions.find((item) => item.kind === 'overwrite-whiteboard');
      if (!action || action.kind !== 'overwrite-whiteboard') return { reason: 'invalid_checkpoint' };
      const prewrite = uniqueResourceEvidence(evidence.prewriteResourceEvidence, action.targetToken);
      if (!prewrite) return { reason: 'resource_evidence_missing' };
      const target = currentNodes.get(action.targetBlockId);
      if (!target || resourceToken(target) !== action.targetToken) return { reason: 'unexpected_remote_change' };
      return { intents: [{
        operationId: `reverse:${step.operationId}`,
        kind: 'whiteboard-overwrite',
        targetBlockId: action.targetBlockId,
        expectedTargetHash: target.canonicalHash,
        desired: { kind: 'raw', value: structuredClone(prewrite.raw) },
      }] };
    }
  }
}

function createdGraphIsExact(
  roots: string[],
  expected: Set<string>,
  nodes: Map<string, SnapshotNode>,
): boolean {
  const actual = new Set<string>();
  const visit = (id: string): boolean => {
    if (actual.has(id) || !expected.has(id)) return false;
    const node = nodes.get(id);
    if (!node) return false;
    actual.add(id);
    return node.childBlockIds.every(visit);
  };
  return roots.every(visit) && actual.size === expected.size;
}

function uniqueResourceEvidence(
  entries: ResourceStateEvidence[] | undefined,
  token: string,
): ResourceStateEvidence | undefined {
  const matches = entries?.filter((entry) => entry.token === token) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function matchesReplaceDesired(
  snapshot: DocumentSnapshot,
  step: PreparedMutationStep,
  desired: DesiredNode,
): boolean {
  const nodes = nodeIndex(snapshot);
  if (step.intent.kind !== 'replace') return false;
  if (step.intent.targetBlockId === snapshot.rootBlockId) {
    const root = nodes.get(snapshot.rootBlockId);
    return root !== undefined && matchesDesiredNode(snapshot, root, desired);
  }
  const boundary = step.assertions.preflight.find((item) => item.kind === 'sibling-boundary');
  if (boundary?.kind === 'sibling-boundary') {
    const parent = nodes.get(boundary.parentBlockId);
    return parent !== undefined && matchesDesiredIds(
      snapshot,
      idsBetween(parent.childBlockIds, parent.blockId, boundary.precedingBlockId, boundary.followingBlockId),
      [desired],
    );
  }
  const target = nodes.get(step.intent.targetBlockId);
  return target !== undefined && matchesDesiredNode(snapshot, target, desired);
}

function matchesDesiredIds(
  snapshot: DocumentSnapshot,
  ids: string[],
  desired: DesiredNode[],
): boolean {
  const nodes = nodeIndex(snapshot);
  let cursor = 0;
  for (const desiredNode of desired) {
    if (desiredNode.kind === 'list') {
      const listIds = ids.slice(cursor, cursor + desiredNode.items.length);
      if (!matchesDesiredList(snapshot, listIds, desiredNode)) return false;
      cursor += desiredNode.items.length;
    } else {
      const actual = nodes.get(ids[cursor] ?? '');
      if (!actual || !matchesDesiredNode(snapshot, actual, desiredNode)) return false;
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
  if (desired.kind === 'table') return matchesDesiredTable(snapshot, actual, desired);
  if (desired.kind === 'callout') return matchesDesiredCallout(snapshot, actual, desired);
  if (desired.kind === 'list') return matchesDesiredList(snapshot, [actual.blockId], desired);
  const decoded = decodeNode(snapshot, actual);
  return decoded !== undefined && canonicalHash(decoded) === canonicalHash(desired);
}

function matchesDesiredTable(
  snapshot: DocumentSnapshot,
  actual: SnapshotNode,
  desired: Extract<DesiredNode, { kind: 'table' }>,
): boolean {
  if (actual.kind !== 'table' || actual.blockType !== 31) return false;
  const table = asRecord(actual.raw.table);
  const property = asRecord(table?.property);
  const rows = numberValue(property?.row_size);
  const columns = numberValue(property?.column_size);
  const desiredRows = desired.rows.length;
  const desiredColumns = desired.rows[0]?.cells.length ?? 0;
  if (rows !== desiredRows || columns !== desiredColumns || !rows || !columns ||
    actual.childBlockIds.length !== rows * columns ||
    !hasExactUnmergedCells(property?.merge_info, rows * columns)) return false;
  const nodes = nodeIndex(snapshot);
  let cellIndex = 0;
  for (const row of desired.rows) {
    if (row.cells.length !== columns) return false;
    for (const cell of row.cells) {
      const actualCell = nodes.get(actual.childBlockIds[cellIndex++]!);
      if (!actualCell || actualCell.blockType !== 32 ||
        !matchesDesiredIds(snapshot, actualCell.childBlockIds, cell.content)) return false;
    }
  }
  return true;
}

function matchesDesiredList(
  snapshot: DocumentSnapshot,
  blockIds: string[],
  desired: Extract<DesiredNode, { kind: 'list' }>,
): boolean {
  if (blockIds.length !== desired.items.length) return false;
  const nodes = nodeIndex(snapshot);
  return blockIds.every((blockId, index) => {
    const actual = nodes.get(blockId);
    const item = desired.items[index]!;
    if (!actual || actual.kind !== 'list' || actual.blockType !== (desired.ordered ? 13 : 12) ||
      canonicalHash(decodeInline(actual.raw, desired.ordered ? 'ordered' : 'bullet')) !== canonicalHash(item.content)) {
      return false;
    }
    return item.children.length === 0
      ? actual.childBlockIds.length === 0
      : item.children.length === 1 && matchesDesiredList(snapshot, actual.childBlockIds, item.children[0]!);
  });
}

function matchesDesiredCallout(
  snapshot: DocumentSnapshot,
  actual: SnapshotNode,
  desired: Extract<DesiredNode, { kind: 'callout' }>,
): boolean {
  if (actual.kind !== 'callout') return false;
  const raw = asRecord(actual.raw.callout);
  const emoji = typeof raw?.emoji_id === 'string' ? raw.emoji_id : raw?.emoji;
  const actualType = emoji === '❗' ? 'warning' : emoji === '📘' ? 'note' : undefined;
  if (actualType !== desired.calloutType) return false;
  const nodes = nodeIndex(snapshot);
  const children = actual.childBlockIds.map((id) => nodes.get(id)).filter(Boolean) as SnapshotNode[];
  let offset = 0;
  if (desired.title !== undefined) {
    const title = children[0] && decodeNode(snapshot, children[0]);
    if (!title || title.kind !== 'paragraph' || title.content.map(({ text }) => text).join('') !== desired.title) return false;
    offset = 1;
  }
  return matchesDesiredIds(snapshot, children.slice(offset).map(({ blockId }) => blockId), desired.children);
}

function decodeRoots(snapshot: DocumentSnapshot, ids: string[]): DesiredNode[] | undefined {
  const values: DesiredNode[] = [];
  for (const id of ids) {
    const value = decodeExactlyRepresentableNode(snapshot, nodeIndex(snapshot).get(id));
    if (!value) return undefined;
    values.push(value);
  }
  return values;
}

function decodeExactlyRepresentableNode(
  snapshot: DocumentSnapshot,
  node: SnapshotNode | undefined,
): DesiredNode | undefined {
  const desired = decodeNode(snapshot, node);
  if (!node || !desired || !desiredExactlyRepresentsNode(snapshot, node, desired)) return undefined;
  return desired;
}

function desiredExactlyRepresentsNode(
  snapshot: DocumentSnapshot,
  node: SnapshotNode,
  desired: DesiredNode,
): boolean {
  if (desired.kind === 'table') return tableIsExactlyRepresentable(snapshot, node, desired);
  if (desired.kind === 'callout') return false;
  let encoded: ProviderBlock;
  try {
    encoded = toProviderBlock(desired);
  } catch {
    return false;
  }
  if (semanticRawHash(node.raw) !== semanticRawHash(encoded)) return false;
  if (desired.kind === 'title') return true;
  if (desired.kind !== 'list') return node.childBlockIds.length === 0;
  const childDesired = desired.items[0]?.children ?? [];
  if (node.childBlockIds.length !== childDesired.length) return false;
  return node.childBlockIds.every((childId, index) => {
    const child = nodeIndex(snapshot).get(childId);
    const expected = childDesired[index];
    return child !== undefined && expected !== undefined &&
      desiredExactlyRepresentsNode(snapshot, child, expected);
  });
}

function tableIsExactlyRepresentable(
  snapshot: DocumentSnapshot,
  node: SnapshotNode,
  desired: Extract<DesiredNode, { kind: 'table' }>,
): boolean {
  if (Object.keys(node.raw).some((key) =>
    key !== 'block_id' && key !== 'parent_id' && key !== 'children' &&
    key !== 'block_type' && key !== 'table'
  )) return false;
  const table = asRecord(node.raw.table);
  const property = asRecord(table?.property);
  if (!table || Object.keys(table).some((key) => key !== 'property' && key !== 'cells')) return false;
  if (!property || Object.keys(property).some((key) =>
    key !== 'row_size' && key !== 'column_size' && key !== 'merge_info'
  )) return false;
  if (!hasExactUnmergedCells(property.merge_info, node.childBlockIds.length)) return false;
  const nodes = nodeIndex(snapshot);
  let cellIndex = 0;
  for (const row of desired.rows) {
    for (const cell of row.cells) {
      const actualCell = nodes.get(node.childBlockIds[cellIndex++]!);
      if (!actualCell || !tableCellShellIsRepresentable(actualCell.raw) ||
        actualCell.childBlockIds.length !== cell.content.length) return false;
      for (const [contentIndex, content] of cell.content.entries()) {
        const actual = nodes.get(actualCell.childBlockIds[contentIndex]!);
        if (!actual || !desiredExactlyRepresentsNode(snapshot, actual, content)) return false;
      }
    }
  }
  return true;
}

function tableCellShellIsRepresentable(raw: Record<string, unknown>): boolean {
  const semanticKeys = Object.keys(raw).filter((key) =>
    key !== 'block_id' && key !== 'parent_id' && key !== 'children' && key !== 'block_type'
  );
  if (semanticKeys.length === 0) return true;
  if (semanticKeys.length !== 1 || semanticKeys[0] !== 'table_cell') return false;
  const payload = asRecord(raw.table_cell);
  return payload !== undefined && Object.keys(payload).length === 0;
}

function decodeNode(snapshot: DocumentSnapshot, node: SnapshotNode | undefined): DesiredNode | undefined {
  if (!node) return undefined;
  if (node.kind === 'page') return { kind: 'title', content: decodeInline(node.raw, 'page') };
  if (node.kind === 'paragraph') return { kind: 'paragraph', content: decodeInline(node.raw, 'text') };
  if (node.kind === 'heading') {
    const level = node.blockType - 2;
    if (level < 1 || level > 6) return undefined;
    return { kind: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, content: decodeInline(node.raw, `heading${level}`) };
  }
  if (node.kind === 'quote' || node.blockType === 15) return { kind: 'quote', content: decodeInline(node.raw, 'quote') };
  if (node.kind === 'code') {
    const payload = asRecord(node.raw.code);
    const language = providerLanguageName(asRecord(payload?.style)?.language);
    const caption = asRecord(payload?.style)?.caption;
    return {
      kind: 'code', language, text: decodeInline(node.raw, 'code').map(({ text }) => text).join(''),
      ...(typeof caption === 'string' ? { caption } : {}),
    };
  }
  if (node.kind === 'list') {
    const key = node.blockType === 13 ? 'ordered' : node.blockType === 12 ? 'bullet' : undefined;
    if (!key) return undefined;
    const children = node.childBlockIds.map((id) => decodeNode(snapshot, nodeIndex(snapshot).get(id)));
    if (children.some((value) => value?.kind !== 'list')) return undefined;
    return {
      kind: 'list', ordered: node.blockType === 13,
      items: [{ content: decodeInline(node.raw, key), children: children as Extract<DesiredNode, { kind: 'list' }>[] }],
    };
  }
  if (node.kind === 'table') return decodeTable(snapshot, node);
  return undefined;
}

function decodeTable(
  snapshot: DocumentSnapshot,
  tableNode: SnapshotNode,
): Extract<DesiredNode, { kind: 'table' }> | undefined {
  const table = asRecord(tableNode.raw.table);
  const property = asRecord(table?.property);
  const rowSize = numberValue(property?.row_size ?? property?.rowSize);
  const columnSize = numberValue(property?.column_size ?? property?.columnSize);
  if (!rowSize || !columnSize || rowSize * columnSize !== tableNode.childBlockIds.length) return undefined;
  if (!hasExactUnmergedCells(property?.merge_info, rowSize * columnSize)) return undefined;
  const nodes = nodeIndex(snapshot);
  const cells = tableNode.childBlockIds.map((cellId) => {
    const cell = nodes.get(cellId);
    if (!cell || cell.blockType !== 32) return undefined;
    return decodeRoots(snapshot, cell.childBlockIds);
  });
  if (cells.some((cell) => cell === undefined)) return undefined;
  return {
    kind: 'table',
    rows: Array.from({ length: rowSize }, (_, row) => ({
      cells: Array.from({ length: columnSize }, (_, column) => ({
        content: cells[row * columnSize + column]!,
      })),
    })),
  };
}

function hasExactUnmergedCells(value: unknown, cellCount: number): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== cellCount) return false;
  return value.every((entry) => {
    if (entry === null || entry === undefined) return true;
    const info = asRecord(entry);
    return info?.row_span === 1 && info.col_span === 1;
  });
}

function decodeInline(raw: Record<string, unknown>, key: string): InlineContent[] {
  const payload = asRecord(raw[key]);
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  return elements.flatMap((value): InlineContent[] => {
    const run = asRecord(asRecord(value)?.text_run);
    if (!run || typeof run.content !== 'string') return [];
    const style = asRecord(run.text_element_style);
    const link = asRecord(style?.link);
    if (typeof link?.url === 'string') {
      return [{ kind: 'link', text: run.content, url: normalizeProviderLinkUrl(link.url) }];
    }
    if (style?.inline_code === true) return [{ kind: 'code', text: run.content }];
    return [{
      kind: 'text', text: run.content,
      ...(style?.bold === true ? { bold: true } : {}),
      ...(style?.italic === true ? { italic: true } : {}),
      ...(style?.underline === true ? { underline: true } : {}),
      ...(style?.strikethrough === true ? { strike: true } : {}),
    }];
  });
}

function providerLanguageName(value: unknown): string {
  if (typeof value === 'string') return value;
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

function idsBetween(
  childIds: string[],
  parentBlockId: string,
  precedingBlockId: string,
  followingBlockId?: string,
): string[] {
  const precedingIndex = precedingBlockId === parentBlockId ? -1 : childIds.indexOf(precedingBlockId);
  if (precedingBlockId !== parentBlockId && precedingIndex < 0) return [];
  const start = precedingIndex + 1;
  const end = followingBlockId === undefined ? childIds.length : childIds.indexOf(followingBlockId);
  if (end < 0 || end < start) return [];
  return childIds.slice(start, end);
}

function resourceToken(node: SnapshotNode): string | undefined {
  const payload = asRecord(node.raw.whiteboard) ?? asRecord(node.raw.board);
  return typeof payload?.token === 'string' ? payload.token : undefined;
}

function nodeIndex(snapshot: DocumentSnapshot): Map<string, SnapshotNode> {
  return new Map(snapshot.nodes.map((node) => [node.blockId, node]));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function manual(reason: RecoveryReason): RecoveryAssessment {
  return frozen({ disposition: 'manual_inspection_required', reason });
}

function frozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
