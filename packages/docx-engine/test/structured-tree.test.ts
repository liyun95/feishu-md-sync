import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  createDocumentSnapshot,
  createFeishuDocxEngine,
  PartialMutationError,
  prepareMutationBatch,
  type DocxTransport,
  type MutationJournal,
  type ProviderBlock,
  type VerifiedOperationEvidence,
} from '../src/index.js';
import { structuredTreeClientToken } from '../src/structured-tree.js';

const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

function textPayload(text: string) {
  return {
    elements: [{ text_run: { content: text, text_element_style: style } }],
    style: {},
  };
}

function paragraphBlock(blockId: string, text: string, parentId = 'root'): ProviderBlock {
  return {
    block_id: blockId,
    parent_id: parentId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: style } }],
      style: { align: 1 },
    },
  };
}

function list(ordered: boolean, items: Array<{ text: string; children?: ReturnType<typeof list>[] }>) {
  return {
    kind: 'list' as const,
    ordered,
    items: items.map((item) => ({
      content: [{ kind: 'text' as const, text: item.text }],
      children: item.children ?? [],
    })),
  };
}

function desiredTree() {
  return list(false, [
    {
      text: 'Root one',
      children: [list(false, [{
        text: 'Child one',
        children: [list(true, [{ text: 'Grandchild one' }])],
      }])],
    },
    { text: 'Root two', children: [list(true, [{ text: 'Child two' }])] },
  ]);
}

function linkedTree(url: string) {
  return {
    kind: 'list' as const,
    ordered: false,
    items: [{
      content: [{ kind: 'link' as const, text: 'Linked child', url }],
      children: [list(false, [{ text: 'Nested child' }])],
    }],
  };
}

function paragraph(text: string) {
  return { kind: 'paragraph' as const, content: [{ kind: 'text' as const, text }] };
}

type CreateCall = Parameters<DocxTransport['createChildren']>[0];

class TreeTransport implements DocxTransport {
  readonly documentId = 'doc-tree';
  blocks: ProviderBlock[] = [
    { block_id: 'root', block_type: 1, children: ['a', 'b'] },
    paragraphBlock('a', 'A'),
    paragraphBlock('b', 'B'),
  ];
  revision = 1;
  fetchCount = 0;
  createCount = 0;
  createCalls: CreateCall[] = [];
  events: string[] = [];
  failBeforeCreate?: number;
  throwAfterCreate?: number;
  unreadableAfterCreate?: number;
  driftAfterCreate?: number;
  driftOnFetch?: number;
  mutateResponse?: (call: number, blocks: ProviderBlock[]) => ProviderBlock[];
  providerLinkMode?: 'double-encoded' | 'normalized' | 'malformed';
  addProviderDefaultStyles = false;
  private nextId = 1;

  async resolveDocument(): Promise<{ documentId: string }> {
    return { documentId: this.documentId };
  }

  async fetchBlocks(documentId: string) {
    expect(documentId).toBe(this.documentId);
    this.fetchCount += 1;
    this.events.push(`fetch:${this.fetchCount}`);
    if (this.driftOnFetch === this.fetchCount) {
      (this.find('b').text as ReturnType<typeof textPayload>).elements[0]!.text_run.content = 'drift';
      this.revision += 1;
    }
    if (this.unreadableAfterCreate !== undefined && this.createCount >= this.unreadableAfterCreate) {
      throw new Error('provider readback unavailable');
    }
    return { revision: String(this.revision), blocks: structuredClone(this.blocks) };
  }

