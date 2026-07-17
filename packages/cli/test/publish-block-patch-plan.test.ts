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
      parentBlockId: 'page',
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
      parentBlockId: 'callout1',
      remoteBlockId: 'p1',
      path: [0, 0],
      blockType: 2
    }]);
  });

  it('creates a nested text tree after a stable root anchor', () => {
    const nested = {
      block_type: 12,
      bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: {} } }] },
      children: [
        paragraph(undefined, 'Child paragraph.'),
        {
          block_type: 12,
          bullet: { elements: [{ text_run: { content: 'Nested bullet.', text_element_style: {} } }] }
        }
      ]
    } satisfies FeishuBlock;
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [paragraph('anchor', 'Before.')],
      desiredBlocks: [paragraph(undefined, 'Before.'), nested]
    });

    expect(plan).toMatchObject({
      safeToWrite: true,
      operations: [{
        kind: 'create',
        parentBlockId: 'page',
        insertAfterBlockId: 'anchor',
        path: [1],
        blocks: [nested]
      }]
    });
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
      insertAfterBlockId: 'p1',
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

  it('refuses to delete complex Feishu-only blocks', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [{ block_id: 'callout1', block_type: 19, callout: {}, children: [] }],
      desiredBlocks: []
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.fallbackReason).toBe('delete block_type 19 is unsupported at 0');
  });

  it('refuses to create complex Feishu-only blocks', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [],
      desiredBlocks: [{ block_type: 43, whiteboard: { token: 'new' } }]
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.fallbackReason).toBe('create block_type 43 is unsupported at 0');
  });

  it('fails closed when mixed sequence anchors are duplicated and ambiguous', () => {
    const plan = planPublishBlockPatch({
      parentBlockId: 'page',
      remoteBlocks: [
        paragraph('old-start', 'Old start.'),
        paragraph('duplicate-1', 'Repeated anchor.'),
        paragraph('duplicate-2', 'Repeated anchor.'),
        paragraph('old-tail', 'Old tail.'),
        paragraph('stable-end', 'Stable end.')
      ],
      desiredBlocks: [
        paragraph(undefined, 'New start.'),
        paragraph(undefined, 'Repeated anchor.'),
        paragraph(undefined, 'Inserted detail.'),
        paragraph(undefined, 'Repeated anchor.'),
        paragraph(undefined, 'New tail.'),
        paragraph(undefined, 'Stable end.')
      ]
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.operations).toEqual([]);
    expect(plan.fallbackReason).toBe('block order or count changed without a unique stable anchor at <root>');
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
