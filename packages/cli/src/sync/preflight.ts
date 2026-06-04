import type { FeishuBlock } from '../feishu/types.js';

export type FeishuPreflightIssue = {
  kind: 'unsupported-link-url';
  blockIndex: number;
  path: string;
  url: string;
};

export class FeishuPreflightError extends Error {
  constructor(readonly issues: FeishuPreflightIssue[]) {
    super(formatPreflightError(issues));
    this.name = 'FeishuPreflightError';
  }
}

export function assertFeishuBlocksWritable(blocks: FeishuBlock[]): void {
  const issues = validateFeishuBlocksForWrite(blocks);
  if (issues.length > 0) {
    throw new FeishuPreflightError(issues);
  }
}

export function validateFeishuBlocksForWrite(blocks: FeishuBlock[]): FeishuPreflightIssue[] {
  const issues: FeishuPreflightIssue[] = [];

  blocks.forEach((block, blockIndex) => {
    visitValue(block, '', blockIndex, issues);
  });

  return issues;
}

export function assertMarkdownSourceSafeForLocalRenderer(markdown: string): void {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  if (/<\s*table\b/i.test(withoutCode)) {
    throw new Error(
      'Refusing to render raw HTML table Markdown with the local renderer. ' +
      'Use canonical Markdown table source, or use --markdown-engine official after dry-run safety checks pass.'
    );
  }

  if (/<\s*(?:div|section|article|aside|details|summary)\b/i.test(withoutCode)) {
    throw new Error(
      'Refusing to render raw HTML block Markdown with the local renderer. ' +
      'Convert site-specific HTML blocks to supported Markdown or use --markdown-engine official after dry-run safety checks pass.'
    );
  }

  const escapedEntityCount = (withoutCode.match(/\\&(?:lt|gt|amp|quot|#34|#39);/g) ?? []).length;
  const escapedPunctuationCount = (withoutCode.match(/\\[._\-()[\]{}]/g) ?? []).length;

  if (escapedEntityCount >= 2 || escapedPunctuationCount >= 12) {
    throw new Error(
      'Refusing to render likely raw escaped Feishu Markdown with the local renderer. ' +
      'Run pull again after official Markdown normalization, or use --markdown-engine official after dry-run safety checks pass.'
    );
  }
}

function visitValue(
  value: unknown,
  path: string,
  blockIndex: number,
  issues: FeishuPreflightIssue[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitValue(item, `${path}[${index}]`, blockIndex, issues);
    });
    return;
  }

  if (!isRecord(value)) return;

  const link = value.link;
  if (isRecord(link) && typeof link.url === 'string' && !isSupportedFeishuLinkUrl(link.url)) {
    issues.push({
      kind: 'unsupported-link-url',
      blockIndex,
      path: joinPath(joinPath(path, 'link'), 'url'),
      url: link.url
    });
  }

  for (const [key, child] of Object.entries(value)) {
    visitValue(child, joinPath(path, key), blockIndex, issues);
  }
}

function isSupportedFeishuLinkUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatPreflightError(issues: FeishuPreflightIssue[]): string {
  const lines = [
    `Feishu preflight failed with ${issues.length} issue(s). Generated blocks are not safe to write.`
  ];

  for (const issue of issues.slice(0, 10)) {
    lines.push(
      `- Block ${issue.blockIndex + 1} ${issue.path} has unsupported Feishu link URL "${issue.url}". ` +
      `Feishu link styles require absolute http(s) URLs; convert local links in the publish profile or remove the link before writing.`
    );
  }

  if (issues.length > 10) {
    lines.push(`- ${issues.length - 10} more issue(s) omitted.`);
  }

  return lines.join('\n');
}
