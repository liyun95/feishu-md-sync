import { describe, expect, it } from 'vitest';
import { buildTextLikeBlockUpdateRequest, isTextLikeBlockPairUpdateable } from '../src/sync/block-update.js';

describe('block update planning', () => {
  it('builds a paragraph update request that preserves the remote block id', () => {
    const remote = {
      block_id: 'remote-1',
      block_type: 2,
      text: { elements: [{ text_run: { content: 'Old', text_element_style: {} } }] }
    };
    const desired = {
      block_type: 2,
      text: { elements: [{ text_run: { content: 'New', text_element_style: { bold: true } } }] }
    };

    expect(isTextLikeBlockPairUpdateable(remote, desired)).toBe(true);
    expect(buildTextLikeBlockUpdateRequest(remote, desired)).toEqual({
      block_id: 'remote-1',
      update_text_elements: {
        elements: [{ text_run: { content: 'New', text_element_style: { bold: true } } }]
      }
    });
  });

  it('refuses different block types and blocks without ids', () => {
    expect(isTextLikeBlockPairUpdateable({ block_type: 2 }, { block_type: 2 })).toBe(false);
    expect(isTextLikeBlockPairUpdateable({ block_id: 'a', block_type: 2 }, { block_type: 31 })).toBe(false);
  });
});
