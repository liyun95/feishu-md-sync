import { describe, expect, it, vi } from 'vitest';
import { applyBlockLevelSectionPatch } from '../src/sync/block-level-apply.js';

describe('applyBlockLevelSectionPatch', () => {
  it('updates blocks before creating or deleting ranges', async () => {
    const calls: string[] = [];
    const client = {
      batchUpdateBlocks: vi.fn(async () => {
        calls.push('update');
        return [];
      }),
      createChildren: vi.fn(async () => {
        calls.push('create');
        return [{ block_id: 'created', block_type: 2 }];
      }),
      deleteChildren: vi.fn(async () => {
        calls.push('delete');
      })
    };

    await applyBlockLevelSectionPatch(client, 'doc', {
      remoteSectionBlocks: [
        { block_id: 'p1', block_type: 2, text: { elements: [] } }
      ],
      desiredSectionBlocks: [
        { block_type: 2, text: { elements: [] } },
        { block_type: 2, text: { elements: [] } }
      ],
      remoteStartIndex: 0,
      operations: [
        { kind: 'update', remoteBlockId: 'p1', remoteIndex: 0, desiredIndex: 0, blockType: 2 },
        { kind: 'create', parentBlockId: 'page', index: 1, desiredStartIndex: 1, desiredEndIndex: 2, blocks: [{ block_type: 2, text: { elements: [] } }] }
      ]
    });

    expect(calls).toEqual(['update', 'create']);
    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc', [
      { block_id: 'p1', update_text_elements: { elements: [] } }
    ]);
  });
});
