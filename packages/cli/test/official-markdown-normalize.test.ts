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

  it('normalizes known code fence languages to lowercase', () => {
    expect(normalizeOfficialMarkdownExport([
      '```Python',
      'print("keep")',
      '```',
      '',
      '```JavaScript',
      'console.log("keep");',
      '```'
    ].join('\n'))).toBe([
      '```python',
      'print("keep")',
      '```',
      '',
      '```javascript',
      'console.log("keep");',
      '```'
    ].join('\n'));
  });

  it('converts simple official HTML tables to Markdown pipe tables', () => {
    const input = [
      '<table>',
      '<tbody>',
      '<tr><td>Index type</td><td>Supported data type</td></tr>',
      '<tr><td><strong>NGRAM</strong></td><td>VARCHAR</td></tr>',
      '<tr><td>Phrase match</td><td>`error|failed`</td></tr>',
      '</tbody>',
      '</table>'
    ].join('\n');

    expect(normalizeOfficialMarkdownExport(input)).toBe([
      '| Index type | Supported data type |',
      '| --- | --- |',
      '| **NGRAM** | VARCHAR |',
      '| Phrase match | `error\\|failed` |'
    ].join('\n'));
  });
});
