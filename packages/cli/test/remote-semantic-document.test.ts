import { describe, expect, it } from 'vitest';
import type { FeishuBlock } from '../src/feishu/types.js';
import { remoteSemanticDocument } from '../src/semantic/remote-document.js';

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
});

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
