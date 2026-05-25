import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCodeBlockLanguage, type CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';
import type { ReleaseSdk, SdkTagMatrix } from './sdk-tags.js';

export type VariablesAudit = {
  passed: boolean;
  changes: Array<{
    sdk: ReleaseSdk;
    variable: string;
    currentValue: string | null;
    expectedValue: string | null;
    status: 'match' | 'change' | 'missing' | 'blocked';
  }>;
};

export type ReleaseNotesAudit = {
  passed: boolean;
  sectionExists: boolean;
  proposedSection: string;
  message: string;
};

export type LinkTarget = {
  keyword: string;
  localPath: string;
  anchor: string;
  requiredLanguages?: string[];
};

export type LinkLanguageIssue = {
  language: CanonicalCodeBlockLanguage;
  line?: number;
  placeholder?: string;
};

export type LinkAudit = {
  passed: boolean;
  items: Array<
    LinkTarget & {
      bulletFound: boolean;
      fileExists: boolean;
      anchorExists: boolean;
      requiredLanguages: CanonicalCodeBlockLanguage[];
      missingLanguages: LinkLanguageIssue[];
      placeholderIssues: LinkLanguageIssue[];
      status: 'ok' | 'missing-bullet' | 'missing-file' | 'missing-anchor' | 'missing-language' | 'placeholder';
    }
  >;
};

export function auditVariables(input: {
  variablesJson: string;
  matrix: SdkTagMatrix;
  variableNames: Partial<Record<ReleaseSdk, string>>;
}): VariablesAudit {
  const variables = JSON.parse(input.variablesJson) as Record<string, unknown>;
  const changes = input.matrix.rows.map((row) => {
    const variable = input.variableNames[row.sdk] ?? `${row.sdk}_version`;
    const rawCurrentValue = variables[variable];
    const currentValue = typeof rawCurrentValue === 'string' ? rawCurrentValue : null;
    const expectedValue = row.variablesValue;

    if (row.status === 'blocked') {
      return {
        sdk: row.sdk,
        variable,
        currentValue,
        expectedValue,
        status: 'blocked' as const
      };
    }
    if (currentValue === null) {
      return {
        sdk: row.sdk,
        variable,
        currentValue,
        expectedValue,
        status: 'missing' as const
      };
    }
    return {
      sdk: row.sdk,
      variable,
      currentValue,
      expectedValue,
      status: currentValue === expectedValue ? ('match' as const) : ('change' as const)
    };
  });

  return {
    passed: changes.every((change) => change.status === 'match'),
    changes
  };
}

export function auditReleaseNotes(input: {
  releaseVersion: string;
  localMarkdown: string;
  remoteMarkdown: string;
}): ReleaseNotesAudit {
  const heading = `## v${input.releaseVersion}`;
  const sectionExists = input.localMarkdown
    .split(/\r?\n/)
    .some((line) => line.trim() === heading);
  const proposedSection = ensureReleaseHeading(input.remoteMarkdown, heading);

  return {
    passed: sectionExists,
    sectionExists,
    proposedSection,
    message: sectionExists
      ? `Release notes already contain ${heading}.`
      : `Release notes need a new ${heading} section.`
  };
}

export async function auditLinks(input: {
  milvusDocsPath: string;
  releaseMarkdown: string;
  linkTargets: LinkTarget[];
}): Promise<LinkAudit> {
  const items: LinkAudit['items'] = [];
  for (const target of input.linkTargets) {
    const bulletFound = input.releaseMarkdown.includes(target.keyword);
    let fileExists = false;
    let anchorExists = false;
    let markdown = '';

    try {
      const content = await readFile(join(input.milvusDocsPath, target.localPath), 'utf8');
      markdown = content;
      fileExists = true;
      anchorExists = markdownHeadingAnchors(content).has(target.anchor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const requiredLanguages = normalizeRequiredLanguages(target.requiredLanguages ?? []);
    const coverage = fileExists && anchorExists
      ? auditRequiredLanguages(markdown, target.anchor, requiredLanguages)
      : { missingLanguages: [], placeholderIssues: [] };

    items.push({
      ...target,
      bulletFound,
      fileExists,
      anchorExists,
      requiredLanguages,
      missingLanguages: coverage.missingLanguages,
      placeholderIssues: coverage.placeholderIssues,
      status: linkStatus({
        bulletFound,
        fileExists,
        anchorExists,
        missingLanguages: coverage.missingLanguages,
        placeholderIssues: coverage.placeholderIssues
      })
    });
  }

  return {
    passed: items.every((item) => item.status === 'ok'),
    items
  };
}

export function markdownHeadingAnchor(heading: string): string {
  return heading.split('|', 1)[0]
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function ensureReleaseHeading(markdown: string, heading: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) return `${heading}\n`;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine === heading) return `${trimmed}\n`;
  return `${heading}\n\n${trimmed}\n`;
}

function markdownHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) anchors.add(markdownHeadingAnchor(match[2]));
  }
  return anchors;
}

