import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  createDocumentSnapshot,
  createFeishuDocxEngine,
  ENGINE_SCHEMA_VERSION,
  ENGINE_VERSION,
  EngineExecutionError,
  MutationPreflightError,
  PartialMutationError,
  prepareMutationBatch,
  preparedMutationBatchFingerprint,
  providerBlocksToXml,
  toProviderBlock,
  type DocxTransport,
  type DocumentSnapshot,
  type MutationIntent,
  type MutationJournal,
  type ProviderBlock,
  type VerifiedOperationEvidence,
} from '../src/index.js';

const style = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

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

function baseBlocks(): ProviderBlock[] {
  return [
    { block_id: 'root', block_type: 1, children: ['a', 'b', 'c'] },
    paragraphBlock('a', 'A'),
    paragraphBlock('b', 'B'),
    paragraphBlock('c', 'C'),
  ];
}

function paragraph(text: string) {
  return { kind: 'paragraph' as const, content: [{ kind: 'text' as const, text }] };
}

class MemoryTransport implements DocxTransport {
  readonly documentId = 'doc-1';
  blocks = baseBlocks();
  revision = 1;
  fetchCount = 0;
  writeCount = 0;
  createIndexes: number[] = [];
  failWriteNumber?: number;
  failFetchNumber?: number;
  throwAfterWriteNumber?: number;
  failWriteCause?: unknown;
  returnMissingCreatedId = false;
  lastReplaceInput?: Parameters<DocxTransport['replaceBlock']>[0];
  driftAfterWrite = false;
  private nextId = 1;

  async resolveDocument(): Promise<{ documentId: string }> {
    return { documentId: this.documentId };
  }

  async fetchBlocks(documentId: string) {
    expect(documentId).toBe(this.documentId);
    this.fetchCount += 1;
    if (this.failFetchNumber === this.fetchCount) throw new Error(`fetch failed at ${this.fetchCount}`);
    return {
      revision: String(this.revision),
      blocks: structuredClone(this.blocks),
    };
  }

