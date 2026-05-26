import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/sync/diff.js';

describe('unifiedDiff', () => {
  it('prints removed and added lines', () => {
    const diff = unifiedDiff('local.md', 'feishu.md', 'A\nB\n', 'A\nC\n');

    expect(diff).toContain('--- local.md');
    expect(diff).toContain('+++ feishu.md');
    expect(diff).toContain('-B');
    expect(diff).toContain('+C');
  });

  it('prints unchanged lines with context prefix', () => {
    expect(unifiedDiff('a', 'b', 'same\n', 'same\n')).toContain(' same');
  });
});