function linkStatus(input: {
  bulletFound: boolean;
  fileExists: boolean;
  anchorExists: boolean;
  missingLanguages?: LinkLanguageIssue[];
  placeholderIssues?: LinkLanguageIssue[];
}): LinkAudit['items'][number]['status'] {
  if (!input.bulletFound) return 'missing-bullet';
  if (!input.fileExists) return 'missing-file';
  if (!input.anchorExists) return 'missing-anchor';
  if ((input.missingLanguages ?? []).length > 0) return 'missing-language';
  if ((input.placeholderIssues ?? []).length > 0) return 'placeholder';
  return 'ok';
}

function normalizeRequiredLanguages(values: string[]): CanonicalCodeBlockLanguage[] {
  const normalized: CanonicalCodeBlockLanguage[] = [];
  for (const value of values) {
    const language = normalizeReleaseLanguage(value);
    if (language && !normalized.includes(language)) normalized.push(language);
  }
  return normalized;
}

function normalizeReleaseLanguage(value: string): CanonicalCodeBlockLanguage | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'curl' || normalized === 'bash' || normalized === 'shell' || normalized === 'http') {
    return 'restful';
  }
  return normalizeCodeBlockLanguage(normalized);
}

function auditRequiredLanguages(
  markdown: string,
  anchor: string,
  requiredLanguages: CanonicalCodeBlockLanguage[]
): {
  missingLanguages: LinkLanguageIssue[];
  placeholderIssues: LinkLanguageIssue[];
} {
  if (requiredLanguages.length === 0) {
    return { missingLanguages: [], placeholderIssues: [] };
  }

  const section = markdownSectionForAnchor(markdown, anchor);
  const blocks = markdownCodeBlocks(section.content, section.startLine);
  const missingLanguages = requiredLanguages
    .filter((language) => !blocks.some((block) => block.language === language))
    .map((language) => ({ language }));
  const placeholderIssues = blocks
    .filter((block) => requiredLanguages.includes(block.language) && placeholderForLanguage(block.text, block.language))
    .map((block) => ({
      language: block.language,
      line: block.line,
      placeholder: placeholderForLanguage(block.text, block.language)
    }));

  return { missingLanguages, placeholderIssues };
}

function markdownSectionForAnchor(markdown: string, anchor: string): { content: string; startLine: number } {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let level = 0;
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^```/.test(lines[index].trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (!match) continue;
    if (markdownHeadingAnchor(match[2]) === anchor) {
      start = index;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) return { content: markdown, startLine: 1 };

  let end = lines.length;
  inFence = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^```/.test(lines[index].trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (match && match[1].length <= level) {
      end = index;
      break;
    }
  }

  return {
    content: lines.slice(start, end).join('\n'),
    startLine: start + 1
  };
}

function markdownCodeBlocks(markdown: string, startLine: number): Array<{
  language: CanonicalCodeBlockLanguage;
  text: string;
  line: number;
}> {
  const blocks: Array<{ language: CanonicalCodeBlockLanguage; text: string; line: number }> = [];
  const fence = /^```([^\s`]*)[^\n]*\n([\s\S]*?)^```/gm;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const rawLanguage = match[1] ?? '';
    const text = match[2] ?? '';
    const language = inferMarkdownCodeLanguage(rawLanguage, text);
    if (!language) continue;
    blocks.push({
      language,
      text,
      line: startLine + markdown.slice(0, match.index).split('\n').length - 1
    });
  }
  return blocks;
}

function inferMarkdownCodeLanguage(rawLanguage: string, text: string): CanonicalCodeBlockLanguage | null {
  const normalized = normalizeReleaseLanguage(rawLanguage);
  if (normalized) return normalized;
  const trimmed = text.trim().toLowerCase();
  if (trimmed.startsWith('curl ') || trimmed === '# restful') return 'restful';
  return null;
}

function placeholderForLanguage(text: string, language: CanonicalCodeBlockLanguage): string | undefined {
  const trimmed = text.trim().toLowerCase();
  const placeholders: Partial<Record<CanonicalCodeBlockLanguage, string[]>> = {
    java: ['// java'],
    javascript: ['// nodejs', '// js', '// javascript'],
    go: ['// go'],
    restful: ['# restful', '# rest', '# curl']
  };
  return placeholders[language]?.includes(trimmed) ? text.trim() : undefined;
}
