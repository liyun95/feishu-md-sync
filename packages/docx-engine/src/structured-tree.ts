import { canonicalHash } from './hash.js';
import { normalizeProviderLinkUrl } from './codec.js';
import type { DocumentSnapshot, SnapshotNode } from './model.js';
import { createDocumentSnapshot } from './snapshot.js';
import type { DocxTransport, ProviderBlock } from './transport.js';

export type StructuredTreeRecoveryDisposition =
  | 'resume_possible'
  | 'manual_inspection_required';

export class StructuredTreeProgressError extends Error {
  readonly attempted: boolean;
  readonly wrote: boolean;
  readonly createdBlockIds: string[];
  readonly lastSnapshot: DocumentSnapshot;
  readonly phase: 'provider' | 'verification';
  readonly providerRevision?: string;
  readonly recoveryDisposition: StructuredTreeRecoveryDisposition;

  constructor(input: {
    cause: unknown;
    attempted: boolean;
    wrote: boolean;
    createdBlockIds: string[];
    lastSnapshot: DocumentSnapshot;
    phase: 'provider' | 'verification';
    providerRevision?: string;
    recoveryDisposition: StructuredTreeRecoveryDisposition;
  }) {
    super(input.cause instanceof Error ? input.cause.message : String(input.cause), { cause: input.cause });
    this.name = 'StructuredTreeProgressError';
    this.attempted = input.attempted;
    this.wrote = input.wrote;
    this.createdBlockIds = [...input.createdBlockIds];
    this.lastSnapshot = input.lastSnapshot;
    this.phase = input.phase;
    this.providerRevision = input.providerRevision;
    this.recoveryDisposition = input.recoveryDisposition;
  }
}

export interface CreateVerifiedStructuredTreeInput {
  transport: DocxTransport;
  documentId: string;
  batchFingerprint: string;
  operationId: string;
  actionIndex: number;
  segmentIndex: number;
  parentBlockId: string;
  insertionIndex: number;
  desiredTrees: ProviderBlock[];
  operationBefore: DocumentSnapshot;
  currentSnapshot: DocumentSnapshot;
}

export interface CreateVerifiedStructuredTreeResult {
  snapshot: DocumentSnapshot;
  createdBlockIds: string[];
  providerRevision?: string;
}

type CreatedExpectation = {
  blockId: string;
  parentBlockId: string;
  desired: ProviderBlock;
  childBlockIds: string[];
};

type TreeState = {
  input: CreateVerifiedStructuredTreeInput;
  snapshot: DocumentSnapshot;
  createdBlockIds: string[];
  created: Map<string, CreatedExpectation>;
  rootChildBlockIds: string[];
  providerRevision?: string;
};

/** Create provider tree shells in deterministic batches and verify each prefix before proceeding. */
export async function createVerifiedStructuredTree(
  input: CreateVerifiedStructuredTreeInput,
): Promise<CreateVerifiedStructuredTreeResult> {
  if (input.desiredTrees.length === 0) {
    throw new Error('Structured provider-tree creation requires at least one root.');
  }
  const root = nodeIndex(input.operationBefore).get(input.parentBlockId);
  if (!root) throw new Error(`Structured provider-tree parent ${input.parentBlockId} is missing.`);
  const rootChildBlockIds = [...root.childBlockIds];
  const state: TreeState = {
    input,
    snapshot: input.currentSnapshot,
    createdBlockIds: [],
    created: new Map(),
    rootChildBlockIds,
  };

  const roots = await createBatch(state, {
    parentBlockId: input.parentBlockId,
    index: input.insertionIndex,
    desired: input.desiredTrees,
    path: [],
  });
  verifyAccumulatedPrefix(state, state.snapshot);

  for (const [index, desired] of input.desiredTrees.entries()) {
    await createDescendants(state, roots[index]!, desired, [index]);
  }

  return {
    snapshot: state.snapshot,
    createdBlockIds: [...state.createdBlockIds],
    ...(state.providerRevision !== undefined ? { providerRevision: state.providerRevision } : {}),
  };
}

async function createDescendants(
  state: TreeState,
  parentBlockId: string,
  desiredParent: ProviderBlock,
  path: number[],
): Promise<void> {
  const desiredChildren = providerChildren(desiredParent);
  if (desiredChildren.length === 0) return;
  const children = await createBatch(state, {
    parentBlockId,
    index: 0,
    desired: desiredChildren,
    path,
  });
  state.created.get(parentBlockId)!.childBlockIds = [...children];
  verifyAccumulatedPrefix(state, state.snapshot);
  for (const [index, desired] of desiredChildren.entries()) {
    await createDescendants(state, children[index]!, desired, [...path, index]);
  }
}

