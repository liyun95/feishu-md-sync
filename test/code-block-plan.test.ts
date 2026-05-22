import { describe, expect, it } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import { planCodeBlockManifest } from '../src/sync/code-block-plan.js';

describe('code-block planning', () => {
  it('creates insert actions for Python-only documents in canonical order', () => {
    const manifest = planCodeBlockManifest({
      document: 'doc-url',
      inventory: inventory([
        block('python-1', 'python', 1)
      ]),
      expectLanguages: ['java', 'javascript', 'go', 'restful']
    });

    expect(manifest.items.map((item) => `${item.action}:${item.language}`)).toEqual([
      'insert:java',
      'insert:javascript',
      'insert:go',
      'insert:restful'
    ]);
    expect(manifest.items).toEqual([
      expect.objectContaining({
        action: 'insert',
        anchorBlockId: 'python-1',
        insertAfterBlockId: 'python-1',
        parentBlockId: 'doc',
        language: 'java'
      }),
      expect.objectContaining({ action: 'insert', language: 'javascript' }),
      expect.objectContaining({ action: 'insert', language: 'go' }),
      expect.objectContaining({ action: 'insert', language: 'restful' })
    ]);
  });

  it('mixes updates for existing blocks with inserts for missing languages', () => {
    const manifest = planCodeBlockManifest({
      document: 'doc-url',
      inventory: inventory([
        block('python-1', 'python', 1),
        block('js-1', 'javascript', 2, { isPlaceholder: true }),
        block('go-1', 'go', 3)
      ]),
      expectLanguages: ['java', 'javascript', 'go', 'restful']
    });

    expect(manifest.items.map((item) => `${item.action}:${item.language}`)).toEqual([
      'insert:java',
      'update:javascript',
      'update:go',
      'insert:restful'
    ]);
    expect(manifest.items[0]).toMatchObject({
      action: 'insert',
      language: 'java',
      insertAfterBlockId: 'python-1'
    });
    expect(manifest.items[1]).toMatchObject({
      action: 'update',
      language: 'javascript',
      blockId: 'js-1'
    });
    expect(manifest.items[3]).toMatchObject({
      action: 'insert',
      language: 'restful',
      insertAfterBlockId: 'go-1'
    });
  });

  it('normalizes language aliases in expectations', () => {
    const manifest = planCodeBlockManifest({
      document: 'doc-url',
      inventory: inventory([
        block('python-1', 'python', 1)
      ]),
      expectLanguages: ['nodejs', 'rest']
    });

    expect(manifest.items.map((item) => item.language)).toEqual(['javascript', 'restful']);
  });
});

type BlockOptions = {
  isPlaceholder?: boolean;
};

function inventory(blocks: CodeBlockInventory['blocks']): CodeBlockInventory {
  return {
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    groups: [{
      groupId: 'group-001',
      heading: 'Define a nullable field in the collection schema',
      pythonAnchorBlockId: 'python-1',
      parentBlockId: 'doc',
      startIndex: 1,
      endIndex: blocks[blocks.length - 1]?.childIndex ?? 1,
      languages: blocks.map((item) => item.canonicalLanguage),
      missingLanguages: ['java', 'javascript', 'go', 'restful'].filter((language) => {
        return !blocks.some((item) => item.canonicalLanguage === language);
      }) as CodeBlockInventory['languageOrder'],
      blocks
    }],
    blocks
  };
}

function block(
  blockId: string,
  language: 'python' | 'java' | 'javascript' | 'go' | 'restful',
  childIndex: number,
  options: BlockOptions = {}
): CodeBlockInventory['blocks'][number] {
  return {
    blockId,
    parentBlockId: 'doc',
    childIndex,
    documentIndex: childIndex,
    language,
    canonicalLanguage: language,
    text: language === 'python' ? 'from pymilvus import MilvusClient' : '',
    isPlaceholder: options.isPlaceholder ?? false,
    heading: 'Define a nullable field in the collection schema',
    groupId: 'group-001',
    pythonAnchorBlockId: 'python-1'
  };
}
