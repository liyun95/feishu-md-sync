import { describe, expect, it } from 'vitest';
import {
  calloutToXml,
  tableToXml,
  toProviderBlock,
  toProviderTree,
  type DesiredNode,
} from '../src/index.js';

const plainStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  inline_code: false,
};

function textRun(content: string, style: Record<string, unknown> = {}) {
  return {
    text_run: {
      content,
      text_element_style: { ...plainStyle, ...style },
    },
  };
}

describe('typed Docx codec', () => {
  it('encodes title, paragraph, and heading nodes into exact provider shells', () => {
    expect(toProviderBlock({
      kind: 'title',
      content: [{ kind: 'text', text: 'Page title' }],
    })).toEqual({
      block_type: 1,
      page: { elements: [textRun('Page title')] },
    });

    expect(toProviderBlock({
      kind: 'paragraph',
      content: [{ kind: 'text', text: 'Body' }],
    })).toEqual({
      block_type: 2,
      text: {
        elements: [textRun('Body')],
        style: { align: 1 },
      },
    });

    expect(toProviderBlock({
      kind: 'heading',
      level: 4,
      content: [{ kind: 'text', text: 'Details' }],
    })).toEqual({
      block_type: 6,
      heading4: {
        elements: [textRun('Details')],
        style: { align: 1 },
      },
    });
  });

  it('preserves every supported inline style and provider-encodes links exactly once', () => {
    const expectedUrl = 'https%3A%2F%2Fexample.com%2Fdocs%3Fq%3Done%26lang%3Dzh%23part';
    const content = [
      {
        kind: 'text' as const,
        text: 'styled',
        bold: true,
        italic: true,
        underline: true,
        strike: true,
      },
      { kind: 'code' as const, text: 'curl' },
      {
        kind: 'link' as const,
        text: 'Docs',
        url: 'https://example.com/docs?q=one&lang=zh#part',
      },
    ];

    expect(toProviderBlock({ kind: 'paragraph', content })).toEqual({
      block_type: 2,
      text: {
        elements: [
          textRun('styled', {
            bold: true,
            italic: true,
            underline: true,
            strikethrough: true,
          }),
          textRun('curl', { inline_code: true }),
          textRun('Docs', { link: { url: expectedUrl } }),
        ],
        style: { align: 1 },
      },
    });

    expect(toProviderBlock({
      kind: 'paragraph',
      content: [{ kind: 'link', text: 'Docs', url: expectedUrl }],
    })).toEqual({
      block_type: 2,
      text: {
        elements: [textRun('Docs', { link: { url: expectedUrl } })],
        style: { align: 1 },
      },
    });
  });

  it('expands list items in source order and preserves recursive list hierarchy', () => {
    expect(toProviderTree([{
      kind: 'list',
      ordered: false,
      items: [
        {
          content: [{ kind: 'text', text: 'First' }],
          children: [],
        },
        {
          content: [{ kind: 'text', text: 'Second', bold: true }],
          children: [{
            kind: 'list',
            ordered: true,
            items: [
              {
                content: [{ kind: 'code', text: 'Nested one' }],
                children: [],
              },
              {
                content: [{ kind: 'text', text: 'Nested two' }],
                children: [{
                  kind: 'list',
                  ordered: false,
                  items: [{
                    content: [{ kind: 'text', text: 'Deep' }],
                    children: [],
                  }],
                }],
              },
            ],
          }],
        },
      ],
    }])).toEqual([
      {
        block_type: 12,
        bullet: { elements: [textRun('First')], style: {} },
      },
      {
        block_type: 12,
        bullet: { elements: [textRun('Second', { bold: true })], style: {} },
        children: [
          {
            block_type: 13,
            ordered: { elements: [textRun('Nested one', { inline_code: true })], style: {} },
          },
          {
            block_type: 13,
            ordered: { elements: [textRun('Nested two')], style: {} },
            children: [
              {
                block_type: 12,
                bullet: { elements: [textRun('Deep')], style: {} },
              },
            ],
          },
        ],
      },
    ]);
  });

  it('preserves paragraph continuations and nested lists as ordered list-item children', () => {
    expect(toProviderTree([{
      kind: 'list',
      ordered: false,
      items: [{
        content: [{ kind: 'text', text: 'Parent' }],
        children: [
          {
            kind: 'paragraph',
            content: [{ kind: 'text', text: 'Continuation' }],
          },
          {
            kind: 'list',
            ordered: true,
            items: [{
              content: [{ kind: 'text', text: 'Nested' }],
              children: [],
            }],
          },
        ],
      }],
    }])).toEqual([{
      block_type: 12,
      bullet: { elements: [textRun('Parent')], style: {} },
      children: [
        {
          block_type: 2,
          text: { elements: [textRun('Continuation')], style: { align: 1 } },
        },
        {
          block_type: 13,
          ordered: { elements: [textRun('Nested')], style: {} },
        },
      ],
    }]);
  });

  it('fails closed for unsupported list-item child shapes', () => {
    expect(() => toProviderTree([{
      kind: 'list',
      ordered: false,
      items: [{
        content: [{ kind: 'text', text: 'Parent' }],
        children: [{
          kind: 'heading',
          level: 2,
          content: [{ kind: 'text', text: 'Unsupported' }],
        }],
      }],
    } as unknown as DesiredNode])).toThrow('unsupported list item child node: heading');
  });

  it('encodes Code language and caption metadata and quote content', () => {
    expect(toProviderBlock({
      kind: 'code',
      language: 'python',
      text: 'print("ok")',
      caption: 'Example & output',
    })).toEqual({
      block_type: 14,
      code: {
        elements: [textRun('print("ok")')],
        style: { language: 49, caption: 'Example & output' },
      },
    });

    expect(toProviderBlock({
      kind: 'quote',
      content: [{ kind: 'text', text: 'Quoted', italic: true }],
    })).toEqual({
      block_type: 15,
      quote: {
        elements: [textRun('Quoted', { italic: true })],
        style: { align: 1 },
      },
    });
  });

  it('renders Callout presentation, escaped title, and supported body blocks as XML', () => {
    expect(calloutToXml({
      kind: 'callout',
      calloutType: 'note',
      title: 'Notes & <limits>',
      children: [
        {
          kind: 'paragraph',
          content: [{ kind: 'text', text: 'Read & remember\nthis', bold: true }],
        },
        {
          kind: 'heading',
          level: 2,
          content: [{ kind: 'text', text: 'Details' }],
        },
        {
          kind: 'list',
          ordered: false,
          items: [{
            content: [{ kind: 'text', text: 'Carefully' }],
            children: [],
          }],
        },
        {
          kind: 'quote',
          content: [{ kind: 'text', text: 'Quoted', italic: true }],
        },
      ],
    })).toBe(
      '<callout emoji="📘" background-color="light-orange" border-color="orange">' +
      '<p>Notes &amp; &lt;limits&gt;</p>' +
      '<p><b>Read &amp; remember<br/>this</b></p>' +
      '<h2>Details</h2>' +
      '<ul><li>Carefully</li></ul>' +
      '<blockquote><em>Quoted</em></blockquote>' +
      '</callout>',
    );

    expect(calloutToXml({
      kind: 'callout',
      calloutType: 'warning',
      title: 'Warning',
      children: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Stop.' }] }],
    })).toBe(
      '<callout emoji="❗" background-color="light-red" border-color="red">' +
      '<p>Warning</p><p>Stop.</p></callout>',
    );
  });

  it('refuses to misrepresent title, Callout, or table XML mutations as child blocks', () => {
    expect(() => toProviderTree([{
      kind: 'title',
      content: [{ kind: 'text', text: 'Page title' }],
    }])).toThrow('title nodes describe the page root and cannot be encoded as child blocks');

    expect(() => toProviderBlock({
      kind: 'callout',
      calloutType: 'note',
      children: [],
    })).toThrow('Callout nodes require calloutToXml and cannot be encoded as child blocks');

    expect(() => toProviderTree([{
      kind: 'callout',
      calloutType: 'note',
      children: [],
    }])).toThrow('Callout nodes require calloutToXml and cannot be encoded as child blocks');

    expect(() => toProviderTree([{
      kind: 'table',
      rows: [{
        cells: [{
          content: [
            { kind: 'paragraph', content: [{ kind: 'text', text: 'Cell' }] },
            {
              kind: 'list',
              ordered: false,
              items: [{ content: [{ kind: 'text', text: 'Child' }], children: [] }],
            },
          ],
        }],
      }],
    }])).toThrow('table nodes require tableToXml and cannot be encoded as child blocks');
  });

  it('renders escaped native table XML with recursively nested supported cell content', () => {
    const table: Extract<DesiredNode, { kind: 'table' }> = {
      kind: 'table',
      rows: [
        {
          cells: [
            { content: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Name & kind' }] }] },
            { content: [{ kind: 'paragraph', content: [{ kind: 'text', text: 'Details' }] }] },
          ],
        },
        {
          cells: [
            {
              content: [
                {
                  kind: 'paragraph',
                  content: [{ kind: 'code', text: '<model>' }],
                },
                {
                  kind: 'code',
                  language: 'python',
                  text: 'print("A&B")\nprint("<ok>")',
                  caption: 'Example "one" & two',
                },
              ],
            },
            {
              content: [
                {
                  kind: 'paragraph',
                  content: [
                    {
                      kind: 'text',
                      text: 'Use &\nreview <carefully>',
                      bold: true,
                      italic: true,
                      underline: true,
                      strike: true,
                    },
                    {
                      kind: 'link',
                      text: 'A & B',
                      url: 'https://example.com/?a=1&b="two"',
                    },
                    { kind: 'text', text: '.', underline: true, strike: true },
                  ],
                },
                {
                  kind: 'list',
                  ordered: false,
                  items: [{
                    content: [{ kind: 'text', text: 'Parent < item', italic: true }],
                    children: [{
                      kind: 'list',
                      ordered: true,
                      items: [{
                        content: [{ kind: 'text', text: 'Nested' }],
                        children: [],
                      }],
                    }],
                  }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(tableToXml(table)).toBe(
      '<table><thead><tr>' +
      '<th><p>Name &amp; kind</p></th>' +
      '<th><p>Details</p></th>' +
      '</tr></thead><tbody><tr>' +
      '<td><p><code>&lt;model&gt;</code></p>' +
      '<pre lang="python" caption="Example &quot;one&quot; &amp; two"><code>print("A&amp;B")\nprint("&lt;ok&gt;")</code></pre></td>' +
      '<td><p><b><em><del><u>Use &amp;<br/>review &lt;carefully&gt;</u></del></em></b>' +
      '<a href="https://example.com/?a=1&amp;b=&quot;two&quot;">A &amp; B</a><del><u>.</u></del></p>' +
      '<ul><li><em>Parent &lt; item</em><ol><li>Nested</li></ol></li></ul></td>' +
      '</tr></tbody></table>',
    );
  });

  it('fails closed for ambiguous or unsupported runtime shapes', () => {
    expect(() => toProviderBlock({
      kind: 'list',
      ordered: false,
      items: [
        { content: [{ kind: 'text', text: 'one' }], children: [] },
        { content: [{ kind: 'text', text: 'two' }], children: [] },
      ],
    })).toThrow('toProviderBlock requires a list with exactly one item');

    expect(() => toProviderBlock({
      kind: 'code',
      language: 'milvusql',
      text: 'SELECT 1',
    })).toThrow('unsupported Code block language: milvusql');

    expect(() => toProviderBlock({
      kind: 'callout',
      calloutType: 'custom',
      children: [],
    })).toThrow('Callout nodes require calloutToXml and cannot be encoded as child blocks');

    expect(() => calloutToXml({
      kind: 'callout',
      calloutType: 'custom',
      children: [],
    })).toThrow('unsupported Callout type: custom');

    for (const child of [
      { kind: 'code', language: 'python', text: 'print(1)' },
      { kind: 'table', rows: [{ cells: [{ content: [] }] }] },
      { kind: 'callout', calloutType: 'note', children: [] },
      { kind: 'title', content: [{ kind: 'text', text: 'Nested title' }] },
    ] as DesiredNode[]) {
      expect(() => calloutToXml({
        kind: 'callout',
        calloutType: 'note',
        children: [child],
      })).toThrow(`unsupported Callout child node: ${child.kind}`);
    }

    expect(() => toProviderBlock({
      kind: 'paragraph',
      content: [{ kind: 'link', text: 'relative', url: '../other.md' }],
    })).toThrow('provider links must use an absolute http(s) URL');

    expect(() => tableToXml({
      kind: 'table',
      rows: [{ cells: [{ content: [{ kind: 'callout', calloutType: 'note', children: [] }] }] }],
    })).toThrow('unsupported table cell node: callout');

    expect(() => toProviderTree('paragraph' as unknown as DesiredNode[])).toThrow(
      'Desired nodes must be an array',
    );
  });
});
