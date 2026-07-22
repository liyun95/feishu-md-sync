import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { FeishuBlock } from '../src/feishu/types.js';
import { remoteSemanticDocument } from '../src/semantic/remote-document.js';
import { stripExecutionMetadata } from '../src/semantic/normalize.js';

describe('remote semantic document', () => {
  it('builds section-aware tables with multi-block cells', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'doc_token', block_type: 1, children: ['h1', 'h2', 'h3', 'table1'] },
      heading('h1', 3, 'GPU CAGRA'),
      heading('h2', 4, 'Index params'),
      heading('h3', 5, 'Index-specific search params'),
      {
        block_id: 'table1',
        block_type: 31,
        table: {
          property: { row_size: 2, column_size: 2 },
          cells: ['c1', 'c2', 'c3', 'c4']
        }
      },
      { block_id: 'c1', block_type: 32, children: ['c1p'] },
      text('c1p', 'Parameter'),
      { block_id: 'c2', block_type: 32, children: ['c2p'] },
      text('c2p', 'Description'),
      { block_id: 'c3', block_type: 32, children: ['c3p'] },
      text('c3p', 'build_algo', { inline_code: true }),
      { block_id: 'c4', block_type: 32, children: ['c4p', 'c4b1', 'c4b2'] },
      text('c4p', 'Possible values:'),
      bullet('c4b1', 'IVF_PQ: Higher quality.'),
      bullet('c4b2', 'NN_DESCENT: Faster.')
    ];

    const document = remoteSemanticDocument(blocks, 'doc_token');
    const table = document.nodes.find((node) => node.kind === 'table');

    expect(table).toMatchObject({
      locator: {
        sectionPath: ['GPU CAGRA', 'Index params', 'Index-specific search params'],
        kind: 'table',
        ordinal: 0
      },
      remoteBlockId: 'table1',
      rows: [{ key: 'build_algo' }],
      unsupported: []
    });
    expect(table?.kind === 'table' ? table.rows[0].cells[1].blocks : []).toEqual([
      expect.objectContaining({ kind: 'paragraph' }),
      expect.objectContaining({ kind: 'list', ordered: false, items: expect.any(Array) })
    ]);
  });

  it('accepts Feishu merge metadata for ordinary unmerged cells', () => {
    const document = remoteSemanticDocument(tableBlocks([
      { row_span: 1, col_span: 1 },
      { row_span: 1, col_span: 1 },
      { row_span: 1, col_span: 1 },
      { row_span: 1, col_span: 1 }
    ]), 'doc_token');
    const table = document.nodes.find((node) => node.kind === 'table');

    expect(table?.kind === 'table' ? table.unsupported : []).toEqual([]);
  });

  it('compacts skipped heading levels in table locators', () => {
    const blocks = tableBlocks([]);
    blocks[0].children = ['h2', 'table1'];
    blocks.splice(1, 0, heading('h2', 4, 'Index params'));

    const document = remoteSemanticDocument(blocks, 'doc_token');
    const table = document.nodes.find((node) => node.kind === 'table');

    expect(table?.locator.sectionPath).toEqual(['Index params']);
  });

  it('ignores empty Feishu text blocks', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['empty', 'p1'] },
      text('empty', ''),
      text('p1', 'Visible paragraph.')
    ], 'doc_token');

    expect(document.nodes).toEqual([
      expect.objectContaining({ kind: 'text', markdown: 'Visible paragraph.' })
    ]);
  });

  it('preserves nested text hierarchy and distinguishes flat root siblings', () => {
    const nested = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['parent'] },
      {
        block_id: 'parent',
        block_type: 12,
        children: ['child', 'nested-bullet', 'nested-ordered'],
        bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
      },
      text('child', 'Child paragraph.'),
      bullet('nested-bullet', 'Nested bullet.'),
      {
        block_id: 'nested-ordered',
        block_type: 13,
        ordered: { elements: [{ text_run: { content: 'Nested ordered.', text_element_style: {} } }] }
      }
    ], 'doc_token');
    const flat = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['parent', 'child', 'nested-bullet', 'nested-ordered'] },
      {
        block_id: 'parent',
        block_type: 12,
        bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
      },
      text('child', 'Child paragraph.'),
      bullet('nested-bullet', 'Nested bullet.'),
      {
        block_id: 'nested-ordered',
        block_type: 13,
        ordered: { elements: [{ text_run: { content: 'Nested ordered.', text_element_style: {} } }] }
      }
    ], 'doc_token');

    expect(nested.nodes).toEqual([expect.objectContaining({
      kind: 'text',
      remoteBlockId: 'parent',
      children: [
        expect.objectContaining({ remoteBlockId: 'child', blockType: 2 }),
        expect.objectContaining({ remoteBlockId: 'nested-bullet', blockType: 12 }),
        expect.objectContaining({ remoteBlockId: 'nested-ordered', blockType: 13 })
      ]
    })]);
    expect(stripExecutionMetadata(nested)).not.toEqual(stripExecutionMetadata(flat));
  });

  it('classifies exact Procedures paragraphs as authoring tokens', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['intro', 'open', 'step', 'close', 'after'] },
      text('intro', 'Intro.'),
      text('open', '<Procedures>'),
      text('step', 'Step.'),
      text('close', '</Procedures>'),
      text('after', 'After.')
    ], 'doc_token');

    expect(document.nodes.filter((node) => node.kind === 'authoring-token')).toEqual([
      expect.objectContaining({ token: 'open', remoteBlockId: 'open' }),
      expect.objectContaining({ token: 'close', remoteBlockId: 'close' })
    ]);
    expect(document.nodes.filter((node) => node.kind === 'text').map((node) => node.locator.ordinal))
      .toEqual([0, 1, 2]);
  });

  it('blocks tables whose merge metadata spans multiple cells', () => {
    const document = remoteSemanticDocument(tableBlocks([
      { row_span: 1, col_span: 2 },
      { row_span: 1, col_span: 1 },
      { row_span: 1, col_span: 1 },
      { row_span: 1, col_span: 1 }
    ]), 'doc_token');
    const table = document.nodes.find((node) => node.kind === 'table');

    expect(table?.kind === 'table' ? table.unsupported : []).toContain('merged cells are unsupported');
  });

  it('represents image and Whiteboard resource blocks as asset scopes', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['h1', 'image1', 'wb1'] },
      heading('h1', 3, 'Architecture'),
      { block_id: 'image1', block_type: 27, image: { token: 'image_token' } },
      { block_id: 'wb1', block_type: 43, whiteboard: { token: 'wb_token' } }
    ], 'doc_token');

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'asset',
      representation: 'image',
      remoteBlockId: 'image1',
      remoteToken: 'image_token',
      locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 0 }
    }));
    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'asset',
      representation: 'whiteboard',
      remoteBlockId: 'wb1',
      remoteToken: 'wb_token',
      locator: { sectionPath: ['Architecture'], kind: 'asset', ordinal: 1 }
    }));
  });

  it('reads the board token field returned by the Docx blocks API', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['wb1'] },
      { block_id: 'wb1', block_type: 43, board: { token: 'wb_token' } }
    ], 'doc_token');

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'asset',
      representation: 'whiteboard',
      remoteBlockId: 'wb1',
      remoteToken: 'wb_token'
    }));
  });

  it('parses remote Callouts and separates presentation from body', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['h1', 'callout1'] },
      heading('h1', 3, 'Build index'),
      {
        block_id: 'callout1',
        block_type: 19,
        callout: { emoji_id: '📘', background_color: 2, border_color: 2 },
        children: ['title1', 'body1', 'item1']
      },
      text('title1', 'Notes'),
      text('body1', 'Use load-time CPU adaptation.'),
      bullet('item1', 'Reserve GPU resources for index building.')
    ], 'doc_token', { noteTitle: 'Notes', warningTitle: 'Warning' });

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'callout',
      calloutType: 'note',
      locator: { sectionPath: ['Build index'], kind: 'callout', ordinal: 0 },
      remoteBlockId: 'callout1',
      title: { markdown: 'Notes', remoteBlockId: 'title1' },
      children: [
        expect.objectContaining({ ordinal: 0, remoteBlockId: 'body1', blockType: 2 }),
        expect.objectContaining({ ordinal: 1, remoteBlockId: 'item1', blockType: 12 })
      ],
      shell: expect.objectContaining({ emojiId: '📘', backgroundColor: 2, borderColor: 2 }),
      unsupported: []
    }));
  });

  it('uses configured titles and English fallbacks to identify remote Callouts', () => {
    const chinese = remoteSemanticDocument(calloutBlocks('说明'), 'doc_token', {
      noteTitle: '说明',
      warningTitle: '警告'
    });
    const englishFallback = remoteSemanticDocument(calloutBlocks('Warning'), 'doc_token', {
      noteTitle: '说明',
      warningTitle: '警告'
    });

    expect(chinese.nodes[0]).toMatchObject({ kind: 'callout', calloutType: 'note' });
    expect(englishFallback.nodes[0]).toMatchObject({ kind: 'callout', calloutType: 'warning' });
  });

  it('leaves unrecognized remote Callout types unresolved and reports unsupported children', () => {
    const blocks = calloutBlocks('Custom title');
    blocks[1].callout = { emoji_id: 'custom_emoji' };
    blocks.push({ block_id: 'quote1', block_type: 15, quote: { elements: [] } });
    (blocks[1].children as string[]).push('quote1');
    const document = remoteSemanticDocument(blocks, 'doc_token');
    const callout = document.nodes[0];

    expect(callout).toMatchObject({
      kind: 'callout',
      calloutType: undefined,
      unsupported: expect.arrayContaining([
        'remote Callout title is unrecognized',
        'block_type 15 in Callout is unsupported'
      ])
    });
  });

  it('reports nested remote Callout lists as unsupported', () => {
    const blocks = calloutBlocks('Notes');
    blocks.push(text('nested1', 'Nested'));
    blocks[3].block_type = 12;
    blocks[3].bullet = blocks[3].text;
    delete blocks[3].text;
    blocks[3].children = ['nested1'];

    const callout = remoteSemanticDocument(blocks, 'doc_token').nodes[0];
    expect(callout).toMatchObject({
      kind: 'callout',
      unsupported: expect.arrayContaining(['nested lists are unsupported'])
    });
  });

  it('parses remote Code blocks with canonical language, exact content, and caption', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['h1', 'code1'] },
      heading('h1', 3, 'Build'),
      {
        block_id: 'code1',
        block_type: 14,
        code: {
          elements: [{ text_run: { content: 'print("ok")\n', text_element_style: {} } }],
          style: { language: 49, caption: 'Example' }
        }
      }
    ], 'doc_token');

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'code',
      locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      content: 'print("ok")\n',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      caption: 'Example',
      remoteBlockId: 'code1'
    }));
  });

  it('uses full-XML Code metadata when the blocks API omits language and caption', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['code1'] },
      {
        block_id: 'code1',
        block_type: 14,
        code: {
          elements: [{ text_run: { content: 'print(1)', text_element_style: {} } }],
          style: { wrap: false }
        }
      }
    ], 'doc_token', undefined, [{ blockId: 'code1', language: 'python', caption: 'Example' }]);

    expect(document.nodes[0]).toMatchObject({
      kind: 'code',
      content: 'print(1)',
      sourceLanguage: 'python',
      resolvedLanguage: 'python',
      caption: 'Example'
    });
  });

  it('prefers revision-pinned string Code metadata over stale external metadata', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['code1'] },
      {
        block_id: 'code1',
        block_type: 14,
        code: {
          elements: [{ text_run: { content: 'print(1)', text_element_style: {} } }],
          style: { language: 'go', caption: '' }
        }
      }
    ], 'doc_token', undefined, [{ blockId: 'code1', language: 'python', caption: 'Stale caption' }]);

    expect(document.nodes[0]).toMatchObject({
      kind: 'code',
      content: 'print(1)',
      sourceLanguage: 'go',
      resolvedLanguage: 'go',
      issues: []
    });
    expect(document.nodes[0]).toHaveProperty('caption', undefined);
  });

  it('normalizes the Feishu Plain Text label from full-XML Code metadata', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['code1'] },
      {
        block_id: 'code1',
        block_type: 14,
        code: {
          elements: [{ text_run: { content: 'example', text_element_style: {} } }],
          style: { language: 1 }
        }
      }
    ], 'doc_token', undefined, [{ blockId: 'code1', language: 'Plain Text' }]);

    expect(document.nodes[0]).toMatchObject({
      kind: 'code',
      sourceLanguage: 'Plain Text',
      resolvedLanguage: 'plaintext',
      issues: []
    });
  });

  it('recognizes fixture-backed Supademo add-on blocks as protected resources', async () => {
    const fixture = JSON.parse(await readFile(new URL(
      './fixtures/zdoc/model-providers/isv-blocks.json',
      import.meta.url
    ), 'utf8')) as FeishuBlock[];
    const document = remoteSemanticDocument([
      {
        block_id: 'doc_token',
        block_type: 1,
        children: fixture.map((block) => block.block_id).filter(Boolean) as string[]
      },
      ...fixture
    ], 'doc_token');

    expect(document.nodes).toEqual([
      expect.objectContaining({
        kind: 'protected-resource',
        resourceKind: 'supademo',
        componentId: 'cmj9f3j6u0johf6zpk5kdyx3u',
        isShowcase: false,
        remoteBlockId: 'XViWdTKb4ouwFJxEeepcSNQInLf'
      }),
      expect.objectContaining({
        kind: 'protected-resource',
        resourceKind: 'supademo',
        componentId: 'cmjcjqyk3017cw10i8dbm2ret',
        isShowcase: true,
        remoteBlockId: 'RYSAdAA9XojPNBxd0fqcZt42nEg'
      })
    ]);
  });

  it('keeps a Supademo add-on record without boolean showcase identity opaque', () => {
    const document = remoteSemanticDocument([
      { block_id: 'doc_token', block_type: 1, children: ['isv1'] },
      {
        block_id: 'isv1',
        block_type: 40,
        add_ons: {
          component_type_id: 'blk_682093ba9580c002363b9dc3',
          record: '{"id":"demo-id"}'
        }
      }
    ], 'doc_token');

    expect(document.nodes).not.toContainEqual(expect.objectContaining({
      kind: 'protected-resource'
    }));
    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'opaque',
      remoteBlockId: 'isv1'
    }));
  });
});

