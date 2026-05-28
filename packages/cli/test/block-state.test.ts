import { describe, expect, it } from 'vitest';
import { comparableDirectChildBlocks, directChildBlocks, findPageBlock, renderableDirectChildBlocks } from '../src/sync/block-state.js';

describe('block-state helpers', () => {
  it('throws when a page block cannot be found', () => {
    expect(() => findPageBlock([], 'doc')).toThrow(/Could not find page block/);
  });

  it('resolves direct child IDs into blocks', () => {
    const page = { block_id: 'page', block_type: 1, children: ['a', 'missing', { block_type: 2 }] };
    const blocks = [page, { block_id: 'a', block_type: 3 }];
    expect(directChildBlocks(blocks, page)).toEqual([{ block_id: 'a', block_type: 3 }, { block_type: 2 }]);
  });

  it('resolves table cell IDs into comparable cell content blocks', () => {
    const page = { block_id: 'page', block_type: 1, children: ['table'] };
    const blocks = [
      page,
      { block_id: 'table', block_type: 31, table: { property: { row_size: 1, column_size: 1 }, cells: ['cell'] } },
      { block_id: 'cell', block_type: 32, children: ['text'] },
      { block_id: 'text', block_type: 2, text: { elements: [] } }
    ];

    expect(comparableDirectChildBlocks(blocks, page)[0]).toMatchObject({
      block_type: 31,
      table: {
        cells: [{ block_id: 'text', block_type: 2, text: { elements: [] } }]
      }
    });
  });

  it('expands Feishu source-synced containers for rendering', () => {
    const page = { block_id: 'page', block_type: 1, children: ['source'] };
    const blocks = [
      page,
      { block_id: 'source', block_type: 49, children: ['python', 'java'] },
      { block_id: 'python', block_type: 14, code: { elements: [] } },
      { block_id: 'java', block_type: 14, code: { elements: [] } }
    ];

    expect(renderableDirectChildBlocks(blocks, page)).toEqual([
      { block_id: 'python', block_type: 14, code: { elements: [] } },
      { block_id: 'java', block_type: 14, code: { elements: [] } }
    ]);
  });

  it('resolves source-synced container children for comparable blocks', () => {
    const page = { block_id: 'page', block_type: 1, children: ['source'] };
    const blocks = [
      page,
      { block_id: 'source', block_type: 49, children: ['python'] },
      { block_id: 'python', block_type: 14, code: { elements: [] } }
    ];

    expect(comparableDirectChildBlocks(blocks, page)).toEqual([
      {
        block_id: 'source',
        block_type: 49,
        children: [{ block_id: 'python', block_type: 14, code: { elements: [] } }]
      }
    ]);
  });
});
