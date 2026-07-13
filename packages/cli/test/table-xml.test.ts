import { describe, expect, it } from 'vitest';
import { renderTableXml } from '../src/publish/table-xml.js';
import { parseHtmlTable } from '../src/semantic/html-table.js';
import { stripExecutionMetadata } from '../src/semantic/normalize.js';
import type { SemanticCell, SemanticTable } from '../src/semantic/types.js';

describe('table XML renderer', () => {
  it('renders paragraphs, inline styles, and one-level lists', () => {
    const table = fixture();
    const xml = renderTableXml(table);

    expect(xml).toContain('<table>');
    expect(xml).toContain('<thead><tr><th><p>Parameter</p></th>');
    expect(xml).toContain('<code>build_algo</code>');
    expect(xml).toContain('<ul><li><code>IVF_PQ</code>: Higher quality.</li>');
    expect(xml).toContain('<p>Required for CPU adaptation.</p>');
    expect(xml).toContain('</tbody></table>');

    const reparsed = parseHtmlTable(xml, table.locator);
    expect(stripExecutionMetadata(reparsed)).toEqual(stripExecutionMetadata(table));
  });

  it('escapes text and link attributes', () => {
    const table = fixture();
    table.rows[0].cells[1] = {
      blocks: [{
        kind: 'paragraph',
        inlines: [{ kind: 'text', value: 'A & B < C', marks: { link: 'https://example.com/?a=1&b=2' } }]
      }]
    };

    expect(renderTableXml(table)).toContain('<a href="https://example.com/?a=1&amp;b=2">A &amp; B &lt; C</a>');
  });

  it('refuses unsupported tables', () => {
    const table = fixture();
    table.unsupported = ['nested lists are unsupported'];
    expect(() => renderTableXml(table)).toThrow('Cannot render unsupported table: nested lists are unsupported');
  });
});

function fixture(): SemanticTable {
  return {
    kind: 'table',
    locator: { sectionPath: ['Index params'], kind: 'table', ordinal: 0 },
    headers: [cell('Parameter'), cell('Description'), cell('Default')],
    rows: [
      {
        key: 'build_algo',
        cells: [
          codeCell('build_algo'),
          {
            blocks: [
              { kind: 'paragraph', inlines: [{ kind: 'text', value: 'Possible values:' }] },
              {
                kind: 'list',
                ordered: false,
                items: [
                  [{ kind: 'text', value: 'IVF_PQ', marks: { code: true } }, { kind: 'text', value: ': Higher quality.' }],
                  [{ kind: 'text', value: 'NN_DESCENT', marks: { code: true } }, { kind: 'text', value: ': Faster.' }]
                ]
              }
            ]
          },
          codeCell('IVF_PQ')
        ]
      },
      {
        key: 'ef',
        cells: [
          codeCell('ef'),
          {
            blocks: [
              { kind: 'paragraph', inlines: [{ kind: 'text', value: 'Accuracy trade-off.' }] },
              { kind: 'paragraph', inlines: [{ kind: 'text', value: 'Required for CPU adaptation.' }] }
            ]
          },
          codeCell('[top_k, int_max]')
        ]
      }
    ],
    unsupported: []
  };
}

function cell(value: string): SemanticCell {
  return { blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value }] }] };
}

function codeCell(value: string): SemanticCell {
  return { blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value, marks: { code: true } }] }] };
}