async function createBatch(
  state: TreeState,
  batch: {
    parentBlockId: string;
    index: number;
    desired: ProviderBlock[];
    path: number[];
  },
): Promise<string[]> {
  const before = await fetchAndAssertNoDrift(state);
  const shells = batch.desired.map(providerShell);
  const clientToken = structuredTreeClientToken({
    batchFingerprint: state.input.batchFingerprint,
    operationId: state.input.operationId,
    actionIndex: state.input.actionIndex,
    segmentIndex: state.input.segmentIndex,
    path: batch.path,
  });

  let response: Awaited<ReturnType<DocxTransport['createChildren']>> | undefined;
  let providerCause: unknown;
  let providerFailed = false;
  try {
    response = await state.input.transport.createChildren({
      documentId: state.input.documentId,
      parentBlockId: batch.parentBlockId,
      index: batch.index,
      blocks: structuredClone(shells),
      clientToken,
    });
    if (response.revision !== undefined) state.providerRevision = response.revision;
    validateCreatedResponse(response.blocks, shells, batch.parentBlockId, response.clientToken, clientToken);
  } catch (cause) {
    providerFailed = true;
    providerCause = cause;
  }

  if (providerFailed) {
    return reconcileAmbiguousBatch(state, batch, before, providerCause);
  }

  const createdIds = response!.blocks.map((block) => block.block_id!);
  registerCreatedBatch(state, batch.parentBlockId, batch.desired, createdIds);
  let observed: DocumentSnapshot | undefined;
  try {
    observed = await fetchSnapshot(state.input.transport, state.input.documentId);
    installExpectedChildOrder(state, batch.parentBlockId, batch.index, createdIds);
    verifyAccumulatedPrefix(state, observed);
    state.snapshot = observed;
    state.createdBlockIds.push(...createdIds);
    return createdIds;
  } catch (cause) {
    unregisterCreatedBatch(state, createdIds);
    throw progressError(state, cause, {
      attempted: true,
      wrote: true,
      phase: 'verification',
      createdBlockIds: [...state.createdBlockIds, ...createdIds],
      disposition: 'manual_inspection_required',
      ...(observed !== undefined ? { snapshot: observed } : {}),
    });
  }
}

async function reconcileAmbiguousBatch(
  state: TreeState,
  batch: { parentBlockId: string; index: number; desired: ProviderBlock[]; path: number[] },
  before: DocumentSnapshot,
  cause: unknown,
): Promise<string[]> {
  let observed: DocumentSnapshot;
  try {
    observed = await fetchSnapshot(state.input.transport, state.input.documentId);
  } catch (readbackCause) {
    throw progressError(state, readbackCause, {
      attempted: true,
      wrote: true,
      phase: 'provider',
      createdBlockIds: state.createdBlockIds,
      disposition: 'manual_inspection_required',
    });
  }

  if (sameSnapshot(before, observed)) {
    throw progressError(state, cause, {
      attempted: true,
      wrote: state.createdBlockIds.length > 0,
      phase: 'provider',
      createdBlockIds: state.createdBlockIds,
      disposition: state.createdBlockIds.length > 0
        ? 'resume_possible'
        : 'manual_inspection_required',
      snapshot: observed,
    });
  }

  const createdIds = insertedIds(before, observed, batch.parentBlockId, batch.index, batch.desired.length);
  if (createdIds.length !== batch.desired.length) {
    throw progressError(state, cause, {
      attempted: true,
      wrote: true,
      phase: 'provider',
      createdBlockIds: state.createdBlockIds,
      disposition: 'manual_inspection_required',
      snapshot: observed,
    });
  }
  registerCreatedBatch(state, batch.parentBlockId, batch.desired, createdIds);
  try {
    installExpectedChildOrder(state, batch.parentBlockId, batch.index, createdIds);
    verifyAccumulatedPrefix(state, observed);
  } catch (verificationCause) {
    unregisterCreatedBatch(state, createdIds);
    throw progressError(state, verificationCause, {
      attempted: true,
      wrote: true,
      phase: 'provider',
      createdBlockIds: [...state.createdBlockIds, ...createdIds],
      disposition: 'manual_inspection_required',
      snapshot: observed,
    });
  }
  state.snapshot = observed;
  state.providerRevision = observed.revision;
  state.createdBlockIds.push(...createdIds);
  return createdIds;
}

