import type {
  DialectDiagnostic,
  DialectResult,
  SourceLocation
} from './types.js';
import type {
  DialectWorkspaceConfig,
  DocumentLinkResolver,
  LinkResolutionSummary,
  ResolvedDocumentLink
} from '../link-resolvers/types.js';
import { parseLeadingFrontmatter } from './frontmatter.js';
import {
  applyUrlReplacements,
  isRelativeDocumentUrl,
  markdownDocumentLinks
} from './markdown-links.js';
import {
  isProtectedOffset,
  lineAndColumnAt,
  protectedCodeRanges
} from './source-lines.js';

export async function preprocessDocusaurus(input: {
  sourcePath: string;
  markdown: string;
  config: DialectWorkspaceConfig;
  linkResolver?: DocumentLinkResolver;
}): Promise<DialectResult> {
  const frontmatter = parseLeadingFrontmatter(input.markdown);
  const bodyStartLineOffset = frontmatter.bodyStartLine - 1;
  const warnings: DialectDiagnostic[] = [];
  const blockers: DialectDiagnostic[] = [];
  const resolvedLinks: ResolvedDocumentLink[] = [];
  const linkResolution = emptyLinkSummary();

  const unsupported = firstUnsupportedConstruct({
    sourcePath: input.sourcePath,
    markdown: frontmatter.body,
    lineOffset: bodyStartLineOffset
  });
  if (unsupported) blockers.push(unsupported);

  const admonitions = convertAdmonitions({
    sourcePath: input.sourcePath,
    markdown: frontmatter.body,
    lineOffset: bodyStartLineOffset
  });
  if (admonitions.blocker && blockers.length === 0) blockers.push(admonitions.blocker);

  let markdown = stripHeadingAnchors(admonitions.markdown);
  const replacements: Array<{ startOffset: number; endOffset: number; url: string }> = [];
  for (const link of markdownDocumentLinks(markdown)) {
    if (!isRelativeDocumentUrl(link.url)) continue;
    const parsed = parseSourceLink(link.url);
    if (!parsed.slug) {
      blockers.push(relativeLinkBlocker({
        sourcePath: input.sourcePath,
        linkUrl: link.url,
        line: link.line + bodyStartLineOffset,
        column: link.column
      }));
      linkResolution.unresolved += 1;
      continue;
    }
    const location: SourceLocation = {
      file: input.sourcePath,
      line: link.line + bodyStartLineOffset,
      column: link.column
    };
    const resolverResult = input.linkResolver
      ? await input.linkResolver.resolve({
          slug: parsed.slug,
          originalUrl: link.url,
          location
        })
      : { diagnostics: [] };
    for (const diagnostic of resolverResult.diagnostics) {
      (diagnostic.severity === 'blocker' ? blockers : warnings).push(diagnostic);
    }
    if (resolverResult.resolved) {
      replacements.push({
        startOffset: link.destinationStartOffset,
        endOffset: link.destinationEndOffset,
        url: resolverResult.resolved.resolvedUrl
      });
      resolvedLinks.push(resolverResult.resolved);
      countResolvedLink(linkResolution, resolverResult.resolved);
      if (parsed.fragment) {
        warnings.push({
          code: 'relative-link-public-fallback',
          severity: 'warning',
          message: `Feishu cross-document links target the document root; heading fragment #${parsed.fragment} was removed.`,
          location
        });
      }
      continue;
    }
    if (resolverResult.diagnostics.some(({ severity }) => severity === 'blocker')) {
      linkResolution.unresolved += 1;
      continue;
    }
    if (input.config.publicSiteBaseUrl) {
      const resolvedUrl = publicSiteUrl(
        input.config.publicSiteBaseUrl,
        parsed.slug,
        parsed.fragment
      );
      replacements.push({
        startOffset: link.destinationStartOffset,
        endOffset: link.destinationEndOffset,
        url: resolvedUrl
      });
      const resolved: ResolvedDocumentLink = {
        originalUrl: link.url,
        slug: parsed.slug,
        resolvedUrl,
        source: 'public-site',
        location
      };
      resolvedLinks.push(resolved);
      countResolvedLink(linkResolution, resolved);
      warnings.push({
        code: 'relative-link-public-fallback',
        severity: 'warning',
        message: `No Feishu mapping exists for ${parsed.slug}; using public site URL ${resolvedUrl}.`,
        location
      });
      continue;
    }
    blockers.push(relativeLinkBlocker({
      sourcePath: input.sourcePath,
      linkUrl: link.url,
      line: location.line,
      column: location.column ?? 1
    }));
    linkResolution.unresolved += 1;
  }
  markdown = applyUrlReplacements(markdown, replacements);

  return {
    dialect: 'docusaurus',
    markdown,
    metadata: frontmatter.data,
    warnings,
    blockers: blockers.slice(0, 1),
    dependencies: [],
    resolvedLinks,
    linkResolution
  };
}

