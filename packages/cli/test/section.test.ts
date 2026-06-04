import { describe, expect, it } from 'vitest';
import { hashBlocks } from '../src/core/hash.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import {
  findUniqueSectionRange,
  planBeforeHeadingPatch,
  planInsertSectionPatch,
  planSectionPatch
} from '../src/sync/section.js';

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

describe('insert section planning', () => {
  it('inserts a local section before an existing remote heading', () => {
    const remote = markdownToFeishuBlocks(`## Intro

Remote intro

## Arithmetic Operators

Remote arithmetic
`);
    const local = markdownToFeishuBlocks(`## Pattern matching operators

New regex content
`);

    const plan = planInsertSectionPatch(remote, local, {
      insertSection: 'Pattern matching operators',
      relative: 'before',
      targetHeading: 'Arithmetic Operators'
    });

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(0);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'Pattern matching operators',
      remoteStartIndex: 2,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...remote.slice(0, 2),
      ...local,
      ...remote.slice(2)
    ]);
  });

  it('inserts a local section after an existing remote heading section', () => {
    const remote = markdownToFeishuBlocks(`## Examples

Remote examples

## Conclusion

Remote conclusion
`);
    const local = markdownToFeishuBlocks(`## Regex filter templates

New template content
`);

    const plan = planInsertSectionPatch(remote, local, {
      insertSection: 'Regex filter templates',
      relative: 'after',
      targetHeading: 'Examples'
    });

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(0);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'Regex filter templates',
      remoteStartIndex: 2,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...remote.slice(0, 2),
      ...local,
      ...remote.slice(2)
    ]);
  });

  it('rejects insert-section when the local section is missing', () => {
    const remote = markdownToFeishuBlocks('## Existing\n\nRemote\n');
    const local = markdownToFeishuBlocks('## Other\n\nLocal\n');

    expect(() => planInsertSectionPatch(remote, local, {
      insertSection: 'Missing',
      relative: 'before',
      targetHeading: 'Existing'
    })).toThrow('Could not find local section "Missing".');
  });
});

describe('before-heading planning', () => {
  it('replaces only the prefix before an existing heading', () => {
    const remote = markdownToFeishuBlocks(`Remote intro

Remote note

## How it works

Remote how
`);
    const local = markdownToFeishuBlocks(`Local intro

Local note

## How it works

Local how should not sync
`);

    const plan = planBeforeHeadingPatch(remote, local, 'How it works');

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(2);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'before heading: How it works',
      remoteStartIndex: 0,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...local.slice(0, 2),
      ...remote.slice(2)
    ]);
  });

  it('rejects before-heading when the target heading is missing remotely', () => {
    const remote = markdownToFeishuBlocks('Remote intro\n');
    const local = markdownToFeishuBlocks('Local intro\n\n## How it works\n');

    expect(() => planBeforeHeadingPatch(remote, local, 'How it works')).toThrow(
      'Could not find remote section "How it works".'
    );
  });
});