async function fetchAndAssertNoDrift(state: TreeState): Promise<DocumentSnapshot> {
  let observed: DocumentSnapshot;
  try {
    observed = await fetchSnapshot(state.input.transport, state.input.documentId);
  } catch (cause) {
    throw progressError(state, cause, {
      attempted: false,
      wrote: state.createdBlockIds.length > 0,
      phase: 'verification',
      createdBlockIds: state.createdBlockIds,
      disposition: 'manual_inspection_required',
    });
  }
  if (!sameSnapshot(state.snapshot, observed)) {
    throw progressError(state, new Error('Structured provider-tree no-drift gate observed a changed snapshot.'), {
      attempted: false,
      wrote: state.createdBlockIds.length > 0,
      phase: 'verification',
      createdBlockIds: state.createdBlockIds,
      disposition: 'manual_inspection_required',
      snapshot: observed,
    });
  }
  verifyAccumulatedPrefix(state, observed);
  state.snapshot = observed;
  return observed;
}

function validateCreatedResponse(
  actual: ProviderBlock[],
  desired: ProviderBlock[],
  parentBlockId: string,
  returnedToken: string | undefined,
  expectedToken: string,
): void {
  if (!Array.isArray(actual) || actual.length !== desired.length) {
    throw new Error('Structured provider-tree response count differs from the requested batch.');
  }
  const ids = actual.map(({ block_id }) => block_id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(ids).size !== ids.length) {
    throw new Error('Structured provider-tree response contains missing or duplicate block IDs.');
  }
  if (returnedToken !== undefined && returnedToken !== expectedToken) {
    throw new Error('Structured provider-tree response returned a different client token.');
  }
  actual.forEach((block, index) => {
    const expected = desired[index]!;
    if (block.block_type !== expected.block_type ||
      (block.parent_id !== undefined && block.parent_id !== parentBlockId) ||
      providerShellHash(block) !== providerShellHash(expected)) {
      throw new Error('Structured provider-tree response block type, parent, or semantic shell differs.');
    }
  });
}

function verifyAccumulatedPrefix(state: TreeState, snapshot: DocumentSnapshot): void {
  const beforeNodes = nodeIndex(state.input.operationBefore);
  const actualNodes = nodeIndex(snapshot);
  if (snapshot.documentId !== state.input.operationBefore.documentId) {
    throw new Error('Structured provider-tree readback resolved a different document.');
  }

  for (const [blockId, before] of beforeNodes) {
    const actual = actualNodes.get(blockId);
    if (!actual) throw new Error(`Structured provider-tree readback lost unrelated block ${blockId}.`);
    if (blockId === state.input.parentBlockId) {
      if (parentSemanticHash(before) !== parentSemanticHash(actual) ||
        !sameStrings(actual.childBlockIds, state.rootChildBlockIds)) {
        throw new Error('Structured provider-tree root parent content or exact sibling order changed.');
      }
    } else if (actual.canonicalHash !== before.canonicalHash) {
      throw new Error(`Structured provider-tree readback changed unrelated block ${blockId}.`);
    }
  }

  const extraIds = snapshot.nodes
    .filter(({ blockId }) => !beforeNodes.has(blockId))
    .map(({ blockId }) => blockId);
  if (extraIds.length !== state.created.size || extraIds.some((id) => !state.created.has(id))) {
    throw new Error('Structured provider-tree readback contains an unplanned created block.');
  }

  for (const expectation of state.created.values()) {
    const actual = actualNodes.get(expectation.blockId);
    if (!actual || actual.parentBlockId !== expectation.parentBlockId ||
      actual.blockType !== expectation.desired.block_type ||
      providerShellHash(actual.raw as ProviderBlock) !== providerShellHash(expectation.desired) ||
      !sameStrings(actual.childBlockIds, expectation.childBlockIds)) {
      throw new Error(`Structured provider-tree readback differs at created block ${expectation.blockId}.`);
    }
  }
}

function registerCreatedBatch(
  state: TreeState,
  parentBlockId: string,
  desired: ProviderBlock[],
  createdIds: string[],
): void {
  createdIds.forEach((blockId, index) => {
    state.created.set(blockId, {
      blockId,
      parentBlockId,
      desired: providerShell(desired[index]!),
      childBlockIds: [],
    });
  });
}

function unregisterCreatedBatch(state: TreeState, createdIds: string[]): void {
  createdIds.forEach((blockId) => state.created.delete(blockId));
}

function installExpectedChildOrder(
  state: TreeState,
  parentBlockId: string,
  index: number,
  createdIds: string[],
): void {
  if (parentBlockId === state.input.parentBlockId) {
    state.rootChildBlockIds.splice(index, 0, ...createdIds);
    return;
  }
  const parent = state.created.get(parentBlockId);
  if (!parent) throw new Error(`Structured provider-tree expected parent ${parentBlockId} is unknown.`);
  parent.childBlockIds.splice(index, 0, ...createdIds);
}