export function publicSiteUrl(baseUrl: string, slug: string, fragment?: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const path = slug.replace(/^\//, '');
  return `${base}/${path}${fragment ? `#${fragment}` : ''}`;
}

function firstUnsupportedConstruct(input: {
  sourcePath: string;
  markdown: string;
  lineOffset: number;
}): DialectDiagnostic | undefined {
  const ranges = protectedCodeRanges(input.markdown);
  const patterns: Array<{ pattern: RegExp; label: (match: RegExpMatchArray) => string }> = [
    {
      pattern: /^ {0,3}(?:import|export)\b.*$/gm,
      label: () => 'Docusaurus import/export statements are not supported.'
    },
    {
      pattern: /<\/?([A-Z][A-Za-z0-9.]*)\b[^>]*>/g,
      label: (match) => `Unsupported Docusaurus component <${match[1]}>.`
    },
    {
      pattern: /\{[A-Za-z_$][^}\n]*\}/g,
      label: () => 'Executable Docusaurus expressions are not supported.'
    }
  ];
  for (const { pattern, label } of patterns) {
    for (const match of input.markdown.matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (isProtectedOffset(offset, ranges)) continue;
      const position = lineAndColumnAt(input.markdown, offset);
      return {
        code: 'unsupported-mdx-component',
        severity: 'blocker',
        message: label(match),
        location: {
          file: input.sourcePath,
          line: position.line + input.lineOffset,
          column: position.column
        }
      };
    }
  }
  return undefined;
}

function convertAdmonitions(input: {
  sourcePath: string;
  markdown: string;
  lineOffset: number;
}): { markdown: string; blocker?: DialectDiagnostic } {
  const lines = input.markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const body = line.replace(/\r?\n$/, '');
    const fenceMatch = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      output.push(line);
      if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
      output.push(line);
      continue;
    }
    const opening = body.match(/^ {0,3}:::(\w+)(.*)$/);
    if (!opening) {
      output.push(line);
      continue;
    }
    const type = opening[1]?.toLowerCase();
    const suffix = opening[2]?.trim() ?? '';
    const location = { file: input.sourcePath, line: index + 1 + input.lineOffset, column: 1 };
    if (type !== 'note' && type !== 'warning' || suffix !== '') {
      return {
        markdown: input.markdown,
        blocker: {
          code: 'unsupported-docusaurus-admonition',
          severity: 'blocker',
          message: suffix
            ? `Custom Docusaurus admonition titles are not supported: :::${type}${opening[2]}`
            : `Unsupported Docusaurus admonition type: ${type}`,
          location
        }
      };
    }
    const content: string[] = [];
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const candidateBody = (lines[candidate] ?? '').replace(/\r?\n$/, '');
      if (/^ {0,3}:::\s*$/.test(candidateBody)) {
        closingIndex = candidate;
        break;
      }
      if (/^ {0,3}:::\w+/.test(candidateBody)) {
        return {
          markdown: input.markdown,
          blocker: {
            code: 'unsupported-docusaurus-admonition',
            severity: 'blocker',
            message: 'Nested Docusaurus admonitions are not supported.',
            location: { file: input.sourcePath, line: candidate + 1 + input.lineOffset, column: 1 }
          }
        };
      }
      content.push(lines[candidate] ?? '');
    }
    if (closingIndex === -1) {
      return {
        markdown: input.markdown,
        blocker: {
          code: 'unsupported-docusaurus-admonition',
          severity: 'blocker',
          message: `Docusaurus admonition :::${type} has no closing :::.`,
          location
        }
      };
    }
    const contentText = content.join('').replace(/\r?\n$/, '');
    const closingHadNewline = /\r?\n$/.test(lines[closingIndex] ?? '');
    output.push(
      `<div class="alert ${type}">\n\n${contentText}\n\n</div>${closingHadNewline ? '\n' : ''}`
    );
    index = closingIndex;
  }
  return { markdown: output.join('') };
}

function stripHeadingAnchors(markdown: string): string {
  const ranges = protectedCodeRanges(markdown);
  return markdown.replace(
    /^( {0,3}#{1,6}\s+.*?)[ \t]*\\?\{#[A-Za-z0-9_-]+\}[ \t]*$/gm,
    (match, heading: string, offset: number) => {
      return isProtectedOffset(offset, ranges) ? match : heading.trimEnd();
    }
  );
}

function parseSourceLink(url: string): { slug?: string; fragment?: string } {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? undefined : url.slice(hashIndex + 1) || undefined;
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  const parts = withoutQuery.replace(/\\/g, '/').split('/').filter(Boolean);
  let final = parts.at(-1) ?? '';
  final = final.replace(/\.(?:md|mdx)$/i, '');
  if (final === 'index') final = parts.at(-2) ?? '';
  try {
    final = decodeURIComponent(final);
  } catch {
    return { fragment };
  }
  const slug = final.trim().replace(/^\/+|\/+$/g, '');
  return { slug: slug || undefined, fragment };
}

function relativeLinkBlocker(input: {
  sourcePath: string;
  linkUrl: string;
  line: number;
  column: number;
}): DialectDiagnostic {
  return {
    code: 'relative-link-unresolved',
    severity: 'blocker',
    message: `Cannot resolve Docusaurus document link: ${input.linkUrl}`,
    location: {
      file: input.sourcePath,
      line: input.line,
      column: input.column
    }
  };
}

function emptyLinkSummary(): LinkResolutionSummary {
  return {
    resolvedToFeishu: 0,
    resolvedFromFreshCache: 0,
    resolvedFromStaleCache: 0,
    resolvedToPublicSite: 0,
    unresolved: 0
  };
}

function countResolvedLink(summary: LinkResolutionSummary, link: ResolvedDocumentLink): void {
  if (link.source === 'public-site') {
    summary.resolvedToPublicSite += 1;
    return;
  }
  summary.resolvedToFeishu += 1;
  if (link.source === 'fresh-cache') summary.resolvedFromFreshCache += 1;
  if (link.source === 'stale-cache') summary.resolvedFromStaleCache += 1;
}
