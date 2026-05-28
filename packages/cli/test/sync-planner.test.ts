import { describe, expect, it } from 'vitest';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { planSyncPatch } from '../src/workflows/sync/planner.js';

describe('sync patch planner', () => {
  it('plans noop when current and desired blocks match', () => {
    const blocks = markdownToFeishuBlocks('# Title\n\nBody\n');
    expect(planSyncPatch({ currentChildren: blocks, desiredChildren: blocks }).operation.kind).toBe('noop');
  });

  it('plans a contiguous block replacement for a small body edit', () => {
    const current = markdownToFeishuBlocks('# Title\n\nOld body\n\n## Next\n\nSame\n');
    const desired = markdownToFeishuBlocks('# Title\n\nNew body\n\n## Next\n\nSame\n');
    const plan = planSyncPatch({ currentChildren: current, desiredChildren: desired });
    expect(plan.operation).toMatchObject({
      kind: 'replace-contiguous-blocks',
      remoteStartIndex: 1,
      remoteEndIndex: 2,
      localStartIndex: 1,
      localEndIndex: 2,
      deleteCount: 1,
      createCount: 1
    });
  });

  it('falls back to replace-document when too much changed', () => {
    const current = markdownToFeishuBlocks('# A\n\nOne\n\n## B\n\nTwo\n');
    const desired = markdownToFeishuBlocks('# X\n\nAlpha\n\n## Y\n\nBeta\n');
    expect(planSyncPatch({ currentChildren: current, desiredChildren: desired }).operation.kind).toBe('replace-document');
  });
});