function calloutBlocks(title: string): FeishuBlock[] {
  return [
    { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
    { block_id: 'callout1', block_type: 19, callout: { emoji_id: '📘' }, children: ['title1', 'body1'] },
    text('title1', title),
    text('body1', 'Body')
  ];
}

function tableBlocks(mergeInfo: unknown[]): FeishuBlock[] {
  return [
    { block_id: 'doc_token', block_type: 1, children: ['table1'] },
    {
      block_id: 'table1',
      block_type: 31,
      table: {
        property: { row_size: 2, column_size: 2, merge_info: mergeInfo },
        cells: ['c1', 'c2', 'c3', 'c4']
      }
    },
    { block_id: 'c1', block_type: 32, children: ['c1p'] },
    text('c1p', 'Parameter'),
    { block_id: 'c2', block_type: 32, children: ['c2p'] },
    text('c2p', 'Description'),
    { block_id: 'c3', block_type: 32, children: ['c3p'] },
    text('c3p', 'build_algo'),
    { block_id: 'c4', block_type: 32, children: ['c4p'] },
    text('c4p', 'Build algorithm.')
  ];
}

function text(blockId: string, content: string, style: Record<string, unknown> = {}): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 2,
    text: { elements: [{ text_run: { content, text_element_style: style } }] }
  };
}

function bullet(blockId: string, content: string): FeishuBlock {
  return {
    block_id: blockId,
    block_type: 12,
    bullet: { elements: [{ text_run: { content, text_element_style: {} } }] }
  };
}

function heading(blockId: string, blockType: number, content: string): FeishuBlock {
  const level = blockType - 2;
  return {
    block_id: blockId,
    block_type: blockType,
    [`heading${level}`]: { elements: [{ text_run: { content, text_element_style: {} } }] }
  };
}