function insertedIds(
  before: DocumentSnapshot,
  after: DocumentSnapshot,
  parentBlockId: string,
  index: number,
  count: number,
): string[] {
  const beforeParent = nodeIndex(before).get(parentBlockId);
  const afterParent = nodeIndex(after).get(parentBlockId);
  if (!beforeParent || !afterParent) return [];
  const inserted = afterParent.childBlockIds.slice(index, index + count);
  const expected = [...beforeParent.childBlockIds];
  expected.splice(index, 0, ...inserted);
  if (!sameStrings(afterParent.childBlockIds, expected)) return [];
  const beforeIds = new Set(before.nodes.map(({ blockId }) => blockId));
  return inserted.every((id) => !beforeIds.has(id)) ? inserted : [];
}

function progressError(
  state: TreeState,
  cause: unknown,
  input: {
    attempted: boolean;
    wrote: boolean;
    phase: 'provider' | 'verification';
    createdBlockIds: string[];
    disposition: StructuredTreeRecoveryDisposition;
    snapshot?: DocumentSnapshot;
  },
): StructuredTreeProgressError {
  return new StructuredTreeProgressError({
    cause,
    attempted: input.attempted,
    wrote: input.wrote,
    createdBlockIds: input.createdBlockIds,
    lastSnapshot: input.snapshot ?? state.snapshot,
    phase: input.phase,
    ...(state.providerRevision !== undefined ? { providerRevision: state.providerRevision } : {}),
    recoveryDisposition: input.disposition,
  });
}

export function structuredTreeClientToken(input: {
  batchFingerprint: string;
  operationId: string;
  actionIndex: number;
  segmentIndex: number;
  path: number[];
}): string {
  const digest = canonicalHash({
    batchFingerprint: input.batchFingerprint,
    operationId: input.operationId,
    actionIndex: input.actionIndex,
    segmentIndex: input.segmentIndex,
    path: input.path,
  }).slice(0, 32).split('');
  digest[12] = '4';
  digest[16] = '8';
  const value = digest.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-` +
    `${value.slice(16, 20)}-${value.slice(20)}`;
}

function providerChildren(block: ProviderBlock): ProviderBlock[] {
  return Array.isArray(block.children)
    ? block.children.filter((child): child is ProviderBlock =>
      child !== null && typeof child === 'object' && !Array.isArray(child)
    )
    : [];
}

function providerShell(block: ProviderBlock): ProviderBlock {
  const clone = structuredClone(block);
  delete clone.block_id;
  delete clone.parent_id;
  delete clone.children;
  return clone;
}

function providerShellHash(block: ProviderBlock): string {
  const shell = providerShell(block);
  normalizeProviderShellSemantics(shell);
  for (const key of Object.keys(shell)) {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (normalized === 'revision' || normalized === 'revisionid' ||
      normalized === 'documentrevision' || normalized === 'documentrevisionid') {
      delete shell[key];
    }
  }
  return canonicalHash(shell);
}

function normalizeProviderShellSemantics(shell: ProviderBlock): void {
  for (const key of ['bullet', 'ordered']) {
    const payload = asRecord(shell[key]);
    if (!payload) continue;
    const payloadStyle = asRecord(payload.style);
    if (payloadStyle) {
      if (payloadStyle.align === 1) delete payloadStyle.align;
      if (payloadStyle.folded === false) delete payloadStyle.folded;
      if (Object.keys(payloadStyle).length === 0) delete payload.style;
    }
    const elements = Array.isArray(payload.elements) ? payload.elements : [];
    for (const value of elements) {
      const run = asRecord(asRecord(value)?.text_run);
      const style = asRecord(run?.text_element_style);
      const link = asRecord(style?.link);
      if (typeof link?.url === 'string') link.url = normalizeProviderLinkUrl(link.url);
    }
  }
}

function parentSemanticHash(node: SnapshotNode): string {
  return providerShellHash(node.raw as ProviderBlock);
}

async function fetchSnapshot(
  transport: DocxTransport,
  documentId: string,
): Promise<DocumentSnapshot> {
  const fetched = await transport.fetchBlocks(documentId);
  return createDocumentSnapshot({ documentId, ...fetched });
}

function nodeIndex(snapshot: DocumentSnapshot): Map<string, SnapshotNode> {
  return new Map(snapshot.nodes.map((node) => [node.blockId, node]));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sameSnapshot(left: DocumentSnapshot, right: DocumentSnapshot): boolean {
  return left.documentId === right.documentId && left.revision === right.revision &&
    left.canonicalHash === right.canonicalHash;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
