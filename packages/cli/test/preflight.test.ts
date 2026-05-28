import { describe, expect, it } from 'vitest';
import type { FeishuBlock } from '../src/feishu/types.js';
import { assertFeishuBlocksWritable, validateFeishuBlocksForWrite } from '../src/sync/preflight.js';

describe('Feishu block preflight', () => {
  it('accepts absolute http and https link URLs', () => {
    const blocks: FeishuBlock[] = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: 'docs',
                text_element_style: { link: { url: 'https://milvus.io/docs/json-indexing.md' } }
              }
            },
            {
              text_run: {
                content: 'local service',
                text_element_style: { link: { url: 'http://localhost:3000/docs' } }
              }
            }
          ]
        }
      }
    ];

    expect(validateFeishuBlocksForWrite(blocks)).toEqual([]);
    expect(() => assertFeishuBlocksWritable(blocks)).not.toThrow();
  });

  it('rejects relative and anchor link URLs with block context', () => {
    const blocks: FeishuBlock[] = [
      {
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: 'JSON Shredding',
                text_element_style: { link: { url: './json-shredding' } }
              }
            },
            {
              text_run: {
                content: 'Compatibility reference',
                text_element_style: { link: { url: '#compatibility-reference' } }
              }
            }
          ]
        }
      }
    ];

    const issues = validateFeishuBlocksForWrite(blocks);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      blockIndex: 0,
      path: 'text.elements[0].text_run.text_element_style.link.url',
      url: './json-shredding'
    });
    expect(() => assertFeishuBlocksWritable(blocks)).toThrow(/unsupported Feishu link URL "\.\/json-shredding"/);
    expect(() => assertFeishuBlocksWritable(blocks)).toThrow(/#compatibility-reference/);
  });

  it('finds invalid links inside nested child blocks', () => {
    const blocks: FeishuBlock[] = [
      {
        block_type: 12,
        bullet: { elements: [] },
        children: [
          {
            block_type: 2,
            text: {
              elements: [
                {
                  text_run: {
                    content: 'schema',
                    text_element_style: { link: { url: '../schema.md' } }
                  }
                }
              ]
            }
          }
        ]
      }
    ];

    expect(validateFeishuBlocksForWrite(blocks)[0]).toMatchObject({
      blockIndex: 0,
      path: 'children[0].text.elements[0].text_run.text_element_style.link.url',
      url: '../schema.md'
    });
  });
});