  async replaceBlock(input: Parameters<DocxTransport['replaceBlock']>[0]) {
    this.beforeWrite();
    this.lastReplaceInput = structuredClone(input);
    const target = this.find(input.blockId);
    if (input.format === 'xml') {
      if (input.content.startsWith('<pre ')) {
        target.block_type = 14;
        delete target.text;
        const language = input.content.match(/lang="([^"]+)"/)?.[1] ?? 'plaintext';
        const caption = input.content.match(/caption="([^"]+)"/)?.[1];
        const text = input.content.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? '';
        target.code = {
          elements: [{ text_run: { content: xmlUnescape(text), text_element_style: style } }],
          style: { language, ...(caption ? { caption: xmlUnescape(caption) } : {}) },
        };
        delete target.children;
      } else if (input.content.startsWith('<callout')) {
        target.block_type = 19;
        delete target.text;
        target.callout = { emoji_id: input.content.includes('❗') ? '❗' : '📘' };
        const childId = `xml-child-${this.nextId++}`;
        target.children = [childId];
        this.blocks.push(paragraphBlock(childId, xmlText(input.content), input.blockId));
      } else if (input.content.startsWith('<ul>') || input.content.startsWith('<ol>')) {
        const ordered = input.content.startsWith('<ol>');
        const items = [...input.content.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => xmlPlainText(match[1]!));
        target.block_type = ordered ? 13 : 12;
        target[ordered ? 'ordered' : 'bullet'] = textPayload(items[0] ?? '');
        delete target.text;
        const parent = this.find(target.parent_id!);
        const children = parent.children as string[];
        let offset = children.indexOf(target.block_id!) + 1;
        for (const item of items.slice(1)) {
          const blockId = `replace-${this.nextId++}`;
          this.blocks.push({
            block_id: blockId,
            parent_id: target.parent_id,
            block_type: ordered ? 13 : 12,
            [ordered ? 'ordered' : 'bullet']: textPayload(item),
          });
          children.splice(offset++, 0, blockId);
        }
      } else if (target.block_id === 'root') {
        target.block_type = 1;
        target.page = textPayload(xmlPlainText(input.content));
      } else if (/^<h[1-6]>/.test(input.content)) {
        const level = Number(input.content[2]);
        target.block_type = level + 2;
        target[`heading${level}`] = textPayload(xmlPlainText(input.content));
        delete target.text;
      } else if (input.content.startsWith('<blockquote>')) {
        target.block_type = 15;
        target.quote = textPayload(xmlPlainText(input.content));
        delete target.text;
      } else {
        target.block_type = 2;
        target.text = textPayload(xmlPlainText(input.content));
        delete target.bullet;
      }
    } else {
      const listItems = input.content.split('\n\n').filter((item) => item.startsWith('- '));
      if (listItems.length > 0) {
        target.block_type = 12;
        target.bullet = textPayload(listItems[0]!.slice(2));
        delete target.text;
        const parent = this.find(target.parent_id!);
        const children = parent.children as string[];
        let offset = children.indexOf(target.block_id!) + 1;
        for (const item of listItems.slice(1)) {
          const blockId = `replace-${this.nextId++}`;
          this.blocks.push({
            block_id: blockId,
            parent_id: target.parent_id,
            block_type: 12,
            bullet: textPayload(item.slice(2)),
          });
          children.splice(offset++, 0, blockId);
        }
      } else if (target.block_id === 'root') {
        target.block_type = 1;
        target.page = textPayload(input.content);
      } else if (/^#{1,6} /.test(input.content)) {
        const prefix = input.content.match(/^(#{1,6}) /)![1]!;
        const level = prefix.length;
        target.block_type = level + 2;
        target[`heading${level}`] = textPayload(input.content.slice(level + 1));
        delete target.text;
      } else if (input.content.startsWith('> ')) {
        target.block_type = 15;
        target.quote = textPayload(input.content.slice(2));
        delete target.text;
      } else {
        target.block_type = 2;
        target.text = textPayload(input.content);
        delete target.bullet;
      }
      delete target.callout;
      if (target.block_id !== 'root') delete target.children;
    }
    this.afterWrite();
    this.afterSuccessfulWrite();
    return { revision: String(this.revision) };
  }

  async insertAfter(input: Parameters<DocxTransport['insertAfter']>[0]) {
    this.beforeWrite();
    const parent = this.parentOf(input.blockId);
    const id = `xml-${this.nextId++}`;
    const childId = `xml-child-${this.nextId++}`;
    const block: ProviderBlock = {
      block_id: id,
      parent_id: parent.block_id,
      block_type: 19,
      children: [childId],
      callout: { emoji_id: input.content.includes('❗') ? '❗' : '📘' },
    };
    this.blocks.push(block, paragraphBlock(childId, xmlText(input.content), id));
    const children = parent.children as string[];
    children.splice(children.indexOf(input.blockId) + 1, 0, id);
    this.afterWrite();
    this.afterSuccessfulWrite();
    return { revision: String(this.revision) };
  }

  async createChildren(input: Parameters<DocxTransport['createChildren']>[0]) {
    this.beforeWrite();
    this.createIndexes.push(input.index);
    const parent = this.find(input.parentBlockId);
    const created = input.blocks.map((block) => {
      const blockId = `new-${this.nextId++}`;
      const createdBlock = {
        ...structuredClone(block),
        block_id: blockId,
        parent_id: input.parentBlockId,
      };
      this.blocks.push(createdBlock);
      return createdBlock;
    });
    (parent.children as string[]).splice(input.index, 0, ...created.map(({ block_id }) => block_id!));
    this.afterWrite();
    this.afterSuccessfulWrite();
    const returned = this.returnMissingCreatedId
      ? created.map((block, index) => ({ ...block, block_id: `missing-${index + 1}` }))
      : created;
    return { blocks: structuredClone(returned), revision: String(this.revision), clientToken: input.clientToken };
  }

  async moveAfter(input: Parameters<DocxTransport['moveAfter']>[0]) {
    this.beforeWrite();
    const parent = this.parentOf(input.blockIds[0]!);
    const children = parent.children as string[];
    const remaining = children.filter((id) => !input.blockIds.includes(id));
    const index = input.anchorBlockId === parent.block_id
      ? 0
      : remaining.indexOf(input.anchorBlockId) + 1;
    remaining.splice(index, 0, ...input.blockIds);
    parent.children = remaining;
    this.afterWrite();
    this.afterSuccessfulWrite();
  }

  async deleteBlocks(input: Parameters<DocxTransport['deleteBlocks']>[0]) {
    this.beforeWrite();
    const ids = new Set(input.blockIds);
    for (const blockId of input.blockIds) {
      const block = this.find(blockId);
      for (const child of (block.children ?? []) as string[]) ids.add(child);
    }
    this.blocks = this.blocks.filter((block) => !ids.has(block.block_id!));
    for (const block of this.blocks) {
      if (Array.isArray(block.children)) {
        block.children = block.children.filter((child) => typeof child !== 'string' || !ids.has(child));
      }
    }
    this.afterWrite();
    this.afterSuccessfulWrite();
  }

  async createDocument(): Promise<never> { throw new Error('not used'); }
  async queryWhiteboard(): Promise<never> { throw new Error('not used'); }
  async overwriteWhiteboard(): Promise<never> { throw new Error('not used'); }

  snapshot(): DocumentSnapshot {
    return createDocumentSnapshot({
      documentId: this.documentId,
      revision: String(this.revision),
      blocks: structuredClone(this.blocks),
    });
  }

  private find(blockId: string): ProviderBlock {
    const block = this.blocks.find(({ block_id }) => block_id === blockId);
    if (!block) throw new Error(`missing ${blockId}`);
    return block;
  }

  private parentOf(blockId: string): ProviderBlock {
    const block = this.find(blockId);
    return this.find(block.parent_id ?? blockId);
  }

  private beforeWrite(): void {
    this.writeCount += 1;
    if (this.failWriteNumber === this.writeCount) {
      throw this.failWriteCause ?? new Error(`provider failed at ${this.writeCount}`);
    }
  }

  private afterSuccessfulWrite(): void {
    if (this.throwAfterWriteNumber === this.writeCount) {
      throw this.failWriteCause ?? new Error(`provider response lost at ${this.writeCount}`);
    }
  }

  afterWrite(): void {
    this.revision += 1;
    if (this.driftAfterWrite) {
      this.driftAfterWrite = false;
      (this.find('root').children as string[]).push('intruder');
      this.blocks.push(paragraphBlock('intruder', 'Unplanned'));
      this.revision += 1;
    }
  }
}

