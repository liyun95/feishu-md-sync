import { describe, expect, it } from 'vitest';
import { renderCalloutXml } from '../src/callouts/callout-xml.js';
import { localSemanticDocument } from '../src/semantic/local-document.js';

describe('Callout XML rendering', () => {
  it('renders a configured note title and fixed note presentation', () => {
    expect(renderCalloutXml({
      callout: callout(`<div class="alert note">

Use load-time CPU adaptation.

</div>`),
      config: { noteTitle: '说明', warningTitle: '警告' }
    })).toBe(
      '<callout emoji="📘" background-color="light-orange" border-color="orange">' +
      '<p>说明</p><p>Use load-time CPU adaptation.</p></callout>'
    );
  });

  it('renders warnings with the supported exclamation emoji', () => {
    expect(renderCalloutXml({
      callout: callout('<div class="alert warning">\n\nDo not continue.\n\n</div>'),
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).toContain('<callout emoji="❗" background-color="light-red" border-color="red"><p>Warning</p>');
  });

  it('renders a managed Zdoc title instead of the configured presentation title', () => {
    expect(renderCalloutXml({
      callout: callout(
        '<div class="alert note" data-fms-callout-title="Billing">\n\nBody.\n\n</div>'
      ),
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).toContain('<p>Billing</p><p>Body.</p>');
  });

  it('renders headings, grouped lists, inline styles, links, and escaped text', () => {
    const xml = renderCalloutXml({
      callout: callout(`<div class="alert note">

## Limits & safety

Use **bold**, *italic*, \`code\`, and [docs](https://milvus.io?a=1&b=2).

- First
- Second

1. Ordered one
2. Ordered two

</div>`),
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    });

    expect(xml).toContain('<h2>Limits &amp; safety</h2>');
    expect(xml).toContain('<p>Use <b>bold</b>, <em>italic</em>, <code>code</code>, and <a href="https://milvus.io?a=1&amp;b=2">docs</a>.</p>');
    expect(xml).toContain('<ul><li>First</li><li>Second</li></ul>');
    expect(xml).toContain('<ol><li seq="auto">Ordered one</li><li seq="auto">Ordered two</li></ol>');
  });

  it('refuses to render unsupported Callout content', () => {
    const unsupported = callout('<div class="alert note">\n\n```python\nprint(1)\n```\n\n</div>');
    expect(() => renderCalloutXml({
      callout: unsupported,
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).toThrow('Cannot render unsupported Callout content: fenced code blocks are unsupported');
  });
});

function callout(markdown: string) {
  const node = localSemanticDocument(markdown).nodes[0];
  if (!node || node.kind !== 'callout') throw new Error('fixture did not parse as Callout');
  return node;
}
