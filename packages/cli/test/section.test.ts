import { describe, expect, it } from 'vitest';
import { hashBlocks } from '../src/core/hash.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { findUniqueSectionRange, planSectionPatch } from '../src/sync/section.js';

describe('section-level sync planning', () => {
  it('finds a heading section range including nested subsections', () => {
    const blocks = markdownToFeishuBlocks(`# Title

## Target

A

### Child

B

## Other

C
`);

    const range = findUniqueSectionRange(blocks, 'Target', 'local');

    expect(range).toMatchObject({
      title: 'Target',
      level: 2,
      startIndex: 1,
      endIndex: 5
    });
    expect(range.blocks).toHaveLength(4);
  });

  it('fails when a section heading is missing or duplicated', () => {
    const missing = markdownToFeishuBlocks('# Title\n\nBody\n');
    expect(() => findUniqueSectionRange(missing, 'Target', 'local')).toThrow(
      /Could not find local section "Target"/
    );

    const duplicated = markdownToFeishuBlocks('## Target\n\nA\n\n## Target\n\nB\n');
    expect(() => findUniqueSectionRange(duplicated, 'Target', 'remote')).toThrow(
      /Found 2 remote sections named "Target"/
    );
  });

  it('plans a section replacement without changing blocks outside that section', () => {
    const current = markdownToFeishuBlocks(`# Title

Intro

## Target

Old remote body

## Other

Remote-only content
`);
    const desired = markdownToFeishuBlocks(`# Title

Local intro should not be synced

## Target

New local body

## Other

Local other should not be synced
`);

    const result = planSectionPatch(current, desired, 'Target');

    expect(result.patchPlan).toMatchObject({
      operation: 'replace-section',
      deleteCount: 2,
      createCount: 2
    });
    expect(result.patchPlan.section).toMatchObject({
      title: 'Target',
      remoteStartIndex: 2,
      remoteEndIndex: 4,
      localStartIndex: 2,
      localEndIndex: 4
    });
    expect(result.replacementBlocks).toEqual(desired.slice(2, 4));
    expect(result.expectedChildren).toEqual([
      ...current.slice(0, 2),
      ...desired.slice(2, 4),
      ...current.slice(4)
    ]);
    expect(result.patchPlan.desiredHash).toBe(hashBlocks(result.expectedChildren));
  });

  it('plans no-op when the selected section already matches even if other local sections differ', () => {
    const current = markdownToFeishuBlocks(`# Title

Remote intro

## Target

Same body

## Other

Remote-only content
`);
    const desired = markdownToFeishuBlocks(`# Title

Local intro differs

## Target

Same body

## Other

Local other differs
`);

    const result = planSectionPatch(current, desired, 'Target');

    expect(result.patchPlan.operation).toBe('noop');
    expect(result.expectedChildren).toEqual(current);
  });
});
