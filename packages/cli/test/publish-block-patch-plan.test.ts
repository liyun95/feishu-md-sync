import { describe, expect, it } from 'vitest';
import type { FeishuBlock } from '../src/feishu/types.js';
import { planPublishBlockPatch } from '../src/publish/block-patch-plan.js';

describe('publish block patch plan', () => {
  it('plans no operations when blocks are equivalent', () => {
    const remote = [paragraph('b1', 'Milvus stores vectors.')];
    const desired = [paragraph(undefined, 'Milvus stores vectors.')];

    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: remote,
      desiredBlocks: desired
    });

    expect(plan.safeToWrite).toBe(true);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(false);
    expect(plan.operations).toEqual([]);
  });

  it('updates an existing text-like block and requires collaboration-risk confirmation', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [paragraph('b1', 'Milvus stores vectors.')],
      desiredBlocks: [paragraph(undefined, 'Milvus stores vector data.')]
    });

    expect(plan.safeToWrite).toBe(true);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(plan.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'b1',
      path: [0],
      blockType: 2
    }]);
  });

  it('patches a nested child block without replacing the container', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [
        callout('callout1', [
          paragraph('p1', 'Milvus stores vectors.'),
          paragraph('p2', 'Keep this note.')
        ])
      ],
      desiredBlocks: [
        callout(undefined, [
          paragraph(undefined, 'Milvus stores vector data.'),
          paragraph(undefined, 'Keep this note.')
        ])
      ]
    });

    expect(plan.safeToWrite).toBe(true);
    expect(plan.operations).toEqual([{
      kind: 'update',
      remoteBlockId: 'p1',
      path: [0, 0],
      blockType: 2
    }]);
  });

  it('allows insert-only nested block patches without collaboration-risk confirmation', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [
        callout('callout1', [
          paragraph('p1', 'Milvus stores vectors.')
        ])
      ],
      desiredBlocks: [
        callout(undefined, [
          paragraph(undefined, 'Milvus stores vectors.'),
          paragraph(undefined, 'New note.')
        ])
      ]
    });

    expect(plan.safeToWrite).toBe(true);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(false);
    expect(plan.operations).toEqual([{
      kind: 'create',
      parentBlockId: 'callout1',
      index: 1,
      path: [0, 1],
      blocks: [paragraph(undefined, 'New note.')]
    }]);
  });

  it('refuses block patch when a container shell changes', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [
        callout('callout1', [paragraph('p1', 'Milvus stores vectors.')], '💡')
      ],
      desiredBlocks: [
        callout(undefined, [paragraph(undefined, 'Milvus stores vectors.')], '✅')
      ]
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.fallbackReason).toBe('container block shell changed at 0');
  });

  it('refuses to replace existing whiteboard blocks', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [{ block_id: 'wb1', block_type: 43, whiteboard: { token: 'old' } }],
      desiredBlocks: [{ block_type: 43, whiteboard: { token: 'new' } }]
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.fallbackReason).toBe('whiteboard block changed at 0');
  });
});

function paragraph(blockId: string | undefined, text: string): FeishuBlock {
  return {
    ...(blockId ? { block_id: blockId } : {}),
    block_type: 2,
    text: {
      elements: [{ text_run: { content: text, text_element_style: {} } }]
    }
  };
}

function callout(blockId: string | undefined, children: FeishuBlock[], emoji = '💡'): FeishuBlock {
  return {
    ...(blockId ? { block_id: blockId } : {}),
    block_type: 19,
    callout: { emoji_id: emoji },
    children
  };
}
