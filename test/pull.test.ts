import { describe, expect, it } from 'vitest';
import { feishuBlocksToMarkdown } from '../src/markdown/from-blocks.js';
import type { TextElement } from '../src/feishu/types.js';

describe('feishuBlocksToMarkdown', () => {
  it('renders headings, paragraphs, lists, code, and tables for supported blocks', () => {
    const markdown = feishuBlocksToMarkdown([
      { block_type: 3, heading1: { elements: [run('Title')], style: {} } },
      { block_type: 2, text: { elements: [run('Hello')], style: {} } },
      { block_type: 12, bullet: { elements: [run('Item')], style: {} } },
      { block_type: 13, ordered: { elements: [run('First')], style: {} } },
      { block_type: 14, code: { elements: [run('const x = 1;')], style: { language: 64 } } },
      {
        block_type: 31,
        table: {
          property: { row_size: 1, column_size: 2 },
          cells: [
            { block_type: 2, text: { elements: [run('A')], style: {} } },
            { block_type: 2, text: { elements: [run('B')], style: {} } }
          ]
        }
      }
    ]);

    expect(markdown).toContain('# Title');
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('- Item');
    expect(markdown).toContain('1. First');
    expect(markdown).toContain('```typescript\nconst x = 1;\n```');
    expect(markdown).toContain('| A | B |');
  });

  it('marks unsupported blocks instead of silently dropping them', () => {
    expect(feishuBlocksToMarkdown([{ block_type: 99 }])).toContain('unsupported Feishu block_type 99');
  });

  it('renders Feishu callout blocks as note admonitions', () => {
    const markdown = feishuBlocksToMarkdown([
      {
        block_type: 19,
        callout: { background_color: 2, border_color: 2, emoji_id: 'blue_book' },
        children: [
          { block_type: 2, text: { elements: [run('Notes')], style: {} } },
          { block_type: 2, text: { elements: [run('Behavior change', { bold: true }), run(' in '), run('AUTOINDEX', { inline_code: true })], style: {} } }
        ]
      }
    ]);

    expect(markdown).toBe(':::note\n**Behavior change** in `AUTOINDEX`\n:::\n');
  });
});

function run(content: string, style: Partial<NonNullable<TextElement['text_run']>['text_element_style']> = {}): TextElement {
  return {
    text_run: {
      content,
      text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false,
        ...style
      }
    }
  };
}
