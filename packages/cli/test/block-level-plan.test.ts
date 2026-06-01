import { describe, expect, it } from 'vitest';
import { planBlockLevelSectionPatch } from '../src/sync/block-level-plan.js';

describe('planBlockLevelSectionPatch', () => {
  it('plans an in-place update for a changed text block', () => {
    const remote = [
      heading(2, 'FAQ', 'h1'),
      text('Old answer', 'p1'),
      heading(2, 'Other', 'h2')
    ];
    const desired = [
      heading(2, 'FAQ'),
      text('New answer')
    ];

    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: remote.slice(0, 2),
      desiredSectionBlocks: desired,
      parentBlockId: 'page',
      remoteStartIndex: 0
    });

    expect(plan.kind).toBe('block-level-section-patch');
    expect(plan.operations).toEqual([
      {
        kind: 'update',
        remoteBlockId: 'p1',
        remoteIndex: 1,
        desiredIndex: 1,
        blockType: 2
      }
    ]);
  });

  it('plans an insert without deleting the section', () => {
    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: [heading(2, 'FAQ', 'h1'), text('Old line', 'p1')],
      desiredSectionBlocks: [heading(2, 'FAQ'), text('New line'), text('Old line')],
      parentBlockId: 'page',
      remoteStartIndex: 4
    });

    expect(plan.operations).toEqual([
      {
        kind: 'create',
        parentBlockId: 'page',
        index: 5,
        desiredStartIndex: 1,
        desiredEndIndex: 2,
        blocks: [text('New line')]
      }
    ]);
  });

  it('matches unchanged suffix blocks by rendered Markdown when raw block style differs', () => {
    const remoteOld = text('Old line', 'p1');
    remoteOld.text.style = { align: 1, folded: false };
    const desiredOld = text('Old line');
    desiredOld.text.style = {};

    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: [heading(2, 'FAQ', 'h1'), remoteOld],
      desiredSectionBlocks: [heading(2, 'FAQ'), text('Inserted'), desiredOld],
      parentBlockId: 'page',
      remoteStartIndex: 10
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'create', index: 11, desiredStartIndex: 1, desiredEndIndex: 2 })
    ]);
  });

  it('falls back when create count is much larger than the remote section', () => {
    const remote = [heading(2, 'FAQ', 'h1'), text('Old', 'p1')];
    const desired = [heading(2, 'FAQ'), ...Array.from({ length: 30 }, (_, index) => text(`Line ${index}`))];

    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: remote,
      desiredSectionBlocks: desired,
      parentBlockId: 'page',
      remoteStartIndex: 0
    });

    expect(plan.fallbackReason).toMatch(/unsafe create volume/);
    expect(plan.unsafeForWrite).toBe(true);
    expect(plan.operations[0]).toMatchObject({ kind: 'replace-range' });
  });
});

function heading(level: number, title: string, blockId?: string) {
  return {
    block_id: blockId,
    block_type: level + 2,
    [`heading${level}`]: { elements: [{ text_run: { content: title, text_element_style: {} } }] }
  };
}

function text(content: string, blockId?: string) {
  return {
    block_id: blockId,
    block_type: 2,
    text: { elements: [{ text_run: { content, text_element_style: {} } }] }
  };
}
