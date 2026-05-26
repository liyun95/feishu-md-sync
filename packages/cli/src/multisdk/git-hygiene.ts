import { basename } from 'node:path';
import type { MultisdkLanguage } from './language.js';

export type PrBranchHygieneInput = {
  baseRef: string;
  currentBranch?: string;
  intendedBranch?: string;
  target: string;
  language: MultisdkLanguage;
  commitsRelativeToBase?: string[];
};

export type PrBranchHygieneReport = {
  passed: boolean;
  baseRef: string;
  baseBranch: string;
  currentBranch?: string;
  intendedBranch?: string;
  suggestedBranch: string;
  commitsRelativeToBase: string[];
  warnings: string[];
};

export type CleanBranchPlan = {
  baseRef: string;
  branch: string;
  target: string;
  commitMessage: string;
  commands: string[][];
};

export function assessPrBranchHygiene(input: PrBranchHygieneInput): PrBranchHygieneReport {
  const baseBranch = branchNameFromRef(input.baseRef);
  const suggestedBranch = suggestTopicBranch(input);
  const currentBranchIsBase = input.currentBranch === baseBranch;
  const intendedBranchIsBase = input.intendedBranch === baseBranch;
  const warnings: string[] = [];

  if (currentBranchIsBase) {
    warnings.push(
      `Current branch ${input.currentBranch} matches base branch ${input.baseRef}; use a topic branch such as ${suggestedBranch}.`
    );
  }
  if (intendedBranchIsBase) {
    warnings.push(
      `Intended branch ${input.intendedBranch} matches base branch ${input.baseRef}; use a topic branch such as ${suggestedBranch}.`
    );
  }
  const commitsRelativeToBase = input.commitsRelativeToBase ?? [];
  if (commitsRelativeToBase.length > 0) {
    warnings.push(
      `Branch already has ${commitsRelativeToBase.length} commit(s) relative to ${input.baseRef}; create a clean topic branch before writing docs.`
    );
  }

  return {
    passed: warnings.length === 0,
    baseRef: input.baseRef,
    baseBranch,
    currentBranch: input.currentBranch,
    intendedBranch: input.intendedBranch,
    suggestedBranch,
    commitsRelativeToBase,
    warnings
  };
}

export function suggestTopicBranch(input: {
  baseRef: string;
  target: string;
  language: MultisdkLanguage;
}): string {
  const targetName = basename(input.target).replace(/\.[^.]+$/, '');
  const baseBranch = branchNameFromRef(input.baseRef);
  return `docs/${slugify(`${targetName}-${input.language}-${baseBranch}`)}`;
}

export function buildCleanBranchPlan(input: {
  baseRef: string;
  branch: string;
  target: string;
  commitMessage: string;
}): CleanBranchPlan {
  const parsedBase = parseRemoteRef(input.baseRef);
  const commands = parsedBase
    ? [
      ['git', 'fetch', parsedBase.remote, parsedBase.branch],
      ['git', 'switch', '-c', input.branch, input.baseRef],
      ['git', 'add', input.target],
      ['git', 'commit', '-m', input.commitMessage]
    ]
    : [
      ['git', 'fetch'],
      ['git', 'switch', '-c', input.branch, input.baseRef],
      ['git', 'add', input.target],
      ['git', 'commit', '-m', input.commitMessage]
    ];

  return {
    baseRef: input.baseRef,
    branch: input.branch,
    target: input.target,
    commitMessage: input.commitMessage,
    commands
  };
}

export function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim().replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  const parts = trimmed.split('/').filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function parseRemoteRef(ref: string): { remote: string; branch: string } | null {
  const parts = ref.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return {
    remote: parts[0],
    branch: parts.slice(1).join('/')
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'multisdk-docs';
}
