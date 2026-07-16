import { describe, expect, it } from 'vitest';
import { parseHtmlCallout } from '../src/semantic/html-callout.js';

describe('HTML Callout parsing', () => {
  it('parses supported note content into child blocks', () => {
    const callout = parseHtmlCallout(`<div class="alert note">

First paragraph with **bold**, *italic*, \`code\`, and [docs](https://milvus.io).

## Limits

- First item
- Second item

</div>`, locator());

    expect(callout).toMatchObject({
      kind: 'callout',
      calloutType: 'note',
      locator: locator(),
      unsupported: []
    });
    expect(callout.children).toEqual([
      expect.objectContaining({ ordinal: 0, blockType: 2 }),
      expect.objectContaining({ ordinal: 1, blockType: 4 }),
      expect.objectContaining({ ordinal: 2, blockType: 12 }),
      expect.objectContaining({ ordinal: 3, blockType: 12 })
    ]);
    expect(callout.children[0]?.markdown).toContain('**bold**');
    expect(callout.children[0]?.markdown).toContain('*italic*');
    expect(callout.children[0]?.markdown).toContain('`code`');
    expect(callout.children[0]?.markdown).toContain('[docs](https://milvus.io)');
  });

  it('parses warning Callouts', () => {
    expect(parseHtmlCallout(
      '<div class="warning alert">\n\nDo not continue.\n\n</div>',
      locator()
    )).toMatchObject({ calloutType: 'warning', unsupported: [] });
  });

  it('parses a Zdoc-managed Callout title', () => {
    expect(parseHtmlCallout(
      '<div class="alert note" data-fms-callout-title="Billing">\n\nBody.\n\n</div>',
      locator()
    )).toMatchObject({
      calloutType: 'note',
      titleManaged: true,
      title: { markdown: 'Billing' },
      unsupported: []
    });
  });

  it.each([
    ['fenced code blocks are unsupported', '```python\nprint(1)\n```'],
    ['tables are unsupported', '| A | B |\n|---|---|\n| 1 | 2 |'],
    ['images are unsupported', '![Diagram](./diagram.png)'],
    ['nested Callouts are unsupported', '<div class="alert note">nested</div>'],
    ['nested lists are unsupported', '- parent\n  - child'],
    ['relative links are unsupported', '[local](../local.md)'],
    ['blockquotes are unsupported', '> quoted'],
    ['checkboxes are unsupported', '- [ ] todo'],
    ['dividers are unsupported', '---']
  ])('marks %s', (reason, body) => {
    const callout = parseHtmlCallout(
      `<div class="alert warning">\n\n${body}\n\n</div>`,
      locator()
    );

    expect(callout.unsupported).toContain(reason);
  });

  it('rejects non-Callout div containers', () => {
    expect(() => parseHtmlCallout('<div class="multipleCode">body</div>', locator())).toThrow(
      'Expected a div with alert and note or warning classes.'
    );
  });
});

function locator() {
  return { sectionPath: ['Build index'], kind: 'callout' as const, ordinal: 0 };
}
