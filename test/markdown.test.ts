import { describe, expect, it } from 'vitest';
import { markdownToFeishuBlocks, parseInlineText } from '../src/markdown/blocks.js';

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

  it('marks highlight spans with background color', () => {
    const elements = parseInlineText('Use ==review marker== here.');
    expect(elements[1].text_run).toMatchObject({
      content: 'review marker',
      text_element_style: { background_color: 5 }
    });
  });
});