  async createChildren(input: CreateCall) {
    this.createCount += 1;
    this.events.push(`create:${this.createCount}`);
    this.createCalls.push(structuredClone(input));
    if (this.failBeforeCreate === this.createCount) throw new Error(`rejected create ${this.createCount}`);
    const parent = this.find(input.parentBlockId);
    const created = input.blocks.map((block) => {
      const blockId = `made-${this.nextId++}`;
      const value: ProviderBlock = {
        ...structuredClone(block),
        block_id: blockId,
        parent_id: input.parentBlockId,
      };
      if (this.providerLinkMode === 'double-encoded') rewriteProviderLinks(value, (url) => encodeURIComponent(url));
      if (this.providerLinkMode === 'normalized') rewriteProviderLinks(value, (url) => decodeURIComponent(url));
      if (this.providerLinkMode === 'malformed') rewriteProviderLinks(value, () => '%E0%A4%A');
      if (this.addProviderDefaultStyles) addProviderDefaults(value);
      this.blocks.push(value);
      return value;
    });
    const childIds = Array.isArray(parent.children) ? parent.children as string[] : [];
    childIds.splice(input.index, 0, ...created.map(({ block_id }) => block_id!));
    parent.children = childIds;
    this.revision += 1;
    if (this.driftAfterCreate === this.createCount) {
      (this.find('root').children as string[]).reverse();
      this.revision += 1;
    }
    if (this.throwAfterCreate === this.createCount) throw new Error(`response lost ${this.createCount}`);
    const returned = this.mutateResponse?.(this.createCount, structuredClone(created)) ?? created;
    return {
      blocks: structuredClone(returned),
      revision: String(this.revision),
      clientToken: input.clientToken,
    };
  }

  async replaceBlock(): Promise<never> { throw new Error('not used'); }
  async insertAfter(): Promise<never> { throw new Error('not used'); }
  async moveAfter(): Promise<never> { throw new Error('not used'); }
  async deleteBlocks(): Promise<never> { throw new Error('not used'); }
  async createDocument(): Promise<never> { throw new Error('not used'); }
  async queryWhiteboard(): Promise<never> { throw new Error('not used'); }
  async overwriteWhiteboard(): Promise<never> { throw new Error('not used'); }

  snapshot() {
    return createDocumentSnapshot({
      documentId: this.documentId,
      revision: String(this.revision),
      blocks: structuredClone(this.blocks),
    });
  }

  private find(blockId: string): ProviderBlock {
    const block = this.blocks.find(({ block_id }) => block_id === blockId);
    if (!block) throw new Error(`missing block ${blockId}`);
    return block;
  }
}

function prepared(transport: TreeTransport) {
  return prepareMutationBatch({
    snapshot: transport.snapshot(),
    idempotencyNamespace: 'structured-tree-test',
    operations: [{
      operationId: 'insert-tree',
      kind: 'insert',
      parentBlockId: 'root',
      insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b',
      desired: [desiredTree()],
    }],
  });
}

function journal(fail = false): MutationJournal & { entries: VerifiedOperationEvidence[] } {
  const entries: VerifiedOperationEvidence[] = [];
  return {
    entries,
    async recordVerified(evidence) {
      if (fail) throw new Error('journal unavailable');
      entries.push(structuredClone(evidence));
    },
  };
}

async function apply(transport: TreeTransport, mutationJournal = journal()) {
  return createFeishuDocxEngine({ transport }).apply({
    batch: prepared(transport),
    journal: mutationJournal,
  });
}

