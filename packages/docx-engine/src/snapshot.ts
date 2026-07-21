import { canonicalHash } from './hash.js';
import type { DocumentSnapshot, SnapshotNode } from './model.js';
import type { ProviderBlock } from './transport.js';

export interface CreateDocumentSnapshotInput {
  documentId: string;
  revision: string;
  blocks: ProviderBlock[];
}

type RegisteredBlock = {
  block: ProviderBlock;
  childBlockIds: string[];
};

const VOLATILE_REVISION_KEYS = new Set([
  'revision',
  'revisionid',
  'documentrevision',
  'documentrevisionid',
]);

export function createDocumentSnapshot(
  input: CreateDocumentSnapshotInput,
): DocumentSnapshot {
  if (!input.documentId) throw new Error('Document snapshot requires a documentId.');
  if (typeof input.revision !== 'string') {
    throw new Error('Document snapshot revision must be a string.');
  }
  if (!Array.isArray(input.blocks)) {
    throw new Error('Document snapshot blocks must be an array.');
  }

  const registered = registerBlocks(input.blocks);
  const roots = [...registered.values()].filter(({ block }) => block.block_type === 1);
  if (roots.length === 0) {
    throw new Error(`Document ${input.documentId} does not contain a page root.`);
  }
  if (roots.length !== 1) {
    throw new Error(`Document ${input.documentId} contains ${roots.length} page roots.`);
  }

  const rootBlockId = requireBlockId(roots[0]!.block, 'page root');
  assertAcyclic(registered);
  const parentByBlockId = resolveParents(registered, rootBlockId);
  const orderedBlockIds = orderedTree(registered, rootBlockId);
  if (orderedBlockIds.length !== registered.size) {
    const visited = new Set(orderedBlockIds);
    const unreachable = [...registered.keys()].filter((blockId) => !visited.has(blockId));
    throw new Error(
      `Document ${input.documentId} contains blocks unreachable from page root ${rootBlockId}: ${unreachable.join(', ')}.`,
    );
  }

  const nodes = orderedBlockIds.map((blockId): SnapshotNode => {
    const entry = registered.get(blockId)!;
    const parentBlockId = parentByBlockId.get(blockId);
    const kind = kindForBlock(entry.block.block_type);
    const hashPayload = {
      blockId,
      blockType: entry.block.block_type,
      kind,
      parentBlockId: parentBlockId ?? null,
      childBlockIds: entry.childBlockIds,
      content: semanticProviderData(entry.block),
    };
    return {
      blockId,
      ...(parentBlockId ? { parentBlockId } : {}),
      childBlockIds: [...entry.childBlockIds],
      blockType: entry.block.block_type,
      kind,
      canonicalHash: canonicalHash(hashPayload),
      raw: cloneProviderBlock(entry.block),
    };
  });

  const snapshot: DocumentSnapshot = {
    documentId: input.documentId,
    revision: input.revision,
    rootBlockId,
    canonicalHash: canonicalHash({
      documentId: input.documentId,
      rootBlockId,
      nodes: nodes.map((node) => ({
        blockId: node.blockId,
        parentBlockId: node.parentBlockId ?? null,
        childBlockIds: node.childBlockIds,
        canonicalHash: node.canonicalHash,
      })),
    }),
    nodes,
  };

  return deepFreeze(snapshot);
}

