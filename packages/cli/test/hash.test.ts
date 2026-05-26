import { describe, expect, it } from 'vitest';
import { hashBlocks, sha256, stableStringify } from '../src/core/hash.js';

describe('hashing', () => {
  it('hashes strings with sha256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('stable-stringifies object keys', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
  });

  it('ignores volatile Feishu block IDs in block hashes', () => {
    const one = hashBlocks([{ block_id: 'a', block_type: 2, text: { elements: [] } }]);
    const two = hashBlocks([{ block_id: 'b', block_type: 2, text: { elements: [] } }]);
    expect(one).toBe(two);
  });

  it('ignores Feishu default folded false style fields', () => {
    const source = hashBlocks([{ block_type: 3, heading1: { style: { align: 1 }, elements: [] } }]);
    const readback = hashBlocks([{ block_type: 3, heading1: { style: { align: 1, folded: false }, elements: [] } }]);
    expect(source).toBe(readback);
  });

  it('ignores Feishu default align style fields', () => {
    const source = hashBlocks([{ block_type: 12, bullet: { style: {}, elements: [] } }]);
    const readback = hashBlocks([{ block_type: 12, bullet: { style: { align: 1 }, elements: [] } }]);
    expect(source).toBe(readback);
  });

  it('ignores Feishu default wrap style fields and merged equivalent text runs', () => {
    const style = { bold: false, inline_code: false };
    const source = hashBlocks([{
      block_type: 14,
      code: {
        elements: [{ text_run: { content: 'hello world', text_element_style: style } }],
        style: { language: 50 }
      }
    }]);
    const readback = hashBlocks([{
      block_type: 14,
      code: {
        elements: [
          { text_run: { content: 'hello ', text_element_style: style } },
          { text_run: { content: 'world', text_element_style: style } }
        ],
        style: { language: 50, wrap: false }
      }
    }]);
    expect(source).toBe(readback);
  });

  it('ignores table merge info in hashes', () => {
    const source = hashBlocks([{ block_type: 31, table: { property: { row_size: 1, column_size: 1, merge_info: [null] } } }]);
    const readback = hashBlocks([{ block_type: 31, table: { property: { row_size: 1, column_size: 1 } } }]);
    expect(source).toBe(readback);
  });

  it('ignores default table column widths in hashes', () => {
    const source = hashBlocks([{ block_type: 31, table: { property: { row_size: 1, column_size: 2 } } }]);
    const readback = hashBlocks([{ block_type: 31, table: { property: { row_size: 1, column_size: 2, column_width: [100, 100] } } }]);
    expect(source).toBe(readback);
  });
});
