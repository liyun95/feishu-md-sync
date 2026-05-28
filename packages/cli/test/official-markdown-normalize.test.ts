import { describe, expect, it } from 'vitest';
import { normalizeOfficialMarkdownExport } from '../src/markdown/official-normalize.js';

describe('normalizeOfficialMarkdownExport', () => {
  it('decodes escaped Feishu HTML entities and Markdown punctuation outside code fences', () => {
    const input = [
      'Start with `AUTOINDEX`\\. It covers text\\-match and data\\&\\#39;s cardinality\\.',
      '',
      '\\&lt;include target=\\&\\#34;milvus\\&\\#34;\\&gt;Milvus\\&lt;/include\\&gt;',
      '',
      '```python',
      'print("keep\\\\_literal")',
      '```'
    ].join('\n');

    expect(normalizeOfficialMarkdownExport(input)).toBe([
      "Start with `AUTOINDEX`. It covers text-match and data's cardinality.",
      '',
      '<include target="milvus">Milvus</include>',
      '',
      '```python',
      'print("keep\\\\_literal")',
      '```'
    ].join('\n'));
  });
});
