import { describe, expect, it } from 'vitest';
import { parseHtmlTable } from '../src/semantic/html-table.js';

describe('HTML table semantic parser', () => {
  it('parses multi-paragraph cells and one-level lists', () => {
    const table = parseHtmlTable(`
      <table>
        <tr><th><p>Parameter</p></th><th><p>Description</p></th><th><p>Default</p></th></tr>
        <tr>
          <td><p><code>build_algo</code></p></td>
          <td><p>Possible values:</p><ul><li><p><code>IVF_PQ</code>: Higher quality.</p></li><li><p><code>NN_DESCENT</code>: Faster.</p></li></ul></td>
          <td><p><code>IVF_PQ</code></p></td>
        </tr>
        <tr>
          <td><p><code>ef</code></p></td>
          <td><p>Accuracy trade-off.</p><p>Required for CPU adaptation.</p></td>
          <td><p><code>[top_k, int_max]</code></p></td>
        </tr>
      </table>
    `, { sectionPath: ['Index params'], kind: 'table', ordinal: 0 });

    expect(table.headers).toHaveLength(3);
    expect(table.rows.map((row) => row.key)).toEqual(['build_algo', 'ef']);
    expect(table.rows[0].cells[1].blocks[1]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: expect.any(Array)
    });
    expect(table.rows[1].cells[1].blocks).toHaveLength(2);
    expect(table.unsupported).toEqual([]);
  });

  it('parses line breaks, inline styles, and absolute links', () => {
    const table = parseHtmlTable(`
      <table>
        <tr><th>Key</th><th>Value</th></tr>
        <tr><td>link</td><td><p><b>Bold</b><br/><em>Italic</em> <a href="https://example.com/guide">Guide</a></p></td></tr>
      </table>
    `, { sectionPath: [], kind: 'table', ordinal: 0 });

    expect(table.rows[0].cells[1].blocks[0]).toMatchObject({
      kind: 'paragraph',
      inlines: [
        { kind: 'text', value: 'Bold', marks: { bold: true } },
        { kind: 'break' },
        { kind: 'text', value: 'Italic', marks: { italic: true } },
        { kind: 'text', value: ' ' },
        { kind: 'text', value: 'Guide', marks: { link: 'https://example.com/guide' } }
      ]
    });
  });

  it('reports merged cells, nested lists, relative links, and duplicate keys', () => {
    const table = parseHtmlTable(`
      <table>
        <tr><th>Key</th><th>Value</th></tr>
        <tr><td rowspan="2">same</td><td><ul><li>outer<ul><li>inner</li></ul></li></ul></td></tr>
        <tr><td>same</td><td><a href="guide.md">Guide</a></td></tr>
      </table>
    `, { sectionPath: [], kind: 'table', ordinal: 0 });

    expect(table.unsupported).toEqual(expect.arrayContaining([
      'merged cells are unsupported',
      'nested lists are unsupported',
      'relative links are unsupported',
      'duplicate row key: same'
    ]));
  });
});
