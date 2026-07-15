import { describe, expect, it } from 'vitest';
import { markdownToFeishuBlocks, parseInlineText } from '../src/markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../src/markdown/from-blocks.js';

describe('markdown conversion', () => {
  it('converts headings, paragraphs, lists, code blocks, and tables', () => {
    const blocks = markdownToFeishuBlocks(`# Title

Intro with ==highlight== and \`code\`.

- one
- two
1. first

\`\`\`ts
const x = 1;
\`\`\`

| Name | Value |
| ---- | ----- |
| a | b |
`);

    expect(blocks.map((block) => block.block_type)).toEqual([3, 2, 12, 12, 13, 14, 31]);
    expect((blocks[5].code as { style: { language: number } }).style.language).toBe(64);
    expect((blocks[6].table as { property: { row_size: number; column_size: number } }).property).toMatchObject({
      row_size: 2,
      column_size: 2
    });
  });

  it('does not split table cells on inline code pipes or escaped pipes', () => {
    const blocks = markdownToFeishuBlocks(`| Case | Pattern |
| ---- | ------- |
| inline code | \`error|failed\` |
| escaped pipe | ok\\|done |
`);

    const table = blocks[0].table as { property: { row_size: number; column_size: number }; cells: Array<{ text: { elements: Array<{ text_run: { content: string } }> } }> };
    expect(table.property).toMatchObject({
      row_size: 3,
      column_size: 2
    });
    expect(table.cells[3].text.elements[0].text_run.content).toBe('error|failed');
    expect(table.cells[5].text.elements[0].text_run.content).toBe('ok|done');
  });

  it('bolds Markdown table header cells by default', () => {
    const blocks = markdownToFeishuBlocks(`| Name | **Status** |
| ---- | ---------- |
| item | pass |
`);

    const table = blocks[0].table as { cells: Array<{ text: { elements: Array<{ text_run: { content: string; text_element_style: { bold: boolean } } }> } }> };
    expect(table.cells[0].text.elements[0].text_run).toMatchObject({
      content: 'Name',
      text_element_style: { bold: true }
    });
    expect(table.cells[1].text.elements[0].text_run).toMatchObject({
      content: 'Status',
      text_element_style: { bold: true }
    });
    expect(table.cells[2].text.elements[0].text_run).toMatchObject({
      content: 'item',
      text_element_style: { bold: false }
    });
  });

  it('marks highlight spans with background color', () => {
    const elements = parseInlineText('Use ==review marker== here.');
    expect(elements[1].text_run).toMatchObject({
      content: 'review marker',
      text_element_style: { background_color: 5 }
    });
  });

  it('strips heading anchors, parses italic, and nests indented list continuations', () => {
    const blocks = markdownToFeishuBlocks(`## Request Syntax{#request-syntax}

- \`collectionName(String collectionName)\` -
  The name of the target collection.

*void*
`);

    expect(blocks[0]).toMatchObject({
      block_type: 4,
      heading2: { elements: [{ text_run: { content: 'Request Syntax' } }] }
    });
    expect(blocks[1]).toMatchObject({
      block_type: 12,
      children: [
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: 'The name of the target collection.' } }] }
        }
      ]
    });
    expect(blocks[2]).toMatchObject({
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content: 'void',
              text_element_style: { italic: true }
            }
          }
        ]
      }
    });
  });

  it('nests lazy list continuations used by generated SDK reference markdown', () => {
    const blocks = markdownToFeishuBlocks(`- \`collectionName(String collectionName)\` -
The name of the target collection.
- \`databaseName(String databaseName)\` -
The name of the database.
`);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      block_type: 12,
      children: [
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: 'The name of the target collection.' } }] }
        }
      ]
    });
    expect(blocks[1]).toMatchObject({
      block_type: 12,
      children: [
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: 'The name of the database.' } }] }
        }
      ]
    });
  });

  it('renders Feishu document mentions as Markdown links', () => {
    const markdown = feishuBlocksToMarkdown([
      {
        block_type: 2,
        text: {
          elements: [
            {
              mention_doc: {
                title: 'Choose the Right Analyzer for Your Use Case',
                url: 'https://zilliverse.feishu.cn/wiki/Pulhw06e5iXJTFkidFXcGbylnod'
              }
            }
          ]
        }
      }
    ]);

    expect(markdown).toBe('[Choose the Right Analyzer for Your Use Case](https://zilliverse.feishu.cn/wiki/Pulhw06e5iXJTFkidFXcGbylnod)\n');
  });

  it('normalizes percent-encoded absolute link URLs when parsing Markdown', () => {
    const elements = parseInlineText(
      '[Compatibility reference](https%3A%2F%2Fzilliverse.feishu.cn%2Fdocx%2FFGsmd1p9soQi5uxMqIccCvJpnFf%23anchor)'
    );

    expect(elements[0].text_run?.text_element_style.link?.url).toBe(
      'https://zilliverse.feishu.cn/docx/FGsmd1p9soQi5uxMqIccCvJpnFf#anchor'
    );
  });

  it('normalizes percent-encoded absolute link URLs when rendering Markdown', () => {
    const markdown = feishuBlocksToMarkdown([
      {
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: 'Compatibility reference',
                text_element_style: {
                  link: {
                    url: 'https%3A%2F%2Fzilliverse.feishu.cn%2Fdocx%2FFGsmd1p9soQi5uxMqIccCvJpnFf%23anchor'
                  }
                }
              }
            }
          ]
        }
      }
    ]);

    expect(markdown).toBe(
      '[Compatibility reference](https://zilliverse.feishu.cn/docx/FGsmd1p9soQi5uxMqIccCvJpnFf#anchor)\n'
    );
  });

  it.each([
    ['python', 49],
    ['java', 29],
    ['javascript', 30],
    ['bash', 7],
    ['go', 22]
  ])('round-trips %s code block language', (language, languageId) => {
    const source = `\`\`\`${language}\nprint("ok")\n\`\`\`\n`;
    const blocks = markdownToFeishuBlocks(source);

    expect((blocks[0].code as { style: { language: number } }).style.language).toBe(languageId);
    expect(feishuBlocksToMarkdown(blocks)).toBe(source);
  });

  it('does not silently downgrade an unknown Code block language', () => {
    expect(() => markdownToFeishuBlocks('```milvusql\nSELECT 1;\n```\n')).toThrow(
      'unsupported Code block language: milvusql'
    );
  });
});