function textPayload(text: string) {
  return {
    elements: [{ text_run: { content: text, text_element_style: style } }],
    style: { align: 1 },
  };
}

function xmlText(xml: string): string {
  const matches = [...xml.matchAll(/<p>(.*?)<\/p>/g)].map((match) => match[1]!.replaceAll(/<[^>]+>/g, ''));
  return matches.at(-1) ?? '';
}

function xmlUnescape(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function xmlPlainText(value: string): string {
  return xmlUnescape(value.replaceAll(/<[^>]+>/g, ''));
}

function batch(transport: MemoryTransport, operations: MutationIntent[]) {
  return prepareMutationBatch({
    snapshot: transport.snapshot(),
    operations,
    idempotencyNamespace: 'apply-test',
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

describe('createFeishuDocxEngine', () => {
  it('resolves selectors, snapshots documents, and delegates preparation', async () => {
    const transport = new MemoryTransport();
    const engine = createFeishuDocxEngine({ transport });
    const snapshot = await engine.snapshot({ kind: 'wiki', token: 'wiki-1' });
    const prepared = engine.prepare({
      snapshot,
      operations: [{ operationId: 'assert-a', kind: 'assert', blockId: 'a', expectedHash: snapshot.nodes[1]!.canonicalHash }],
      idempotencyNamespace: 'factory',
    });

    expect(snapshot.documentId).toBe('doc-1');
    expect(prepared.steps).toHaveLength(1);
    await expect(engine.assessRecovery({
      batch: prepared,
      checkpoint: { completedOperations: [], prewriteSnapshot: snapshot },
    })).rejects.toMatchObject({ code: 'recovery_not_supported' });
  });
});

describe('verified mutation execution', () => {
  it('fails stale revision and hash preflight with zero writes', async () => {
    const transport = new MemoryTransport();
    const prepared = batch(transport, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: transport.snapshot().nodes[1]!.canonicalHash, desired: paragraph('Updated'),
    }]);
    transport.revision += 1;
    const engine = createFeishuDocxEngine({ transport });

    await expect(engine.apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      code: 'stale_revision',
    });
    expect(transport.writeCount).toBe(0);

    transport.revision -= 1;
    (transport.blocks[1]!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'drift';
    await expect(engine.apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      code: 'stale_snapshot',
    });
    expect(transport.writeCount).toBe(0);
  });

  it('rejects a tampered batch before fetching or writing', async () => {
    const transport = new MemoryTransport();
    const prepared = structuredClone(batch(transport, [{
      operationId: 'assert-a', kind: 'assert', blockId: 'a',
      expectedHash: transport.snapshot().nodes[1]!.canonicalHash,
    }]));
    prepared.steps[0]!.actions = [];
    const engine = createFeishuDocxEngine({ transport });

    await expect(engine.apply({ batch: prepared, journal: journal() })).rejects.toBeInstanceOf(MutationPreflightError);
    expect(transport.writeCount).toBe(0);
  });

  it.each([
    { field: 'schemaVersion', value: ENGINE_SCHEMA_VERSION + 1, code: 'unsupported_schema_version' },
    { field: 'engineVersion', value: `${ENGINE_VERSION}-future`, code: 'unsupported_engine_version' },
  ] as const)('rejects incompatible $field before any transport call', async ({ field, value, code }) => {
    const transport = new MemoryTransport();
    const prepared = structuredClone(batch(transport, [{
      operationId: 'assert-a', kind: 'assert', blockId: 'a',
      expectedHash: transport.snapshot().nodes[1]!.canonicalHash,
    }]));
    Object.assign(prepared, { [field]: value });
    prepared.fingerprint = preparedMutationBatchFingerprint(prepared);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({ code });
    expect(transport.fetchCount).toBe(0);
    expect(transport.writeCount).toBe(0);
  });

  it('checks every prepared physical assertion before the first write', async () => {
    const transport = new MemoryTransport();
    const prepared = structuredClone(batch(transport, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: transport.snapshot().nodes[1]!.canonicalHash, desired: paragraph('Updated'),
    }]));
    const parentAssertion = prepared.steps[0]!.assertions.preflight.find(
      (assertion) => assertion.kind === 'parent-children',
    );
    if (!parentAssertion || parentAssertion.kind !== 'parent-children') throw new Error('missing assertion');
    parentAssertion.expectedChildBlockIds = ['a', 'c', 'b'];
    prepared.fingerprint = preparedMutationBatchFingerprint(prepared);

    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      code: 'preflight_assertion_failed',
      operationId: 'replace-a',
    });
    expect(transport.writeCount).toBe(0);
  });

  it('replaces an ordinary block, refetches, verifies, and journals evidence', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const prepared = batch(transport, [{
      operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
      expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated'),
    }]);
    const entries = journal();
    const outcome = await createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: entries });

    expect(outcome.operations).toEqual([expect.objectContaining({ operationId: 'replace-a', verified: true })]);
    expect(entries.entries).toEqual(outcome.operations);
    expect(transport.fetchCount).toBeGreaterThanOrEqual(2);
    expect(outcome.finalSnapshot.revision).toBe('2');
  });

  it.each(['*value*', 'a`b', '- leading', 'a & <b>\nnext'])('uses lossless XML for literal ordinary text %s', async (text) => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-literal', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph(text),
      }]),
      journal: journal(),
    });
    expect(transport.lastReplaceInput?.format).toBe('xml');
    expect(transport.lastReplaceInput?.content).toContain('<p>');
    if (text.includes('&')) expect(transport.lastReplaceInput?.content).toContain('&amp;');
    if (text.includes('<')) expect(transport.lastReplaceInput?.content).toContain('&lt;b&gt;');
  });

  it('encodes links, inline code, styles, and newlines as deterministic XML', () => {
    const xml = providerBlocksToXml([toProviderBlock({
      kind: 'paragraph',
      content: [
        { kind: 'link', text: 'Docs & API', url: 'https://example.com/a?x=1&y=2' },
        { kind: 'text', text: '\n' },
        { kind: 'code', text: 'a`b<c>' },
        { kind: 'text', text: '*literal*', bold: true, italic: true },
      ],
    })]);
    expect(xml).toBe(
      '<p><a href="https://example.com/a?x=1&amp;y=2">Docs &amp; API</a>\n' +
      '<code>a`b&lt;c&gt;</code><b><em>*literal*</em></b></p>',
    );
  });

  it.each([
    { label: 'heading', desired: { kind: 'heading' as const, level: 3 as const, content: [{ kind: 'text' as const, text: 'Heading' }] } },
    { label: 'quote', desired: { kind: 'quote' as const, content: [{ kind: 'text' as const, text: 'Quoted' }] } },
  ])('replaces an ordinary $label block', async ({ desired }) => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: `replace-${desired.kind}`, kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired,
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]!.verified).toBe(true);
  });

  it('replaces the page title without treating it as a body paragraph', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const root = before.nodes[0]!;
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-title', kind: 'replace', targetBlockId: 'root',
        expectedHash: root.canonicalHash,
        desired: { kind: 'title', content: [{ kind: 'text', text: 'New title' }] },
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]!.verified).toBe(true);
    expect(outcome.finalSnapshot.rootBlockId).toBe('root');
  });

  it('replaces XML callout content and verifies its children', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const desired = {
      kind: 'callout' as const,
      calloutType: 'note',
      children: [paragraph('Inside')],
    };
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-callout', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired,
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]).toMatchObject({ operationId: 'replace-callout', verified: true });
  });

  it('replaces Code through XML so language and caption survive readback', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const desired = {
      kind: 'code' as const,
      language: 'typescript',
      text: 'const value = "<&>";',
      caption: 'Example "one"',
    };
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-code', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired,
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]).toMatchObject({ operationId: 'replace-code', verified: true });
  });

  it('fails closed when a replace would expand one target into multiple sibling list blocks', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const desired = {
      kind: 'list' as const,
      ordered: false,
      items: [
        { content: [{ kind: 'text' as const, text: 'First' }], children: [] },
        { content: [{ kind: 'text' as const, text: 'Second' }], children: [] },
      ],
    };
    await expect(createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-list', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired,
      }]),
      journal: journal(),
    })).rejects.toMatchObject({ code: 'unsupported_action' });
    expect(transport.writeCount).toBe(0);
  });

  it('inserts simple provider blocks and reports exact created IDs', async () => {
    const transport = new MemoryTransport();
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
        insertBeforeBlockId: 'b', desired: [paragraph('One'), paragraph('Two')],
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]!.createdBlockIds).toEqual(['new-1', 'new-2']);
    expect(outcome.finalSnapshot.nodes[0]!.childBlockIds).toEqual(['a', 'new-1', 'new-2', 'b', 'c']);
  });

  it('inserts an ordinary XML callout segment and records descendant IDs', async () => {
    const transport = new MemoryTransport();
    const desired = {
      kind: 'callout' as const,
      calloutType: 'warning',
      children: [paragraph('Careful')],
    };
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'insert-callout', kind: 'insert', parentBlockId: 'root',
        insertAfterBlockId: 'a', insertBeforeBlockId: 'b', desired: [desired],
      }]),
      journal: journal(),
    });
    expect(outcome.operations[0]!.createdBlockIds).toEqual(['xml-1', 'xml-child-2']);
    expect(outcome.finalSnapshot.nodes[0]!.childBlockIds).toEqual(['a', 'xml-1', 'b', 'c']);
  });

  it('deletes, moves, and verifies assert-only operations with one readback per operation', async () => {
    const assertTransport = new MemoryTransport();
    const assertBefore = assertTransport.snapshot();
    const assertOutcome = await createFeishuDocxEngine({ transport: assertTransport }).apply({
      batch: batch(assertTransport, [{
        operationId: 'assert-a', kind: 'assert', blockId: 'a',
        expectedHash: assertBefore.nodes.find(({ blockId }) => blockId === 'a')!.canonicalHash,
      }]),
      journal: journal(),
    });
    expect(assertOutcome.operations[0]!.operationId).toBe('assert-a');

    const moveTransport = new MemoryTransport();
    const moveOutcome = await createFeishuDocxEngine({ transport: moveTransport }).apply({
      batch: batch(moveTransport, [{
        operationId: 'move-c', kind: 'move', parentBlockId: 'root', blockIds: ['c'], insertAfterBlockId: 'a',
      }]),
      journal: journal(),
    });
    expect(moveOutcome.finalSnapshot.nodes[0]!.childBlockIds).toEqual(['a', 'c', 'b']);

    const deleteTransport = new MemoryTransport();
    const deleteBefore = deleteTransport.snapshot();
    const deleteOutcome = await createFeishuDocxEngine({ transport: deleteTransport }).apply({
      batch: batch(deleteTransport, [{
        operationId: 'delete-b', kind: 'delete', parentBlockId: 'root', blockIds: ['b'],
        expectedHashes: [deleteBefore.nodes.find(({ blockId }) => blockId === 'b')!.canonicalHash],
      }]),
      journal: journal(),
    });
    expect(deleteOutcome.finalSnapshot.nodes[0]!.childBlockIds).toEqual(['a', 'c']);
    expect(assertTransport.fetchCount).toBeGreaterThanOrEqual(3);
  });

  it('executes legitimate sequential operations on the same parent against the last verified snapshot', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const b = before.nodes.find(({ blockId }) => blockId === 'b')!;
    const prepared = batch(transport, [
      { operationId: 'move-c', kind: 'move', parentBlockId: 'root', blockIds: ['c'], insertAfterBlockId: 'a' },
      { operationId: 'delete-b', kind: 'delete', parentBlockId: 'root', blockIds: ['b'], expectedHashes: [b.canonicalHash] },
    ]);
    const outcome = await createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() });
    expect(outcome.operations.map(({ operationId }) => operationId)).toEqual(['move-c', 'delete-b']);
    expect(outcome.finalSnapshot.nodes[0]!.childBlockIds).toEqual(['a', 'c']);
    expect(transport.writeCount).toBe(2);
  });

  it('detects unplanned remote drift after a write as partial mutation', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    transport.driftAfterWrite = true;
    await expect(createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('Updated'),
      }]),
      journal: journal(),
    })).rejects.toMatchObject({
      name: 'PartialMutationError',
      evidence: {
        failedOperation: { operationId: 'replace-a', kind: 'verification' },
        completedOperations: [],
        pendingOperationIds: [],
        recoveryDisposition: 'manual_inspection_required',
      },
    });
  });

  it('refetches before every operation and blocks collaborator drift during journal persistence', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const a = before.nodes.find(({ blockId }) => blockId === 'a')!;
    const b = before.nodes.find(({ blockId }) => blockId === 'b')!;
    const prepared = batch(transport, [
      { operationId: 'replace-a', kind: 'replace', targetBlockId: 'a', expectedHash: a.canonicalHash, desired: paragraph('A2') },
      { operationId: 'replace-b', kind: 'replace', targetBlockId: 'b', expectedHash: b.canonicalHash, desired: paragraph('B2') },
    ]);
    let journalCalls = 0;
    const driftJournal: MutationJournal = {
      async recordVerified() {
        journalCalls += 1;
        if (journalCalls === 1) {
          (transport.blocks.find(({ block_id }) => block_id === 'c')!.text as { elements: Array<{ text_run: { content: string } }> }).elements[0]!.text_run.content = 'collaborator';
          transport.revision += 1;
        }
      },
    };
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: driftJournal })).rejects.toMatchObject({
      evidence: {
        completedOperations: [expect.objectContaining({ operationId: 'replace-a' })],
        failedOperation: { operationId: 'replace-b', kind: 'preflight' },
        pendingOperationIds: [],
      },
    });
    expect(transport.writeCount).toBe(1);
  });

  it('rejects an unaffected sibling reorder outside the exact replace structure', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const originalAfterWrite = transport.afterWrite.bind(transport);
    transport.afterWrite = () => {
      originalAfterWrite();
      (transport.blocks[0]!.children as string[]) = ['a', 'c', 'b'];
      transport.revision += 1;
    };
    await expect(createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: journal(),
    })).rejects.toMatchObject({
      evidence: { failedOperation: { operationId: 'replace-a', kind: 'verification' } },
    });
  });

  it('maps provider failure after a verified prefix with exact pending IDs', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const a = before.nodes.find(({ blockId }) => blockId === 'a')!;
    const b = before.nodes.find(({ blockId }) => blockId === 'b')!;
    transport.failWriteNumber = 2;
    const prepared = batch(transport, [
      { operationId: 'replace-a', kind: 'replace', targetBlockId: 'a', expectedHash: a.canonicalHash, desired: paragraph('A2') },
      { operationId: 'replace-b', kind: 'replace', targetBlockId: 'b', expectedHash: b.canonicalHash, desired: paragraph('B2') },
      { operationId: 'assert-c', kind: 'assert', blockId: 'c', expectedHash: before.nodes.find(({ blockId }) => blockId === 'c')!.canonicalHash },
    ]);

    try {
      await createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PartialMutationError);
      const partial = error as PartialMutationError;
      expect(partial.evidence.completedOperations.map(({ operationId }) => operationId)).toEqual(['replace-a']);
      expect(partial.evidence.failedOperation.operationId).toBe('replace-b');
      expect(partial.evidence.pendingOperationIds).toEqual(['assert-c']);
    }
  });

  it('keeps a provider failure before the first successful write non-partial', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    transport.failWriteNumber = 1;
    const error = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: journal(),
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EngineExecutionError);
    expect(error).not.toBeInstanceOf(PartialMutationError);
    expect(error).toMatchObject({ code: 'provider_failure', operationId: 'replace-a' });
  });

  it('reconciles an accepted write whose provider response is lost', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    transport.throwAfterWriteNumber = 1;
    const entries = journal();
    const outcome = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: entries,
    });
    expect(outcome.operations).toEqual([expect.objectContaining({ operationId: 'replace-a', verified: true })]);
    expect(entries.entries).toHaveLength(1);
  });

  it('treats a rejected unchanged first write as a normal execution error', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    transport.failWriteNumber = 1;
    const error = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: journal(),
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EngineExecutionError);
    expect(error).not.toBeInstanceOf(PartialMutationError);
  });

  it('fails ambiguous and unreadable first writes as manual partial mutations', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    transport.throwAfterWriteNumber = 1;
    transport.failFetchNumber = 3;
    await expect(createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: journal(),
    })).rejects.toMatchObject({
      evidence: {
        failedOperation: { operationId: 'replace-a', kind: 'provider' },
        recoveryDisposition: 'manual_inspection_required',
      },
    });
  });

  it('maps journal failure after verified write and preserves created IDs', async () => {
    const transport = new MemoryTransport();
    const prepared = batch(transport, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('Created')],
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal(true) })).rejects.toMatchObject({
      evidence: {
        failedOperation: { operationId: 'insert', kind: 'journal' },
        pendingOperationIds: [],
        createdBlockIds: ['new-1'],
      },
    });
  });

  it('preserves partial progress when a multi-segment insert fails after its first write', async () => {
    const transport = new MemoryTransport();
    transport.failWriteNumber = 2;
    const prepared = batch(transport, [{
      operationId: 'insert-two', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('One'), paragraph('Two')],
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      evidence: {
        failedOperation: { operationId: 'insert-two', kind: 'provider' },
        createdBlockIds: ['new-1'],
        pendingOperationIds: [],
      },
    });
  });

  it('verifies each insert segment prefix before issuing the next provider call', async () => {
    const transport = new MemoryTransport();
    const originalAfterWrite = transport.afterWrite.bind(transport);
    transport.afterWrite = () => {
      originalAfterWrite();
      if (transport.writeCount === 1) {
        (transport.blocks[0]!.children as string[]) = ['a', 'new-1', 'c', 'b'];
        transport.revision += 1;
      }
    };
    const prepared = batch(transport, [{
      operationId: 'insert-two', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('One'), paragraph('Two')],
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      evidence: {
        failedOperation: { operationId: 'insert-two', kind: 'verification' },
        createdBlockIds: ['new-1'],
        pendingOperationIds: [],
      },
    });
    expect(transport.createIndexes).toEqual([1]);
    expect(transport.writeCount).toBe(1);
  });

  it('maps a post-write internal refetch failure to partial verification evidence', async () => {
    const transport = new MemoryTransport();
    transport.failFetchNumber = 3;
    const prepared = batch(transport, [{
      operationId: 'insert-one', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('One')],
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      evidence: {
        failedOperation: { operationId: 'insert-one', kind: 'verification' },
        createdBlockIds: ['new-1'],
        lastObservedRevision: '2',
      },
    });
  });

  it('rejects a missing returned insert anchor before a second index-zero write', async () => {
    const transport = new MemoryTransport();
    transport.returnMissingCreatedId = true;
    const prepared = batch(transport, [{
      operationId: 'insert-two', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('One'), paragraph('Two')],
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toBeInstanceOf(PartialMutationError);
    expect(transport.createIndexes).toEqual([1]);
  });

  it('sanitizes cyclic provider causes without freezing caller-owned errors', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const cause = new Error('cyclic provider error') as Error & { details?: unknown };
    const details: { self?: unknown; code: string } = { code: 'E_CYCLE' };
    details.self = details;
    cause.details = details;
    transport.failWriteCause = cause;
    transport.throwAfterWriteNumber = 1;
    transport.failFetchNumber = 3;
    const error = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [{
        operationId: 'replace-a', kind: 'replace', targetBlockId: 'a',
        expectedHash: before.nodes[1]!.canonicalHash, desired: paragraph('A2'),
      }]),
      journal: journal(),
    }).catch((value: unknown) => value) as PartialMutationError;
    expect(error).toBeInstanceOf(PartialMutationError);
    expect(Object.isFrozen(cause)).toBe(false);
    expect(Object.isFrozen(details)).toBe(false);
    expect(() => JSON.stringify(error.evidence.failedOperation.cause)).not.toThrow();
  });

  it('keeps an assert-only prefix plus safe unchanged provider rejection non-partial', async () => {
    const transport = new MemoryTransport();
    const before = transport.snapshot();
    const a = before.nodes.find(({ blockId }) => blockId === 'a')!;
    const b = before.nodes.find(({ blockId }) => blockId === 'b')!;
    transport.failWriteNumber = 1;
    const entries = journal();
    const error = await createFeishuDocxEngine({ transport }).apply({
      batch: batch(transport, [
        { operationId: 'assert-a', kind: 'assert', blockId: 'a', expectedHash: a.canonicalHash },
        { operationId: 'replace-b', kind: 'replace', targetBlockId: 'b', expectedHash: b.canonicalHash, desired: paragraph('B2') },
      ]),
      journal: entries,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EngineExecutionError);
    expect(error).not.toBeInstanceOf(PartialMutationError);
    expect(error).toMatchObject({ code: 'provider_failure', operationId: 'replace-b' });
    expect(entries.entries.map(({ operationId }) => operationId)).toEqual(['assert-a']);
  });

  it('fails closed on native tables and Whiteboards before writing', async () => {
    const cases: MutationIntent[] = [
      {
        operationId: 'table', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
        desired: [{ kind: 'table', rows: [{ cells: [{ content: [paragraph('cell')] }] }] }],
      },
    ];
    for (const operation of cases) {
      const transport = new MemoryTransport();
      const prepared = batch(transport, [operation]);
      await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
        code: 'unsupported_action',
      });
      expect(transport.writeCount).toBe(0);
    }

    const transport = new MemoryTransport();
    (transport.blocks[0]!.children as string[]).push('board');
    transport.blocks.push({
      block_id: 'board', parent_id: 'root', block_type: 43,
      board: { token: 'board-token' },
    });
    const board = transport.snapshot().nodes.find(({ blockId }) => blockId === 'board')!;
    const prepared = batch(transport, [{
      operationId: 'board', kind: 'whiteboard-overwrite', targetBlockId: 'board',
      expectedTargetHash: board.canonicalHash, desired: { kind: 'svg', value: '<svg />' },
    }]);
    await expect(createFeishuDocxEngine({ transport }).apply({ batch: prepared, journal: journal() })).rejects.toMatchObject({
      code: 'unsupported_action', operationId: 'board',
    });
    expect(transport.writeCount).toBe(0);
  });

  it('does not mutate caller input or the prepared batch', async () => {
    const transport = new MemoryTransport();
    const prepared = batch(transport, [{
      operationId: 'insert', kind: 'insert', parentBlockId: 'root', insertAfterBlockId: 'a',
      insertBeforeBlockId: 'b', desired: [paragraph('Immutable')],
    }]);
    const before = canonicalHash(prepared);
    const input = { batch: prepared, journal: journal() };
    await createFeishuDocxEngine({ transport }).apply(input);
    expect(canonicalHash(prepared)).toBe(before);
    expect(input.batch).toBe(prepared);
  });
});
