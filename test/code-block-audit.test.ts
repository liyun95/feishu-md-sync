import { describe, expect, it } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import { buildCodeBlockInventory } from '../src/feishu/code-blocks.js';
import { auditCodeBlockInventory } from '../src/sync/code-block-audit.js';

describe('code-block audit', () => {
  it('passes when expected languages exist in canonical order without placeholders', () => {
    const report = auditCodeBlockInventory(inventory([
      block('python-1', 'python', 1),
      block('java-1', 'java', 2),
      block('js-1', 'javascript', 3),
      block('go-1', 'go', 4),
      block('rest-1', 'restful', 5)
    ]), { expectLanguages: ['java', 'javascript', 'go', 'restful'] });

    expect(report.passed).toBe(true);
    expect(report.missingLanguages).toEqual([]);
    expect(report.orderIssues).toEqual([]);
    expect(report.placeholderIssues).toEqual([]);
  });

  it('fails when an expected language is missing', () => {
    const report = auditCodeBlockInventory(inventory([
      block('python-1', 'python', 1),
      block('go-1', 'go', 2)
    ]), { expectLanguages: ['java', 'go'] });

    expect(report.passed).toBe(false);
    expect(report.missingLanguages).toEqual([
      expect.objectContaining({ groupId: 'group-001', language: 'java' })
    ]);
  });

  it('fails when language order is not canonical', () => {
    const report = auditCodeBlockInventory(inventory([
      block('python-1', 'python', 1),
      block('go-1', 'go', 2),
      block('java-1', 'java', 3)
    ]), { expectLanguages: ['java', 'go'] });

    expect(report.passed).toBe(false);
    expect(report.orderIssues).toEqual([
      expect.objectContaining({
        groupId: 'group-001',
        languages: ['python', 'go', 'java']
      })
    ]);
  });

  it('fails on placeholders unless the language is allowed', () => {
    const failed = auditCodeBlockInventory(inventory([
      block('python-1', 'python', 1),
      block('java-1', 'java', 2, { isPlaceholder: true })
    ]), { expectLanguages: ['java'] });

    expect(failed.passed).toBe(false);
    expect(failed.placeholderIssues).toEqual([
      expect.objectContaining({ blockId: 'java-1', language: 'java' })
    ]);

    const allowed = auditCodeBlockInventory(inventory([
      block('python-1', 'python', 1),
      block('java-1', 'java', 2, { isPlaceholder: true })
    ]), { expectLanguages: ['java'], allowPlaceholders: ['java'] });

    expect(allowed.passed).toBe(true);
    expect(allowed.allowedPlaceholders).toEqual([
      expect.objectContaining({ blockId: 'java-1', language: 'java' })
    ]);
  });

  it('recognizes RESTful curl snippets stored as shell code blocks by Feishu', () => {
    const inventory = buildCodeBlockInventory('doc', [
      { block_id: 'doc', block_type: 1, children: ['heading-1', 'python-1', 'rest-1'] },
      {
        block_id: 'heading-1',
        block_type: 4,
        parent_id: 'doc',
        heading2: { elements: [{ text_run: { content: 'Define nullable' } }] }
      },
      {
        block_id: 'python-1',
        block_type: 14,
        parent_id: 'doc',
        code: {
          elements: [{ text_run: { content: 'from pymilvus import MilvusClient' } }],
          style: { language: 49 }
        }
      },
      {
        block_id: 'rest-1',
        block_type: 14,
        parent_id: 'doc',
        code: {
          elements: [{ text_run: { content: 'curl --request POST --url "$CLUSTER_ENDPOINT/v2/vectordb/collections/create"' } }],
          style: { language: 7 }
        }
      }
    ]);

    expect(inventory.groups[0]?.languages).toEqual(['python', 'restful']);
    expect(auditCodeBlockInventory(inventory, { expectLanguages: ['restful'] }).passed).toBe(true);
  });

  it('recognizes RESTful curl snippets with shell environment setup', () => {
    const inventory = buildCodeBlockInventory('doc', [
      { block_id: 'doc', block_type: 1, children: ['heading-1', 'python-1', 'rest-1'] },
      {
        block_id: 'heading-1',
        block_type: 4,
        parent_id: 'doc',
        heading2: { elements: [{ text_run: { content: 'Set default values' } }] }
      },
      {
        block_id: 'python-1',
        block_type: 14,
        parent_id: 'doc',
        code: {
          elements: [{ text_run: { content: 'from pymilvus import MilvusClient' } }],
          style: { language: 49 }
        }
      },
      {
        block_id: 'rest-1',
        block_type: 14,
        parent_id: 'doc',
        code: {
          elements: [{
            text_run: {
              content: 'export CLUSTER_ENDPOINT="http://localhost:19530"\n\ncurl --request POST --url "$CLUSTER_ENDPOINT/v2/vectordb/collections/create"'
            }
          }],
          style: { language: 7 }
        }
      }
    ]);

    expect(inventory.groups[0]?.languages).toEqual(['python', 'restful']);
    expect(auditCodeBlockInventory(inventory, { expectLanguages: ['restful'] }).passed).toBe(true);
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
      missingLanguages: [],
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
    text: options.isPlaceholder ? `// ${language}` : `${language} code`,
    isPlaceholder: options.isPlaceholder ?? false,
    heading: 'Define a nullable field in the collection schema',
    groupId: 'group-001',
    pythonAnchorBlockId: 'python-1'
  };
}
