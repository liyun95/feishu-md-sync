import { describe, expect, it } from 'vitest';
import { splitMarkdownImageBlocks } from '../src/semantic/markdown-image.js';

describe('standalone Markdown images', () => {
  it('extracts a standalone local PNG and preserves surrounding Markdown', () => {
    expect(splitMarkdownImageBlocks('Intro.\n\n![CAGRA](./assets/cagra.png)\n\nOutro.')).toEqual([
      { kind: 'markdown', content: 'Intro.\n\n' },
      { kind: 'image', alt: 'CAGRA', source: './assets/cagra.png' },
      { kind: 'markdown', content: '\nOutro.' }
    ]);
  });

  it('does not extract image syntax inside a fenced code block', () => {
    const source = '```md\n![Example](./example.png)\n```';
    expect(splitMarkdownImageBlocks(source)).toEqual([{ kind: 'markdown', content: source }]);
  });

  it('marks inline prose images as non-standalone', () => {
    const source = 'See ![Diagram](./diagram.png) for details.';
    expect(splitMarkdownImageBlocks(source)).toEqual([{
      kind: 'inline-image',
      content: source,
      images: [{ alt: 'Diagram', source: './diagram.png' }]
    }]);
  });
});
