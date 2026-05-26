import { describe, expect, it } from 'vitest';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../src/sync/merge.js';

describe('threeWayMerge', () => {
  it('returns local when only local changed', () => {
    expect(threeWayMerge({
      base: 'A\nB\n',
      local: 'A\nLOCAL\n',
      remote: 'A\nB\n'
    })).toEqual({
      content: 'A\nLOCAL\n',
      conflictCount: 0,
      clean: true
    });
  });

  it('returns remote when only remote changed', () => {
    expect(threeWayMerge({
      base: 'A\nB\n',
      local: 'A\nB\n',
      remote: 'A\nREMOTE\n'
    })).toEqual({
      content: 'A\nREMOTE\n',
      conflictCount: 0,
      clean: true
    });
  });

  it('keeps identical local and remote edits', () => {
    expect(threeWayMerge({
      base: 'A\nB\n',
      local: 'A\nSAME\n',
      remote: 'A\nSAME\n'
    })).toEqual({
      content: 'A\nSAME\n',
      conflictCount: 0,
      clean: true
    });
  });

  it('auto-merges non-overlapping single-line edits', () => {
    expect(threeWayMerge({
      base: 'A\nB\nC\n',
      local: 'A\nLOCAL\nC\n',
      remote: 'A\nB\nREMOTE\n'
    })).toEqual({
      content: 'A\nLOCAL\nREMOTE\n',
      conflictCount: 0,
      clean: true
    });
  });

  it('marks overlapping edits with conflict markers', () => {
    const result = threeWayMerge({
      base: 'A\nB\nC\n',
      local: 'A\nLOCAL\nC\n',
      remote: 'A\nREMOTE\nC\n'
    });

    expect(result.clean).toBe(false);
    expect(result.conflictCount).toBe(1);
    expect(result.content).toContain('<<<<<<< LOCAL');
    expect(result.content).toContain('||||||| BASE');
    expect(result.content).toContain('>>>>>>> FEISHU');
  });
});

describe('defaultMergedPath', () => {
  it('places merged output next to the local markdown file', () => {
    expect(defaultMergedPath('/tmp/feishu-test.md')).toBe('/tmp/feishu-test.merged.md');
  });

  it('adds a markdown extension when the input has none', () => {
    expect(defaultMergedPath('/tmp/feishu-test')).toBe('/tmp/feishu-test.merged.md');
  });
});

describe('buildMergeInstructions', () => {
  it('prints clean merge instructions', () => {
    expect(buildMergeInstructions({
      clean: true,
      outputPath: '/tmp/doc.merged.md',
      conflictCount: 0,
      documentRef: 'doc123'
    })).toContain('merge: clean');
  });

  it('prints conflict merge instructions with the output file as the edit target', () => {
    const instructions = buildMergeInstructions({
      clean: false,
      outputPath: '/tmp/doc.merged.md',
      conflictCount: 2,
      documentRef: 'doc123'
    });

    expect(instructions).toContain('merge: conflicts');
    expect(instructions).toContain('Resolve conflict markers in:');
    expect(instructions).toContain('/tmp/doc.merged.md');
  });
});
