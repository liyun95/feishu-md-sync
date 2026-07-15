import type { DialectDiagnostic, DialectResult } from './types.js';
import { parseLeadingFrontmatter } from './frontmatter.js';
import { isRelativeDocumentUrl, markdownDocumentLinks } from './markdown-links.js';
import { isProtectedOffset, lineAndColumnAt, protectedCodeRanges } from './source-lines.js';

const EMPTY_LINK_SUMMARY = {
  resolvedToFeishu: 0,
  resolvedFromFreshCache: 0,
  resolvedFromStaleCache: 0,
  resolvedToPublicSite: 0,
  unresolved: 0
};

export function preprocessGfm(input: {
  sourcePath: string;
  markdown: string;
}): DialectResult {
  const warnings: DialectDiagnostic[] = [];
  const blockers: DialectDiagnostic[] = [];
  const frontmatter = parseLeadingFrontmatter(input.markdown);
  if (frontmatter.raw) {
    warnings.push({
      code: 'dialect-suggestion',
      severity: 'warning',
      message: 'Leading YAML frontmatter is preserved under gfm; select a site dialect to exclude it from Feishu.',
      location: { file: input.sourcePath, line: 1, column: 1 }
    });
  }
  for (const link of markdownDocumentLinks(input.markdown)) {
    if (!isRelativeDocumentUrl(link.url)) continue;
    warnings.push({
      code: 'relative-link-unresolved',
      severity: 'warning',
      message: `Relative document link is preserved under gfm: ${link.url}`,
      location: { file: input.sourcePath, line: link.line, column: link.column }
    });
  }

  const protectedRanges = protectedCodeRanges(input.markdown);
  const componentPattern = /<\/?([A-Z][A-Za-z0-9.]*)\b[^>]*>/g;
  for (const match of input.markdown.matchAll(componentPattern)) {
    const offset = match.index ?? 0;
    if (isProtectedOffset(offset, protectedRanges)) continue;
    const location = lineAndColumnAt(input.markdown, offset);
    blockers.push({
      code: 'unsupported-mdx-component',
      severity: 'blocker',
      message: `Unsupported structural component <${match[1]}> under gfm.`,
      location: { file: input.sourcePath, ...location }
    });
  }

  return {
    dialect: 'gfm',
    markdown: input.markdown,
    metadata: {},
    warnings,
    blockers,
    dependencies: [],
    resolvedLinks: [],
    linkResolution: {
      ...EMPTY_LINK_SUMMARY,
      unresolved: warnings.filter(({ code }) => code === 'relative-link-unresolved').length
    }
  };
}
