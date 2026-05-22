import { describe, expect, it, vi } from 'vitest';
import { buildCodeBlockInventory, findTargetCodeBlocks } from '../src/feishu/code-blocks.js';
import type { FeishuBlock } from '../src/feishu/types.js';
import { buildCodeBlockUpdateRequest, updateCodeBlock } from '../src/sync/code-block-update.js';

describe('targeted code block updates', () => {
  it('finds supported placeholder code blocks and ignores cpp', () => {
    const blocks: FeishuBlock[] = [
      codeBlock('java-1', '// java', 29),
      codeBlock('node-1', '// nodejs', 30),
      codeBlock('js-1', '// js', 30),
      codeBlock('rest-1', '# restful', 7),
      codeBlock('go-1', '// go', 22),
      codeBlock('cpp-1', '// cpp', 9),
      codeBlock('other-1', 'print("already filled")', 49)
    ];

    expect(findTargetCodeBlocks(blocks)).toEqual([
      { language: 'java', blockId: 'java-1', languageId: 29, text: '// java' },
      { language: 'nodejs', blockId: 'node-1', languageId: 30, text: '// nodejs' },
      { language: 'nodejs', blockId: 'js-1', languageId: 30, text: '// js' },
      { language: 'restful', blockId: 'rest-1', languageId: 7, text: '# restful' },
      { language: 'go', blockId: 'go-1', languageId: 22, text: '// go' }
    ]);
  });

  it('builds JSON inventory grouped around Python anchors', () => {
    const blocks: FeishuBlock[] = [
      headingBlock('heading-1', 'Define a nullable field in the collection schema'),
      codeBlock('python-1', 'from pymilvus import MilvusClient', 49),
      codeBlock('go-1', '// go', 22)
    ];

    const inventory = buildCodeBlockInventory('doc', blocks);

    expect(inventory.documentId).toBe('doc');
    expect(inventory.languageOrder).toEqual(['python', 'java', 'javascript', 'go', 'restful']);
    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0]).toMatchObject({
      groupId: 'group-001',
      heading: 'Define a nullable field in the collection schema',
      pythonAnchorBlockId: 'python-1',
      parentBlockId: 'doc',
      startIndex: 1,
      endIndex: 2,
      languages: ['python', 'go'],
      missingLanguages: ['java', 'javascript', 'restful']
    });
    expect(inventory.blocks).toEqual([
      expect.objectContaining({
        blockId: 'python-1',
        parentBlockId: 'doc',
        childIndex: 1,
        documentIndex: 1,
        language: 'python',
        canonicalLanguage: 'python',
        text: 'from pymilvus import MilvusClient',
        isPlaceholder: false,
        heading: 'Define a nullable field in the collection schema',
        groupId: 'group-001',
        pythonAnchorBlockId: 'python-1'
      }),
      expect.objectContaining({
        blockId: 'go-1',
        parentBlockId: 'doc',
        childIndex: 2,
        documentIndex: 2,
        language: 'go',
        canonicalLanguage: 'go',
        text: '// go',
        isPlaceholder: true,
        heading: 'Define a nullable field in the collection schema',
        groupId: 'group-001',
        pythonAnchorBlockId: 'python-1'
      })
    ]);
    expect(inventory.groups[0].blocks).toEqual(inventory.blocks);
  });

  it('builds a single-block update request for code text', () => {
    expect(buildCodeBlockUpdateRequest('java-1', 'System.out.println("ok");', 'java')).toEqual({
      block_id: 'java-1',
      update_text_elements: {
        elements: [{
          text_run: {
            content: 'System.out.println("ok");',
            text_element_style: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              inline_code: false
            }
          }
        }]
      }
    });
  });

  it('dry-runs without calling Feishu', async () => {
    const client = { batchUpdateBlocks: vi.fn() };

    const result = await updateCodeBlock(client, {
      documentId: 'doc',
      blockId: 'java-1',
      content: 'System.out.println("ok");',
      language: 'java'
    });

    expect(result.mode).toBe('dry-run');
    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
  });

  it('writes a single batch update request when write mode is enabled', async () => {
    const client = { batchUpdateBlocks: vi.fn().mockResolvedValue([{ block_id: 'java-1', block_type: 14 }]) };

    const result = await updateCodeBlock(client, {
      documentId: 'doc',
      blockId: 'java-1',
      content: 'System.out.println("ok");',
      language: 'java',
      dryRun: false
    });

    expect(result.mode).toBe('write');
    expect(result.updatedBlocks).toEqual([{ block_id: 'java-1', block_type: 14 }]);
    expect(client.batchUpdateBlocks).toHaveBeenCalledTimes(1);
    expect(client.batchUpdateBlocks.mock.calls[0][0]).toBe('doc');
    expect(client.batchUpdateBlocks.mock.calls[0][1]).toHaveLength(1);
  });
});

function codeBlock(blockId: string, content: string, language: number): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 14,
    code: {
      elements: [{
        text_run: {
          content,
          text_element_style: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            inline_code: false
          }
        }
      }],
      style: { language }
    }
  };
}

function headingBlock(blockId: string, content: string): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 4,
    heading2: {
      elements: [{
        text_run: {
          content,
          text_element_style: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            inline_code: false
          }
        }
      }],
      style: { align: 1 }
    }
  };
}
