import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { normalizeCodeBlockLanguage, type CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';
import { unifiedDiff } from '../sync/diff.js';
import type { MultisdkLanguage } from './language.js';

export type MarkdownCodeBlock = {
  language: string;
  canonicalLanguage: CanonicalCodeBlockLanguage | 'restful' | null;
  code: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  openingFence: string;
  closingFence: string;
};

export type MultisdkDocsLandingPlan = {
  mode: 'dry-run' | 'write';
  language: MultisdkLanguage;
  repo: string;
  target: string;
  targetPath: string;
  reviewedBlocks: number;
  targetBlocks: number;
  replacedBlocks: number;
  verified: boolean;
  reviewedBaselinePath?: string;
  desiredMarkdown: string;
  diff: string;
};

export type PlanMultisdkDocsLandingOptions = {
  language: MultisdkLanguage;
  repo: string;
  target: string;
  reviewedMarkdown: string;
};

export type LandMultisdkDocsOptions = PlanMultisdkDocsLandingOptions & {
  taskDir: string;
  write: boolean;
};

export async function planMultisdkDocsLanding(
  options: PlanMultisdkDocsLandingOptions
): Promise<MultisdkDocsLandingPlan> {
  const targetPath = resolveRepoTarget(options.repo, options.target);
  const targetMarkdown = await readFile(targetPath, 'utf8');
  const reviewedBlocks = extractMarkdownCodeBlocks(options.reviewedMarkdown, options.language);
  const targetBlocks = extractMarkdownCodeBlocks(targetMarkdown, options.language);

  if (reviewedBlocks.length !== targetBlocks.length) {
    throw new Error(
      `reviewed ${options.language} blocks (${reviewedBlocks.length}) does not match target ${options.language} blocks (${targetBlocks.length}).`
    );
  }
  if (reviewedBlocks.length === 0) {
    throw new Error(`No ${options.language} code blocks found in reviewed baseline or target docs file.`);
  }

  const desiredMarkdown = patchCodeBlocks(targetMarkdown, targetBlocks, reviewedBlocks.map((block) => block.code));
  const verifiedBlocks = extractMarkdownCodeBlocks(desiredMarkdown, options.language);
  const verified = verifiedBlocks.length === reviewedBlocks.length &&
    verifiedBlocks.every((block, index) => block.code === reviewedBlocks[index].code);

  return {
    mode: 'dry-run',
    language: options.language,
    repo: options.repo,
    target: options.target,
    targetPath,
    reviewedBlocks: reviewedBlocks.length,
    targetBlocks: targetBlocks.length,
    replacedBlocks: reviewedBlocks.length,
    verified,
    desiredMarkdown,
    diff: unifiedDiff(options.target, 'reviewed-baseline', targetMarkdown, desiredMarkdown)
  };
}

export async function landMultisdkDocs(options: LandMultisdkDocsOptions): Promise<MultisdkDocsLandingPlan> {
  const plan = await planMultisdkDocsLanding(options);
  const reviewedBaselinePath = resolve(options.taskDir, 'inputs/feishu.reviewed-baseline.md');
  if (!options.write) {
    return {
      ...plan,
      reviewedBaselinePath
    };
  }

  if (!plan.verified) {
    throw new Error('Refusing to write docs landing because target block verification failed.');
  }

  await mkdir(dirname(plan.targetPath), { recursive: true });
  await mkdir(dirname(reviewedBaselinePath), { recursive: true });
  await Promise.all([
    writeFile(plan.targetPath, plan.desiredMarkdown, 'utf8'),
    writeFile(reviewedBaselinePath, options.reviewedMarkdown, 'utf8')
  ]);

  return {
    ...plan,
    mode: 'write',
    reviewedBaselinePath
  };
}

export function extractMarkdownCodeBlocks(markdown: string, language: MultisdkLanguage): MarkdownCodeBlock[] {
  return parseMarkdownCodeBlocks(markdown).filter((block) => blockMatchesLanguage(block, language));
}

function parseMarkdownCodeBlocks(markdown: string): MarkdownCodeBlock[] {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const blocks: MarkdownCodeBlock[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const lineStart = cursor === 0 ? 0 : normalized.indexOf('\n', cursor - 1) + 1;
    const fenceStart = normalized.indexOf('```', cursor);
    if (fenceStart < 0) break;
    if (fenceStart !== lineStart && normalized[fenceStart - 1] !== '\n') {
      cursor = fenceStart + 3;
      continue;
    }

    const openingLineEnd = normalized.indexOf('\n', fenceStart);
    if (openingLineEnd < 0) break;
    const openingFence = normalized.slice(fenceStart, openingLineEnd);
    const openingMatch = openingFence.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (!openingMatch) {
      cursor = openingLineEnd + 1;
      continue;
    }

    const closingMatch = findClosingFence(normalized, openingLineEnd + 1);
    if (!closingMatch) break;
    const code = normalized.slice(openingLineEnd + 1, closingMatch.start).replace(/\n$/, '');
    const language = openingMatch[1] ?? '';
    blocks.push({
      language,
      canonicalLanguage: canonicalFenceLanguage(language),
      code,
      start: fenceStart,
      end: closingMatch.end,
      contentStart: openingLineEnd + 1,
      contentEnd: closingMatch.start,
      openingFence,
      closingFence: closingMatch.fence
    });
    cursor = closingMatch.end;
  }

  return blocks;
}

function findClosingFence(markdown: string, start: number): { start: number; end: number; fence: string } | null {
  let cursor = start;
  while (cursor < markdown.length) {
    const lineEnd = markdown.indexOf('\n', cursor);
    const end = lineEnd < 0 ? markdown.length : lineEnd;
    const line = markdown.slice(cursor, end);
    if (/^```\s*$/.test(line)) {
      return {
        start: cursor,
        end: lineEnd < 0 ? end : end + 1,
        fence: line
      };
    }
    if (lineEnd < 0) return null;
    cursor = lineEnd + 1;
  }
  return null;
}

function blockMatchesLanguage(block: MarkdownCodeBlock, language: MultisdkLanguage): boolean {
  if (block.canonicalLanguage === language) return true;
  if (language !== 'restful') return false;
  return ['bash', 'shell', 'sh', 'curl'].includes(block.language.toLowerCase());
}

function canonicalFenceLanguage(value: string): CanonicalCodeBlockLanguage | 'restful' | null {
  const normalized = normalizeCodeBlockLanguage(value);
  if (normalized) return normalized;
  const lower = value.toLowerCase();
  if (['bash', 'shell', 'sh', 'curl'].includes(lower)) return 'restful';
  return null;
}

function patchCodeBlocks(markdown: string, targetBlocks: MarkdownCodeBlock[], replacements: string[]): string {
  let output = markdown.replace(/\r\n/g, '\n');
  for (let index = targetBlocks.length - 1; index >= 0; index -= 1) {
    const block = targetBlocks[index];
    const replacement = replacements[index];
    output = `${output.slice(0, block.contentStart)}${replacement}\n${output.slice(block.contentEnd)}`;
  }
  return output;
}

function resolveRepoTarget(repo: string, target: string): string {
  if (isAbsolute(target)) {
    throw new Error('--target must be relative to --repo.');
  }
  const repoRoot = resolve(repo);
  const targetPath = resolve(repoRoot, target);
  const relativeTarget = relative(repoRoot, targetPath);
  if (relativeTarget === '' || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
    throw new Error('--target must stay inside --repo.');
  }
  return targetPath;
}
