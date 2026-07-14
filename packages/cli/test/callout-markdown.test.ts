import { describe, expect, it } from 'vitest';
import { canonicalizeRemoteCalloutMarkdown } from '../src/callouts/callout-markdown.js';

describe('remote Callout Markdown canonicalization', () => {
  it('converts lark-cli Callout fragments to canonical Milvus HTML', () => {
    const result = canonicalizeRemoteCalloutMarkdown({
      markdown: `<callout emoji="📘">
Notes
Use load-time CPU adaptation.
</callout>`,
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    });

    expect(result).toEqual({
      markdown: `<div class="alert note">

Use load-time CPU adaptation.

</div>`,
      warnings: []
    });
  });

  it('uses configured Chinese titles and English fallbacks', () => {
    const result = canonicalizeRemoteCalloutMarkdown({
      markdown: `<callout>说明
中文正文。</callout>

<callout>Warning
English body.</callout>`,
      config: { noteTitle: '说明', warningTitle: '警告' }
    });

    expect(result.markdown).toContain('<div class="alert note">\n\n中文正文。');
    expect(result.markdown).toContain('<div class="alert warning">\n\nEnglish body.');
  });

  it('uses tracked type hints for custom titles', () => {
    const result = canonicalizeRemoteCalloutMarkdown({
      markdown: '<callout>Custom title\nBody</callout>',
      config: { noteTitle: 'Notes', warningTitle: 'Warning' },
      typeHints: ['note']
    });

    expect(result.markdown).toContain('<div class="alert note">\n\nBody');
  });

  it('fails closed when the title cannot identify the type', () => {
    expect(() => canonicalizeRemoteCalloutMarkdown({
      markdown: '<callout>Custom heading\nBody</callout>',
      config: { noteTitle: '说明', warningTitle: '警告' }
    })).toThrow('Cannot identify remote Callout type from title "Custom heading".');
  });

  it('rejects nested Callout fragments', () => {
    expect(() => canonicalizeRemoteCalloutMarkdown({
      markdown: '<callout>Notes\n<callout>Notes\nNested</callout></callout>',
      config: { noteTitle: 'Notes', warningTitle: 'Warning' }
    })).toThrow('Nested remote Callouts are unsupported.');
  });
});