describe('verified structured provider-tree creation', () => {
  it('creates root shells first, then child and grandchild batches under returned IDs', async () => {
    const transport = new TreeTransport();
    const result = await apply(transport);

    expect(transport.createCalls.map(({ parentBlockId }) => parentBlockId)).toEqual([
      'root', 'made-1', 'made-3', 'made-2',
    ]);
    expect(transport.createCalls.map(({ index }) => index)).toEqual([1, 0, 0, 0]);
    expect(transport.createCalls.flatMap(({ blocks }) => blocks).every((block) => block.children === undefined)).toBe(true);
    expect(result.operations[0]!.createdBlockIds).toEqual([
      'made-1', 'made-2', 'made-3', 'made-4', 'made-5',
    ]);
    expect(result.finalSnapshot.nodes.find(({ blockId }) => blockId === 'root')!.childBlockIds)
      .toEqual(['a', 'made-1', 'made-2', 'b']);
  });

  it('uses stable, path-distinct tokens and verifies between every write', async () => {
    const first = new TreeTransport();
    const second = new TreeTransport();
    await apply(first);
    await apply(second);

    const firstTokens = first.createCalls.map(({ clientToken }) => clientToken);
    expect(firstTokens).toEqual(second.createCalls.map(({ clientToken }) => clientToken));
    expect(new Set(firstTokens).size).toBe(firstTokens.length);
    expect(firstTokens).toEqual([
      structuredTreeClientToken({
        batchFingerprint: prepared(new TreeTransport()).fingerprint,
        operationId: 'insert-tree', actionIndex: 0, segmentIndex: 0, path: [],
      }),
      structuredTreeClientToken({
        batchFingerprint: prepared(new TreeTransport()).fingerprint,
        operationId: 'insert-tree', actionIndex: 0, segmentIndex: 0, path: [0],
      }),
      structuredTreeClientToken({
        batchFingerprint: prepared(new TreeTransport()).fingerprint,
        operationId: 'insert-tree', actionIndex: 0, segmentIndex: 0, path: [0, 0],
      }),
      structuredTreeClientToken({
        batchFingerprint: prepared(new TreeTransport()).fingerprint,
        operationId: 'insert-tree', actionIndex: 0, segmentIndex: 0, path: [1],
      }),
    ]);
    expect(firstTokens.every((token) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
    )).toBe(true);
    expect(firstTokens.every((token) => token.length === 36)).toBe(true);
    for (let index = 0; index < first.events.length - 1; index += 1) {
      expect([first.events[index], first.events[index + 1]]).not.toEqual([
        expect.stringMatching(/^create:/), expect.stringMatching(/^create:/),
      ]);
    }
  });

  it('renders deterministic UUID v4-shaped tokens distinct by action, segment, and path', () => {
    const base = {
      batchFingerprint: 'batch', operationId: 'operation', actionIndex: 0, segmentIndex: 0, path: [0],
    };
    const tokens = [
      structuredTreeClientToken(base),
      structuredTreeClientToken({ ...base, actionIndex: 1 }),
      structuredTreeClientToken({ ...base, segmentIndex: 1 }),
      structuredTreeClientToken({ ...base, path: [1] }),
    ];
    expect(structuredTreeClientToken(base)).toBe(tokens[0]);
    expect(new Set(tokens).size).toBe(4);
    expect(tokens.every((token) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(token)
    )).toBe(true);
  });

  it('decodes a percent-encoded absolute nested-list link exactly once during readback', async () => {
    const transport = new TreeTransport();
    const desiredUrl = 'https://example.com/docs?q=a%20b';
    const batch = prepareMutationBatch({
      snapshot: transport.snapshot(),
      idempotencyNamespace: 'encoded-link-test',
      operations: [{
        operationId: 'insert-link', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b', desired: [linkedTree(desiredUrl)],
      }],
    });
    const result = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() });
    expect(result.operations[0]).toMatchObject({ operationId: 'insert-link', verified: true });
  });

  it('preserves an already-normalized absolute URL containing percent escapes', async () => {
    const transport = new TreeTransport();
    transport.providerLinkMode = 'normalized';
    const desiredUrl = 'https://example.com/a%20b';
    const batch = prepareMutationBatch({
      snapshot: transport.snapshot(),
      idempotencyNamespace: 'normalized-link-test',
      operations: [{
        operationId: 'insert-link', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b', desired: [linkedTree(desiredUrl)],
      }],
    });
    await expect(createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() })).resolves.toBeDefined();
  });

  it('fails closed instead of decoding a double-encoded provider URL twice', async () => {
    const transport = new TreeTransport();
    transport.providerLinkMode = 'double-encoded';
    const batch = prepareMutationBatch({
      snapshot: transport.snapshot(),
      idempotencyNamespace: 'double-encoded-link-test',
      operations: [{
        operationId: 'insert-link', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b',
        desired: [linkedTree('https://example.com/docs')],
      }],
    });
    const error = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() })
      .catch((cause: unknown) => cause) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence.recoveryDisposition).toBe('manual_inspection_required');
    expect(transport.createCount).toBe(1);
  });

  it('fails closed on a malformed provider link URL before descending', async () => {
    const transport = new TreeTransport();
    transport.providerLinkMode = 'malformed';
    const batch = prepareMutationBatch({
      snapshot: transport.snapshot(),
      idempotencyNamespace: 'malformed-link-test',
      operations: [{
        operationId: 'insert-link', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b',
        desired: [linkedTree('https://example.com/docs')],
      }],
    });
    const error = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() })
      .catch((cause: unknown) => cause) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence.recoveryDisposition).toBe('manual_inspection_required');
    expect(transport.createCount).toBe(1);
  });

  it('ignores documented provider-default list style fields without ignoring content', async () => {
    const transport = new TreeTransport();
    transport.addProviderDefaultStyles = true;
    await expect(apply(transport)).resolves.toBeDefined();
  });

  it.each([
    ['count', (blocks: ProviderBlock[]) => blocks.slice(0, 1)],
    ['unique IDs', (blocks: ProviderBlock[]) => blocks.map((block) => ({ ...block, block_id: 'same' }))],
    ['parent ID', (blocks: ProviderBlock[]) => blocks.map((block) => ({ ...block, parent_id: 'wrong' }))],
    ['block type', (blocks: ProviderBlock[]) => blocks.map((block) => ({ ...block, block_type: 2 }))],
    ['semantic shell', (blocks: ProviderBlock[]) => blocks.map((block) => ({ ...block, bullet: textPayload('wrong') }))],
  ])('reconciles an invalid %s response only when readback proves the exact expected batch', async (_label, mutate) => {
    const transport = new TreeTransport();
    transport.mutateResponse = (call, blocks) => call === 1 ? mutate(blocks) : blocks;
    const result = await apply(transport);
    expect(result.operations[0]!.createdBlockIds).toEqual(['made-1', 'made-2', 'made-3', 'made-4', 'made-5']);
  });

  it('blocks the next level when exact sibling order verification fails', async () => {
    const transport = new TreeTransport();
    transport.driftAfterCreate = 1;
    const error = await apply(transport).catch((cause: unknown) => cause) as PartialMutationError;

    expect(error).toBeInstanceOf(PartialMutationError);
    expect(transport.createCount).toBe(1);
    expect(error.evidence).toMatchObject({
      createdBlockIds: ['made-1', 'made-2'],
      recoveryDisposition: 'manual_inspection_required',
    });
  });

  it('refetches a no-drift gate before descending and stops on unrelated collaborator change', async () => {
    const transport = new TreeTransport();
    transport.driftOnFetch = 4;
    const error = await apply(transport).catch((cause: unknown) => cause) as PartialMutationError;

    expect(error).toBeInstanceOf(PartialMutationError);
    expect(transport.createCount).toBe(1);
    expect(error.evidence.recoveryDisposition).toBe('manual_inspection_required');
  });

  it('records an exact verified prefix as resumable when the next provider batch is rejected unchanged', async () => {
    const transport = new TreeTransport();
    transport.failBeforeCreate = 2;
    const error = await apply(transport).catch((cause: unknown) => cause) as PartialMutationError;

    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence).toMatchObject({
      failedOperation: { operationId: 'insert-tree', kind: 'provider' },
      createdBlockIds: ['made-1', 'made-2'],
      pendingOperationIds: [],
      recoveryDisposition: 'resume_possible',
    });
  });

  it('continues after an ambiguous accepted write when exact readback proves the prefix', async () => {
    const transport = new TreeTransport();
    transport.throwAfterCreate = 1;
    const result = await apply(transport);
    expect(result.operations[0]!.createdBlockIds).toEqual(['made-1', 'made-2', 'made-3', 'made-4', 'made-5']);
  });

  it('keeps ordinary insert segments before and after a structured tree in the same operation', async () => {
    const transport = new TreeTransport();
    const batch = prepareMutationBatch({
      snapshot: transport.snapshot(),
      idempotencyNamespace: 'mixed-tree-test',
      operations: [{
        operationId: 'insert-mixed', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b',
        desired: [paragraph('Before'), desiredTree(), paragraph('After')],
      }],
    });
    const result = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() });
    expect(result.finalSnapshot.nodes.find(({ blockId }) => blockId === 'root')!.childBlockIds)
      .toEqual(['a', 'made-1', 'made-2', 'made-3', 'made-7', 'b']);
    expect(result.operations[0]!.createdBlockIds)
      .toEqual(['made-1', 'made-2', 'made-3', 'made-4', 'made-5', 'made-6', 'made-7']);
  });

  it('marks an ambiguous accepted but unplanned write for manual inspection', async () => {
    const transport = new TreeTransport();
    transport.throwAfterCreate = 1;
    transport.driftAfterCreate = 1;
    const error = await apply(transport).catch((cause: unknown) => cause) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence.recoveryDisposition).toBe('manual_inspection_required');
  });

  it('preserves pending operation IDs and the latest verified prefix revision', async () => {
    const transport = new TreeTransport();
    const before = transport.snapshot();
    const batch = prepareMutationBatch({
      snapshot: before,
      idempotencyNamespace: 'pending-tree-test',
      operations: [
        {
          operationId: 'insert-tree', kind: 'insert', parentBlockId: 'root',
          insertAfterBlockId: 'a', insertBeforeBlockId: 'b', desired: [desiredTree()],
        },
        {
          operationId: 'assert-b', kind: 'assert', blockId: 'b',
          expectedHash: before.nodes.find(({ blockId }) => blockId === 'b')!.canonicalHash,
        },
      ],
    });
    transport.failBeforeCreate = 2;
    const error = await createFeishuDocxEngine({ transport }).apply({ batch, journal: journal() })
      .catch((cause: unknown) => cause) as PartialMutationError;
    expect(error.evidence).toMatchObject({
      pendingOperationIds: ['assert-b'],
      createdBlockIds: ['made-1', 'made-2'],
      lastObservedRevision: '2',
      recoveryDisposition: 'resume_possible',
    });
  });

  it('marks an unreadable ambiguous write for manual inspection', async () => {
    const transport = new TreeTransport();
    transport.throwAfterCreate = 1;
    transport.unreadableAfterCreate = 1;
    const error = await apply(transport).catch((cause: unknown) => cause) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence).toMatchObject({
      failedOperation: { operationId: 'insert-tree', kind: 'provider' },
      recoveryDisposition: 'manual_inspection_required',
      createdBlockIds: [],
    });
  });

  it('retains physical creation order and the exact final verified snapshot on journal failure', async () => {
    const transport = new TreeTransport();
    const error = await apply(transport, journal(true)).catch((cause: unknown) => cause) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(error.evidence).toMatchObject({
      failedOperation: { operationId: 'insert-tree', kind: 'journal' },
      createdBlockIds: ['made-1', 'made-2', 'made-3', 'made-4', 'made-5'],
      lastObservedRevision: String(transport.revision),
      lastObservedSnapshotHash: canonicalHash({
        documentId: transport.snapshot().documentId,
        rootBlockId: transport.snapshot().rootBlockId,
        nodes: transport.snapshot().nodes.map((node) => ({
          blockId: node.blockId,
          parentBlockId: node.parentBlockId ?? null,
          childBlockIds: node.childBlockIds,
          canonicalHash: node.canonicalHash,
        })),
      }),
      recoveryDisposition: 'resume_possible',
    });
  });
});

function rewriteProviderLinks(block: ProviderBlock, rewrite: (url: string) => string): void {
  for (const key of ['bullet', 'ordered']) {
    const payload = block[key] as { elements?: Array<{ text_run?: { text_element_style?: { link?: { url?: string } } } }> } | undefined;
    for (const element of payload?.elements ?? []) {
      const link = element.text_run?.text_element_style?.link;
      if (typeof link?.url === 'string') link.url = rewrite(link.url);
    }
  }
}

function addProviderDefaults(block: ProviderBlock): void {
  for (const key of ['bullet', 'ordered']) {
    const payload = block[key] as { style?: Record<string, unknown> } | undefined;
    if (payload) payload.style = { ...(payload.style ?? {}), align: 1, folded: false };
  }
}
