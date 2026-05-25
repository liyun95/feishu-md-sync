import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
};

export type LinkAudit = {
  passed: boolean;
  items: Array<
    LinkTarget & {
      bulletFound: boolean;
      fileExists: boolean;
      anchorExists: boolean;
      status: 'ok' | 'missing-bullet' | 'missing-file' | 'missing-anchor';
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

    try {
      const content = await readFile(join(input.milvusDocsPath, target.localPath), 'utf8');
      fileExists = true;
      anchorExists = markdownHeadingAnchors(content).has(target.anchor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    items.push({
      ...target,
      bulletFound,
      fileExists,
      anchorExists,
      status: linkStatus({ bulletFound, fileExists, anchorExists })
    });
  }

  return {
    passed: items.every((item) => item.status === 'ok'),
    items
  };
}

export function markdownHeadingAnchor(heading: string): string {
  return heading
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
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) anchors.add(markdownHeadingAnchor(match[2]));
  }
  return anchors;
}

function linkStatus(input: {
  bulletFound: boolean;
  fileExists: boolean;
  anchorExists: boolean;
}): LinkAudit['items'][number]['status'] {
  if (!input.bulletFound) return 'missing-bullet';
  if (!input.fileExists) return 'missing-file';
  if (!input.anchorExists) return 'missing-anchor';
  return 'ok';
}
