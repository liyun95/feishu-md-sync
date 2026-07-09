import { describe, expect, it } from 'vitest';
import { applyZillizPublishTransform } from '../src/transform/zilliz-publish.js';

describe('Zilliz publish transform', () => {
  it('wraps ordinary Milvus product names in dual-product include tags', () => {
    expect(applyZillizPublishTransform('Milvus supports JSON indexing.')).toEqual({
      markdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports JSON indexing.',
      warnings: []
    });
  });

  it('wraps version-qualified Milvus sentences as Milvus-only', () => {
    expect(applyZillizPublishTransform('This option is available in Milvus 3.0 and later. Use it for new workloads.')).toEqual({
      markdown: '<include target="milvus">This option is available in Milvus 3.0 and later.</include> Use it for new workloads.',
      warnings: []
    });
  });

  it('does not rewrite code, links, or existing include tags', () => {
    const source = [
      '`Milvus` stays code.',
      '[Milvus link](milvus.md) stays link.',
      '<include target="milvus">Milvus</include> stays tagged.',
      '',
      '```',
      'Milvus 3.0 in code',
      '```'
    ].join('\n');

    expect(applyZillizPublishTransform(source).markdown).toBe(source);
  });

  it('warns on headings instead of rewriting them', () => {
    expect(applyZillizPublishTransform('# Configure Milvus\n\nMilvus stores vectors.')).toEqual({
      markdown: '# Configure Milvus\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      warnings: ['Heading contains Milvus product wording and was not rewritten: # Configure Milvus']
    });
  });
});
