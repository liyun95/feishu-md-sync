import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createDocumentSnapshot,
  type ProviderBlock,
} from '../src/index.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/hugging-face-blocks.json', import.meta.url),
  'utf8',
)) as ProviderBlock[];

describe('createDocumentSnapshot', () => {
  it('treats a real provider page root parent_id empty string as no parent', () => {
    const snapshot = snapshotFrom([
      { block_id: 'doc', parent_id: '', block_type: 1, children: ['child'] },
      { block_id: 'child', parent_id: 'doc', block_type: 2, text: { elements: [] } },
    ]);

    expect(snapshot.rootBlockId).toBe('doc');
    expect(snapshot.nodes[0]).toMatchObject({ blockId: 'doc', childBlockIds: ['child'] });
    expect(snapshot.nodes[0]).not.toHaveProperty('parentBlockId');
  });

  it('derives direct-child parents from root references when declarations are empty or missing', () => {
    const snapshot = snapshotFrom([
      { block_id: 'doc', parent_id: '', block_type: 1, children: ['empty-parent', 'missing-parent'] },
      { block_id: 'empty-parent', parent_id: '', block_type: 2, text: { elements: [] } },
      { block_id: 'missing-parent', block_type: 2, text: { elements: [] } },
    ]);

    expect(snapshot.nodes.map(({ blockId, parentBlockId }) => ({ blockId, parentBlockId }))).toEqual([
      { blockId: 'doc', parentBlockId: undefined },
      { blockId: 'empty-parent', parentBlockId: 'doc' },
      { blockId: 'missing-parent', parentBlockId: 'doc' },
    ]);
  });

  it('still rejects a conflicting non-empty declared parent', () => {
    expect(() => snapshotFrom([
      { block_id: 'doc', parent_id: '', block_type: 1, children: ['child'] },
      { block_id: 'child', parent_id: 'different-parent', block_type: 2, text: { elements: [] } },
    ])).toThrow('Block child declares parent different-parent but is referenced by doc.');
  });

  it('normalizes referenced and embedded children into one ordered hierarchy', () => {
    const snapshot = snapshotFrom(fixture);

    expect(snapshot.rootBlockId).toBe('doc');
    expect(snapshot.nodes.map((node) => node.blockId)).toEqual([
      'doc',
      'overview-heading',
      'overview-text',
      'before-heading',
      'before-intro',
      'nested-parent',
      'nested-child',
      'parameters-heading',
      'parameters-table',
      'parameter-cell',
      'parameter-label',
      'description-cell',
      'description-label',
      'model-cell',
      'model-label',
      'model-description-cell',
      'model-description',
      'example-code',
      'note-callout',
      'callout-title',
      'callout-body',
      'architecture-board',
      'synced-source',
      'synced-code',
      'synced-reference',
      'unknown-block',
    ]);
    expect(snapshot.nodes.find((node) => node.blockId === 'nested-child')).toMatchObject({
      parentBlockId: 'nested-parent',
      kind: 'list',
    });
    expect(snapshot.nodes.find((node) => node.blockId === 'parameters-table')).toMatchObject({
      parentBlockId: 'doc',
      childBlockIds: [
        'parameter-cell',
        'description-cell',
        'model-cell',
        'model-description-cell',
      ],
      kind: 'table',
    });
  });

  it('reconciles table child IDs with embedded table.cells without duplicating identities', () => {
    const snapshot = snapshotFrom([
      { block_id: 'doc', block_type: 1, children: ['table'] },
      {
        block_id: 'table',
        block_type: 31,
        children: ['cell'],
        table: {
          cells: [{
            block_id: 'cell',
            block_type: 32,
            children: [{
              block_id: 'cell-text',
              block_type: 2,
              text: { elements: [] },
            }],
          }],
        },
      },
    ]);

    expect(snapshot.nodes.map((node) => node.blockId)).toEqual([
      'doc',
      'table',
      'cell',
      'cell-text',
    ]);
    expect(snapshot.nodes.find((node) => node.blockId === 'table')!.childBlockIds).toEqual(['cell']);
  });

  it('recognizes mutation-relevant block kinds and keeps valid unknown blocks opaque', () => {
    const kinds = new Map(snapshotFrom(fixture).nodes.map((node) => [node.blockId, node.kind]));

    for (const [blockId, kind] of [
      ['doc', 'page'],
      ['overview-heading', 'heading'],
      ['overview-text', 'paragraph'],
      ['nested-parent', 'list'],
      ['nested-child', 'list'],
      ['parameters-table', 'table'],
      ['example-code', 'code'],
      ['note-callout', 'callout'],
      ['architecture-board', 'whiteboard'],
      ['synced-source', 'synced_source'],
      ['synced-reference', 'synced_reference'],
      ['unknown-block', 'opaque'],
    ] as const) {
      expect(kinds.get(blockId)).toBe(kind);
    }
  });

  it('hashes canonical content independent of object-key order and volatile revisions', () => {
    const snapshot = snapshotFrom(fixture);
    const reordered = reverseObjectKeys(clone(fixture)) as ProviderBlock[];
    const revised = clone(fixture);
    revised[0]!.revision_id = 9001;
    revised[2]!.document_revision_id = 9001;
    const revisedSnapshot = createDocumentSnapshot({
      documentId: 'hugging-face-doc',
      revision: '9001',
      blocks: revised,
    });

    expect(snapshotFrom(reordered).canonicalHash).toBe(snapshot.canonicalHash);
    expect(revisedSnapshot.canonicalHash).toBe(snapshot.canonicalHash);
    expect(revisedSnapshot.nodes.map((node) => node.canonicalHash))
      .toEqual(snapshot.nodes.map((node) => node.canonicalHash));
  });

  it('includes stable provider resource identities in canonical hashes', () => {
    const changedToken = clone(fixture);
    const board = changedToken.find((block) => block.block_id === 'architecture-board')!;
    (board.board as { token: string }).token = 'different-whiteboard-token';

    const original = snapshotFrom(fixture);
    const changed = snapshotFrom(changedToken);

    expect(changed.nodes.find((node) => node.blockId === 'architecture-board')!.canonicalHash)
      .not.toBe(original.nodes.find((node) => node.blockId === 'architecture-board')!.canonicalHash);
    expect(changed.canonicalHash).not.toBe(original.canonicalHash);
  });

  it.each([
    ['source_document_id', 'different-source-document'],
    ['source_block_id', 'different-source-block'],
  ] as const)('includes synced-reference %s in canonical hashes', (field, value) => {
    const changedIdentity = clone(fixture);
    const reference = changedIdentity.find((block) => block.block_id === 'synced-reference')!;
    (reference.reference_synced as Record<typeof field, string>)[field] = value;

    const original = snapshotFrom(fixture);
    const changed = snapshotFrom(changedIdentity);

    expect(changed.nodes.find((node) => node.blockId === 'synced-reference')!.canonicalHash)
      .not.toBe(original.nodes.find((node) => node.blockId === 'synced-reference')!.canonicalHash);
    expect(changed.canonicalHash).not.toBe(original.canonicalHash);
  });

  it('includes source-synced element content in canonical hashes', () => {
    const changedContent = clone(fixture);
    const source = changedContent.find((block) => block.block_id === 'synced-source')!;
    const shell = source.source_synced as {
      elements: Array<{ text_run: { content: string } }>;
    };
    shell.elements[0]!.text_run.content = 'Changed synced content';

    const original = snapshotFrom(fixture);
    const changed = snapshotFrom(changedContent);

    expect(changed.nodes.find((node) => node.blockId === 'synced-source')!.canonicalHash)
      .not.toBe(original.nodes.find((node) => node.blockId === 'synced-source')!.canonicalHash);
    expect(changed.canonicalHash).not.toBe(original.canonicalHash);
  });

  it('keeps nested revision fields semantic while ignoring top-level shell revisions', () => {
    const revisionBlocks: ProviderBlock[] = [
      { block_id: 'doc', block_type: 1, children: ['opaque'] },
      {
        block_id: 'opaque',
        parent_id: 'doc',
        block_type: 48,
        revision_id: 17,
        custom: { revision: 'semantic-v1' },
      },
    ];
    const changedShellRevision = clone(revisionBlocks);
    changedShellRevision[1]!.revision_id = 9001;
    const changedSemanticRevision = clone(revisionBlocks);
    const opaque = changedSemanticRevision[1]!;
    (opaque.custom as { revision: string }).revision = 'semantic-v2';

    const original = snapshotFrom(revisionBlocks);
    const shellChanged = snapshotFrom(changedShellRevision);
    const semanticChanged = snapshotFrom(changedSemanticRevision);

    expect(shellChanged.nodes.find((node) => node.blockId === 'opaque')!.canonicalHash)
      .toBe(original.nodes.find((node) => node.blockId === 'opaque')!.canonicalHash);
    expect(shellChanged.canonicalHash).toBe(original.canonicalHash);
    expect(semanticChanged.nodes.find((node) => node.blockId === 'opaque')!.canonicalHash)
      .not.toBe(original.nodes.find((node) => node.blockId === 'opaque')!.canonicalHash);
    expect(semanticChanged.canonicalHash).not.toBe(original.canonicalHash);
  });

  it('changes the document hash for meaningful cell text and child-order changes', () => {
    const snapshot = snapshotFrom(fixture);
    const changedCellText = clone(fixture);
    textContent(changedCellText, 'model-description').content = 'Changed model description.';
    const changedOrder = clone(fixture);
    const pageChildren = changedOrder[0]!.children as string[];
    [pageChildren[0], pageChildren[1]] = [pageChildren[1]!, pageChildren[0]!];

    expect(snapshotFrom(changedCellText).canonicalHash).not.toBe(snapshot.canonicalHash);
    expect(snapshotFrom(changedOrder).canonicalHash).not.toBe(snapshot.canonicalHash);
  });

  it('deep-clones and freezes provider data so caller mutation cannot alter the snapshot', () => {
    const input = clone(fixture);
    const snapshot = snapshotFrom(input);
    const beforeRaw = snapshot.nodes.find((node) => node.blockId === 'model-description')!.raw;
    const beforeHash = snapshot.canonicalHash;

    textContent(input, 'model-description').content = 'Caller mutation.';

    expect(snapshot.nodes.find((node) => node.blockId === 'model-description')!.raw).toEqual(beforeRaw);
    expect(snapshot.canonicalHash).toBe(beforeHash);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nodes)).toBe(true);
    expect(Object.isFrozen(beforeRaw)).toBe(true);
    expect(() => {
      (beforeRaw.text as { elements: Array<{ text_run: { content: string } }> })
        .elements[0]!.text_run.content = 'Mutation through snapshot.';
    }).toThrow(TypeError);
  });

  it.each([
    ['a missing page root', [{ block_id: 'text', block_type: 2 }]],
    ['duplicate block IDs', [
      { block_id: 'doc', block_type: 1, children: ['same'] },
      { block_id: 'same', block_type: 2 },
      { block_id: 'same', block_type: 2 },
    ]],
    ['a missing referenced child', [
      { block_id: 'doc', block_type: 1, children: ['missing'] },
    ]],
    ['a conflicting parent', [
      { block_id: 'doc', block_type: 1, children: ['left', 'right'] },
      { block_id: 'left', block_type: 2, children: ['child'] },
      { block_id: 'right', block_type: 2, children: ['child'] },
      { block_id: 'child', block_type: 2 },
    ]],
    ['a cycle', [
      { block_id: 'doc', block_type: 1, children: ['parent'] },
      { block_id: 'parent', block_type: 2, children: ['child'] },
      { block_id: 'child', block_type: 2, children: ['parent'] },
    ]],
    ['an unreferenced block', [
      { block_id: 'doc', block_type: 1, children: [] },
      { block_id: 'orphan', parent_id: 'doc', block_type: 2 },
    ]],
    ['an embedded block without an identity', [
      { block_id: 'doc', block_type: 1, children: [{ block_type: 2 }] },
    ]],
    ['conflicting table cell order', [
      { block_id: 'doc', block_type: 1, children: ['table'] },
      {
        block_id: 'table',
        block_type: 31,
        children: ['cell-a', 'cell-b'],
        table: { cells: ['cell-b', 'cell-a'] },
      },
      { block_id: 'cell-a', block_type: 32 },
      { block_id: 'cell-b', block_type: 32 },
    ]],
    ['conflicting table cell membership', [
      { block_id: 'doc', block_type: 1, children: ['table'] },
      {
        block_id: 'table',
        block_type: 31,
        children: ['cell-a'],
        table: { cells: ['cell-b'] },
      },
      { block_id: 'cell-a', block_type: 32 },
      { block_id: 'cell-b', block_type: 32 },
    ]],
  ] as const)('fails closed for %s', (_description, blocks) => {
    expect(() => snapshotFrom(blocks as ProviderBlock[])).toThrow();
  });
});

function snapshotFrom(blocks: ProviderBlock[]) {
  return createDocumentSnapshot({
    documentId: 'hugging-face-doc',
    revision: '17',
    blocks,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

function textContent(blocks: ProviderBlock[], blockId: string): { content: string } {
  const block = blocks.find((candidate) => candidate.block_id === blockId);
  if (!block) throw new Error(`Fixture block ${blockId} is missing.`);
  const text = block.text as { elements: Array<{ text_run: { content: string } }> };
  return text.elements[0]!.text_run;
}
