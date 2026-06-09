import { describe, expect, it } from 'vitest';
import { applyPublishTransform } from '../src/markdown/publish-transform.js';

describe('publish transforms', () => {
  it('wraps standalone product names for both products and versioned names for Milvus only', () => {
    const source = `---
title: "JSON Indexing"
---

# JSON Indexing

Milvus supports JSON indexing. Behavior change in Milvus 3.0 should be Milvus-only.

\`Milvus\` in inline code and [Milvus link](milvus.md) are preserved.

\`\`\`python
print("Milvus")
\`\`\`
`;

    const transformed = applyPublishTransform(source, { profile: 'milvus' });

    expect(transformed).not.toContain('title:');
    expect(transformed).not.toContain('# JSON Indexing');
    expect(transformed).toContain('<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports JSON indexing.');
    expect(transformed).toContain('Behavior change in <include target="milvus">Milvus 3.0</include> should be Milvus-only.');
    expect(transformed).toContain('`Milvus` in inline code and [Milvus link](milvus.md) are preserved.');
    expect(transformed).toContain('print("Milvus")');
  });

  it('leaves content unchanged when no profile is selected', () => {
    const source = '# JSON Indexing\n\nMilvus text.\n';

    expect(applyPublishTransform(source)).toBe(source);
  });

  it('rewrites relative Markdown links with a configured base URL', () => {
    const source = [
      'See [NGRAM](ngram.md), [schema](../schema.md), [anchor](#local), [site](https://milvus.io/docs/), and [email](mailto:docs@example.com).',
      '',
      '`[code](local.md)` remains literal.',
      '',
      '```markdown',
      '[code block](local.md)',
      '```'
    ].join('\n');

    expect(applyPublishTransform(source, { linkBaseUrl: 'https://milvus.io/docs/' })).toBe([
      'See [NGRAM](https://milvus.io/docs/ngram.md), [schema](https://milvus.io/schema.md), [anchor](#local), [site](https://milvus.io/docs/), and [email](mailto:docs@example.com).',
      '',
      '`[code](local.md)` remains literal.',
      '',
      '```markdown',
      '[code block](local.md)',
      '```'
    ].join('\n'));
  });

  it('makes Milvus review draft Markdown safe for Feishu', () => {
    const source = `---
title: "Alter Collection Schema"
---

# Alter Collection Schema

## Drop fields | Milvus 3.0.x

Milvus supports schema updates. See [Storage cleanup](#storage-cleanup) and [Schema](../schema.md#schema-update).

<div class="multipleCode">
    <a href="#python">Python</a>
    <a href="#java">Java</a>
</div>

<div class="alert note">

Milvus note.

</div>

\`\`\`python
print("Milvus")
\`\`\`
`;

    const transformed = applyPublishTransform(source, {
      profile: 'milvus',
      linkBaseUrl: 'https://milvus.io/docs/',
      reviewDraft: true
    });

    expect(transformed).not.toContain('title:');
    expect(transformed).not.toContain('<div class="multipleCode">');
    expect(transformed).toContain('## Drop fields | Milvus 3.0.x');
    expect(transformed).toContain('<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports schema updates. See Storage cleanup and [Schema](https://milvus.io/docs/schema.md#schema-update).');
    expect(transformed).toContain('Note: <include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> note.');
    expect(transformed).toContain('print("Milvus")');
  });
});
