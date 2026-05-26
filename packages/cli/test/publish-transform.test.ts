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
});