function registerBlocks(blocks: ProviderBlock[]): Map<string, RegisteredBlock> {
  const registered = new Map<string, RegisteredBlock>();
  const seenObjects = new WeakSet<object>();

  const register = (value: unknown, location: string): void => {
    if (!isProviderBlock(value)) {
      throw new Error(`${location} is not a valid provider block.`);
    }
    if (seenObjects.has(value)) {
      throw new Error(`${location} reuses a provider block object.`);
    }
    seenObjects.add(value);

    const blockId = requireBlockId(value, location);
    if (registered.has(blockId)) {
      throw new Error(`Duplicate provider block ID ${blockId} at ${location}.`);
    }

    const childEntries = childReferences(value, location);
    const childBlockIds = childEntries.map((child, index) => {
      if (typeof child === 'string') {
        if (!child) throw new Error(`${location} child ${index} has an empty block ID.`);
        return child;
      }
      const childId = requireBlockId(child, `${location} embedded child ${index}`);
      register(child, `${location} embedded child ${childId}`);
      return childId;
    });
    const duplicateChildId = firstDuplicate(childBlockIds);
    if (duplicateChildId) {
      throw new Error(`${location} references child ${duplicateChildId} more than once.`);
    }

    registered.set(blockId, { block: value, childBlockIds });
  };

  blocks.forEach((block, index) => register(block, `blocks[${index}]`));
  return registered;
}

function childReferences(block: ProviderBlock, location: string): Array<string | ProviderBlock> {
  const children = relationReferences(block.children, `${location}.children`);

  if (block.block_type !== 31) return children ?? [];

  const table = asRecord(block.table);
  if (!table) throw new Error(`${location} table block does not contain a table payload.`);
  const cells = relationReferences(table.cells, `${location}.table.cells`);
  if (!children) return cells ?? [];
  if (!cells) return children;

  const childIds = children.map((child, index) => referenceBlockId(
    child,
    `${location}.children[${index}]`,
  ));
  const cellIds = cells.map((cell, index) => referenceBlockId(
    cell,
    `${location}.table.cells[${index}]`,
  ));
  if (childIds.length !== cellIds.length || childIds.some((childId, index) => childId !== cellIds[index])) {
    throw new Error(
      `${location} table children and table.cells must contain the same block IDs in the same order.`,
    );
  }

  return children.map((child, index) => reconcileEquivalentReference(
    child,
    cells[index]!,
    `${location} table cell ${childIds[index]}`,
  ));
}

function resolveParents(
  registered: Map<string, RegisteredBlock>,
  rootBlockId: string,
): Map<string, string> {
  const parentByBlockId = new Map<string, string>();
  for (const [parentBlockId, entry] of registered) {
    for (const childBlockId of entry.childBlockIds) {
      const child = registered.get(childBlockId);
      if (!child) {
        throw new Error(`Block ${parentBlockId} references missing child ${childBlockId}.`);
      }
      const currentParent = parentByBlockId.get(childBlockId);
      if (currentParent && currentParent !== parentBlockId) {
        throw new Error(
          `Block ${childBlockId} has conflicting parents ${currentParent} and ${parentBlockId}.`,
        );
      }
      parentByBlockId.set(childBlockId, parentBlockId);
    }
  }

  if (parentByBlockId.has(rootBlockId)) {
    throw new Error(`Page root ${rootBlockId} is referenced as a child.`);
  }

  for (const [blockId, { block }] of registered) {
    const declaredParent = optionalBlockId(block.parent_id, `${blockId}.parent_id`);
    const resolvedParent = parentByBlockId.get(blockId);
    if (blockId === rootBlockId) {
      if (declaredParent) throw new Error(`Page root ${rootBlockId} declares parent ${declaredParent}.`);
      continue;
    }
    if (!resolvedParent) {
      throw new Error(`Block ${blockId} is not referenced by a parent.`);
    }
    if (declaredParent && declaredParent !== resolvedParent) {
      throw new Error(
        `Block ${blockId} declares parent ${declaredParent} but is referenced by ${resolvedParent}.`,
      );
    }
  }

  return parentByBlockId;
}

function orderedTree(
  registered: Map<string, RegisteredBlock>,
  rootBlockId: string,
): string[] {
  const ordered: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();

  const visit = (blockId: string): void => {
    if (active.has(blockId)) throw new Error(`Document hierarchy contains a cycle at ${blockId}.`);
    if (visited.has(blockId)) return;
    const entry = registered.get(blockId);
    if (!entry) throw new Error(`Document hierarchy references missing block ${blockId}.`);
    active.add(blockId);
    visited.add(blockId);
    ordered.push(blockId);
    for (const childBlockId of entry.childBlockIds) visit(childBlockId);
    active.delete(blockId);
  };

  visit(rootBlockId);
  return ordered;
}

