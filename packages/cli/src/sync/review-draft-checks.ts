export type ReviewDraftCheckIssueKind =
  | 'frontmatter'
  | 'raw-html-block'
  | 'unwrapped-milvus'
  | 'local-link';

export type ReviewDraftCheckIssue = {
  kind: ReviewDraftCheckIssueKind;
  message: string;
};

export type ReviewDraftCheckReport = {
  passed: boolean;
  issues: ReviewDraftCheckIssue[];
};

export function analyzeReviewDraftChecks(markdown: string): ReviewDraftCheckReport {
  const withoutCode = stripFencedCode(markdown.replace(/\r\n/g, '\n'));
  const issues: ReviewDraftCheckIssue[] = [];

  if (/^---\n[\s\S]*?\n---(?:\n|$)/.test(withoutCode)) {
    issues.push({ kind: 'frontmatter', message: 'visible frontmatter remains in review draft' });
  }

  if (/<\s*(?:div|section|article|aside|details|summary|table)\b/i.test(withoutCode)) {
    issues.push({ kind: 'raw-html-block', message: 'raw HTML block remains in review draft' });
  }

  if (containsUnwrappedMilvus(withoutCode)) {
    issues.push({
      kind: 'unwrapped-milvus',
      message: 'standalone Milvus remains outside include tags, links, and code'
    });
  }

  for (const link of localMarkdownLinks(withoutCode)) {
    issues.push({
      kind: 'local-link',
      message: `local-only relative Markdown link remains in review draft: ${link}`
    });
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

export function reviewDraftCheckSummaryLines(report: ReviewDraftCheckReport): string[] {
  if (report.passed) return ['Review draft checks: passed'];
  return [
    'Review draft checks: failed',
    ...report.issues.map((issue) => `- ${issue.message}`)
  ];
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

function containsUnwrappedMilvus(markdown: string): boolean {
  return /\bMilvus(?:\s+\d+(?:\.\d+)*(?:\.x)?)?(?![-\w])/.test(protectInlineSpans(markdown));
}

function localMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const url = match[1].trim();
    if (isLocalReviewLink(url)) links.push(url);
  }
  return links;
}

function isLocalReviewLink(url: string): boolean {
  return url !== '' &&
    !url.startsWith('#') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
    !url.startsWith('//');
}

function protectInlineSpans(markdown: string): string {
  return markdown
    .replace(/<include\b[\s\S]*?<\/include>/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '');
}
