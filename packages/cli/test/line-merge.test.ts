import { describe, expect, it } from 'vitest';
import { mergeLines, mergeWithoutBase } from '../src/merge/line-merge.js';

describe('line merge', () => {
  it('returns clean when local and remote match', () => {
    const result = mergeLines({
      base: 'A\nB\n',
      local: 'A\nB\n',
      remote: 'A\nB\n'
    });

    expect(result).toEqual({
      markdown: 'A\nB\n',
      state: 'clean',
      conflicts: 0,
      changed: false
    });
  });

  it('auto-merges non-overlapping local and remote edits', () => {
    const result = mergeLines({
      base: 'A\nB\nC\n',
      local: 'A local\nB\nC\n',
      remote: 'A\nB\nC remote\n'
    });

    expect(result).toEqual({
      markdown: 'A local\nB\nC remote\n',
      state: 'merged',
      conflicts: 0,
      changed: true
    });
  });

  it('keeps local-only changes clean when remote did not change', () => {
    const result = mergeLines({
      base: 'A\nB\n',
      local: 'A local\nB\n',
      remote: 'A\nB\n'
    });

    expect(result).toEqual({
      markdown: 'A local\nB\n',
      state: 'clean',
      conflicts: 0,
      changed: false
    });
  });

  it('creates conflict markers for overlapping edits', () => {
    const result = mergeLines({
      base: 'A\nB\nC\n',
      local: 'A\nB local\nC\n',
      remote: 'A\nB remote\nC\n'
    });

    expect(result.state).toBe('conflict');
    expect(result.conflicts).toBe(1);
    expect(result.markdown).toBe('A\n<<<<<<< LOCAL\nB local\n=======\nB remote\n>>>>>>> REMOTE\nC\n');
  });

  it('combines same-position insertions while avoiding duplicate shared prefixes', () => {
    const result = mergeLines({
      base: 'A\n',
      local: 'A\n\nLocal paragraph.\n',
      remote: 'A\n\nRemote paragraph.\n'
    });

    expect(result).toEqual({
      markdown: 'A\n\nLocal paragraph.\nRemote paragraph.\n',
      state: 'merged',
      conflicts: 0,
      changed: true
    });
  });

  it('without base only wraps different regions in LOCAL/REMOTE markers', () => {
    const result = mergeWithoutBase({
      local: '# Title\n\nLocal paragraph.\n\nSame.\n',
      remote: '# Title\n\nRemote paragraph.\n\nSame.\n'
    });

    expect(result).toEqual({
      markdown: '# Title\n\n<<<<<<< LOCAL\nLocal paragraph.\n=======\nRemote paragraph.\n>>>>>>> REMOTE\n\nSame.\n',
      state: 'conflict',
      conflicts: 1,
      changed: true
    });
  });
});