function assertAcyclic(registered: Map<string, RegisteredBlock>): void {
  const active = new Set<string>();
  const complete = new Set<string>();

  const visit = (blockId: string): void => {
    if (active.has(blockId)) throw new Error(`Document hierarchy contains a cycle at ${blockId}.`);
    if (complete.has(blockId)) return;
    const entry = registered.get(blockId);
    if (!entry) return;
    active.add(blockId);
    for (const childBlockId of entry.childBlockIds) visit(childBlockId);
    active.delete(blockId);
    complete.add(blockId);
  };

  for (const blockId of registered.keys()) visit(blockId);
}

function kindForBlock(blockType: number): SnapshotNode['kind'] {
  if (blockType === 1) return 'page';
  if (blockType === 2) return 'paragraph';
  if (blockType >= 3 && blockType <= 11) return 'heading';
  if (blockType === 12 || blockType === 13) return 'list';
  if (blockType === 14) return 'code';
  if (blockType === 19) return 'callout';
  if (blockType === 31) return 'table';
  if (blockType === 43) return 'whiteboard';
  if (blockType === 49) return 'synced_source';
  if (blockType === 50) return 'synced_reference';
  return 'opaque';
}

function semanticProviderData(block: ProviderBlock): unknown {
  const entries: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(block)) {
    const normalizedKey = key.replaceAll('_', '').toLowerCase();
    if (VOLATILE_REVISION_KEYS.has(normalizedKey)) continue;
    if (key === 'block_id' || key === 'parent_id' || key === 'children') continue;
    if (key === 'table') {
      const table = asRecord(child);
      if (table) {
        entries.push([key, Object.fromEntries(
          Object.entries(table)
            .filter(([tableKey]) => tableKey !== 'cells')
        )]);
        continue;
      }
    }
    entries.push([key, child]);
  }
  return Object.fromEntries(entries);
}

function relationReferences(
  value: unknown,
  location: string,
): Array<string | ProviderBlock> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${location} must be an array.`);
  return value.map((reference, index) => {
    if (typeof reference === 'string') {
      if (!reference) throw new Error(`${location}[${index}] has an empty block ID.`);
      return reference;
    }
    if (!isProviderBlock(reference)) {
      throw new Error(`${location}[${index}] is not a valid embedded provider block.`);
    }
    requireBlockId(reference, `${location}[${index}]`);
    return reference;
  });
}

function referenceBlockId(reference: string | ProviderBlock, location: string): string {
  return typeof reference === 'string' ? reference : requireBlockId(reference, location);
}

function reconcileEquivalentReference(
  child: string | ProviderBlock,
  cell: string | ProviderBlock,
  location: string,
): string | ProviderBlock {
  if (typeof child === 'string') return cell;
  if (typeof cell === 'string') return child;
  if (canonicalHash(child) !== canonicalHash(cell)) {
    throw new Error(`${location} has conflicting embedded provider representations.`);
  }
  return child;
}

function cloneProviderBlock(block: ProviderBlock): Record<string, unknown> {
  return structuredClone(block) as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireBlockId(block: ProviderBlock, location: string): string {
  if (typeof block.block_id !== 'string' || !block.block_id) {
    throw new Error(`${location} is missing a non-empty block_id.`);
  }
  return block.block_id;
}

function optionalBlockId(value: unknown, location: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${location} must be a string when present.`);
  return value;
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function isProviderBlock(value: unknown): value is ProviderBlock {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { block_type?: unknown }).block_type === 'number' &&
    Number.isInteger((value as { block_type: number }).block_type) &&
    (value as { block_type: number }).block_type > 0,
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
