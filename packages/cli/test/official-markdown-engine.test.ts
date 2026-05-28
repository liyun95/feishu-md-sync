import { describe, expect, it, vi } from 'vitest';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { createMarkdownEngine } from '../src/markdown/engine.js';

describe('official Markdown engine', () => {
  it('uses official export in auto mode when it succeeds', async () => {
    const engine = createMarkdownEngine({
      mode: 'auto',
      official: {
        getMarkdownContent: vi.fn().mockResolvedValue('# Official\n'),
        markdownToBlocks: vi.fn()
      }
    });

    await expect(engine.exportMarkdown({ documentId: 'doc', fallbackBlocks: [] })).resolves.toMatchObject({
      markdown: '# Official\n',
      engine: 'official',
      warnings: []
    });
  });

  it('falls back to local export in auto mode when official export fails', async () => {
    const blocks = markdownToFeishuBlocks('# Local\n');
    const engine = createMarkdownEngine({
      mode: 'auto',
      official: {
        getMarkdownContent: vi.fn().mockRejectedValue(new Error('unsupported')),
        markdownToBlocks: vi.fn()
      }
    });

    const result = await engine.exportMarkdown({ documentId: 'doc', fallbackBlocks: blocks });
    expect(result.engine).toBe('local');
    expect(result.markdown).toContain('# Local');
    expect(result.warnings[0]).toContain('official Markdown export failed');
  });

  it('uses official import in auto mode when it succeeds', async () => {
    const blocks = markdownToFeishuBlocks('# Official\n');
    const engine = createMarkdownEngine({
      mode: 'auto',
      official: {
        getMarkdownContent: vi.fn(),
        markdownToBlocks: vi.fn().mockResolvedValue(blocks)
      }
    });

    await expect(engine.importMarkdown({ markdown: '# Official\n' })).resolves.toMatchObject({
      blocks,
      engine: 'official',
      warnings: []
    });
  });

  it('normalizes percent-encoded absolute links returned by official import', async () => {
    const engine = createMarkdownEngine({
      mode: 'official',
      official: {
        getMarkdownContent: vi.fn(),
        markdownToBlocks: vi.fn().mockResolvedValue([
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
        ])
      }
    });

    const result = await engine.importMarkdown({ markdown: '[Compatibility reference](https://example.com)' });
    expect(result.blocks[0].text.elements[0].text_run.text_element_style.link.url).toBe(
      'https://zilliverse.feishu.cn/docx/FGsmd1p9soQi5uxMqIccCvJpnFf#anchor'
    );
  });
});
