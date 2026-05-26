import { describe, expect, it } from 'vitest';
import {
  assessPrBranchHygiene,
  buildCleanBranchPlan,
  suggestTopicBranch
} from '../src/multisdk/git-hygiene.js';

describe('multisdk git hygiene', () => {
  it('rejects branch names that match the upstream base branch name', () => {
    const report = assessPrBranchHygiene({
      baseRef: 'upstream/v3.0.x',
      currentBranch: 'v3.0.x',
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      language: 'java',
      commitsRelativeToBase: [
        '1111111 unrelated old commit',
        '2222222 docs(schema): update nullable Java examples'
      ]
    });

    expect(report.passed).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('v3.0.x')
    ]));
    expect(report.suggestedBranch).toBe('docs/nullable-and-default-java-v3-0-x');
    expect(report.commitsRelativeToBase).toHaveLength(2);
  });

  it('rejects topic branches that already contain commits relative to the base', () => {
    const branch = suggestTopicBranch({
      baseRef: 'upstream/v3.0.x',
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      language: 'java'
    });
    const report = assessPrBranchHygiene({
      baseRef: 'upstream/v3.0.x',
      currentBranch: branch,
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      language: 'java',
      commitsRelativeToBase: ['2222222 docs(schema): update nullable Java examples']
    });

    expect(report.passed).toBe(false);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('already has 1 commit')
    ]));
  });

  it('accepts clean topic branches and returns a clean branch command plan', () => {
    const branch = suggestTopicBranch({
      baseRef: 'upstream/v3.0.x',
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      language: 'java'
    });
    const report = assessPrBranchHygiene({
      baseRef: 'upstream/v3.0.x',
      currentBranch: branch,
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      language: 'java',
      commitsRelativeToBase: []
    });
    const plan = buildCleanBranchPlan({
      baseRef: 'upstream/v3.0.x',
      branch,
      target: 'site/en/userGuide/schema/nullable-and-default.md',
      commitMessage: 'docs(schema): update nullable Java examples'
    });

    expect(report.passed).toBe(true);
    expect(plan.commands).toEqual([
      ['git', 'fetch', 'upstream', 'v3.0.x'],
      ['git', 'switch', '-c', branch, 'upstream/v3.0.x'],
      ['git', 'add', 'site/en/userGuide/schema/nullable-and-default.md'],
      ['git', 'commit', '-m', 'docs(schema): update nullable Java examples']
    ]);
  });
});
