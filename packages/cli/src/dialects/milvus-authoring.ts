import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../core/hash.js';
import type {
  DialectDiagnostic,
  DialectDependency,
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
import { isProtectedOffset, lineAndColumnAt, protectedCodeRanges } from './source-lines.js';

export async function preprocessMilvusAuthoring(input: {
  cwd: string;
  sourcePath: string;
  markdown: string;
  config: DialectWorkspaceConfig;
  linkResolver?: DocumentLinkResolver;
}): Promise<DialectResult> {
  const frontmatter = parseLeadingFrontmatter(input.markdown);
  const sourceRoot = await resolveSourceRoot(input.cwd, input.sourcePath, input.config.sourceRoot);
  const dependencyMap = new Map<string, DialectDependency>();
  const values = deepMerge(
    await loadVariables(sourceRoot, path.dirname(input.sourcePath), dependencyMap),
    frontmatter.data
  );
  const blockers: DialectDiagnostic[] = [];
  const warnings: DialectDiagnostic[] = [];
  const expanded = await expandDocument({
    markdown: frontmatter.body,
    sourcePath: input.sourcePath,
    sourceRoot,
    values,
    stack: [],
    referenceChain: [],
    dependencies: dependencyMap,
    blockers
  });

  let markdown = dedentMilvusListFences(await stripMultipleCodeSelectors(expanded));
  if (blockers.length === 0) {
    const unsupported = firstUnsupportedDirective(markdown, input.sourcePath);
    if (unsupported) blockers.push(unsupported);
  }

  const resolvedLinks: ResolvedDocumentLink[] = [];
  const linkResolution = emptyLinkSummary();
  if (blockers.length === 0) {
    const linkResult = await resolveMilvusLinks({
      markdown,
      sourcePath: input.sourcePath,
      config: input.config,
      linkResolver: input.linkResolver
    });
    markdown = linkResult.markdown;
    warnings.push(...linkResult.warnings);
    blockers.push(...linkResult.blockers);
    resolvedLinks.push(...linkResult.resolvedLinks);
    Object.assign(linkResolution, linkResult.linkResolution);
  }

  return {
    dialect: 'milvus-authoring',
    markdown,
    metadata: frontmatter.data,
    warnings,
    blockers: blockers.slice(0, 1),
    dependencies: [...dependencyMap.values()].sort((left, right) => left.identity.localeCompare(right.identity)),
    resolvedLinks,
    linkResolution
  };
}

async function stripMultipleCodeSelectors(markdown: string): Promise<string> {
  return replaceUnprotectedMatches(
    markdown,
    /<div\b[^>]*>[\s\S]*?<\/div\s*>/gi,
    async (match) => {
      const opening = match[0].match(/^<div\b([^>]*)>/i);
      const classMatch = opening?.[1]?.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
      const classes = (classMatch?.[2] ?? '').split(/\s+/).map((value) => value.toLowerCase());
      if (!classes.includes('multiplecode')) return match[0];

      const body = match[0]
        .replace(/^<div\b[^>]*>/i, '')
        .replace(/<\/div\s*>$/i, '');
      const unsupported = body.replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, '').trim();
      return unsupported === '' ? '' : match[0];
    }
  );
}

function dedentMilvusListFences(markdown: string): string {
  const lines = markdown.split('\n');
  const ranges: Array<{ start: number; end: number; indentation: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]?.match(/^( {4,})(`{3,}|~{3,})[^\n]*$/);
    if (!opening) continue;

    const indentation = opening[1]!;
    if (!belongsToListItem(lines, index, indentation)) continue;
    const fence = opening[2]!;
    const marker = fence[0]!;
    let closing = index + 1;
    while (closing < lines.length) {
      const candidate = lines[closing]?.match(/^ {4,}(`+|~+)[ \t]*$/);
      if (candidate?.[1]?.[0] === marker && candidate[1].length >= fence.length) break;
      closing += 1;
    }
    if (closing >= lines.length) continue;
    ranges.push({ start: index, end: closing, indentation });
    index = closing;
  }
  for (const range of ranges) {
    for (let lineIndex = range.start; lineIndex <= range.end; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      if (line.startsWith(range.indentation)) {
        lines[lineIndex] = line.slice(range.indentation.length);
      }
    }
  }
  return lines.join('\n');
}

function belongsToListItem(lines: string[], index: number, indentation: string): boolean {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const line = lines[previous] ?? '';
    if (line.trim() === '' || line.startsWith(indentation)) continue;
    return /^\s*(?:\d+\.|[-+*])\s+/.test(line);
  }
  return false;
}

async function resolveSourceRoot(cwd: string, sourcePath: string, configured?: string): Promise<string> {
  if (configured) return path.resolve(cwd, configured);
  let current = path.dirname(sourcePath);
  const root = path.parse(current).root;
  while (true) {
    if (await readableFile(path.join(current, 'Variables.json'))) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  return path.dirname(sourcePath);
}

async function loadVariables(
  sourceRoot: string,
  sourceDirectory: string,
  dependencies: Map<string, DialectDependency>
): Promise<Record<string, unknown>> {
  const relative = path.relative(sourceRoot, sourceDirectory);
  const parts = relative === '' ? [] : relative.split(path.sep);
  let current = sourceRoot;
  let values: Record<string, unknown> = {};
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const variablePath = path.join(current, 'Variables.json');
    let raw: string;
    try {
      raw = await readFile(variablePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error(`${variablePath} must contain a JSON object.`);
    values = deepMerge(values, parsed);
    dependencies.set(variablePath, {
      kind: 'file',
      identity: variablePath,
      fingerprint: sha256(raw)
    });
  }
  return values;
}

async function expandDocument(input: {
  markdown: string;
  sourcePath: string;
  sourceRoot: string;
  values: Record<string, unknown>;
  stack: string[];
  referenceChain: SourceLocation[];
  dependencies: Map<string, DialectDependency>;
  blockers: DialectDiagnostic[];
}): Promise<string> {
  let markdown = await replaceUnprotectedMatches(
    input.markdown,
    /\{\{fragments\/([^}\n]+)\}\}/g,
    async (match, offset) => {
      const location = locationAt(input.sourcePath, input.markdown, offset);
      const fragmentRoot = path.join(input.sourceRoot, 'fragments');
      const fragmentPath = path.resolve(fragmentRoot, match[1]?.trim() ?? '');
      if (fragmentPath !== fragmentRoot && !fragmentPath.startsWith(`${fragmentRoot}${path.sep}`)) {
        input.blockers.push({
          code: 'missing-milvus-fragment',
          severity: 'blocker',
          message: `Milvus fragment path escapes the fragment root: ${match[1]}`,
          location,
          referenceChain: [...input.referenceChain, location]
        });
        return match[0];
      }
      if (input.stack.includes(fragmentPath)) {
        input.blockers.push({
          code: 'milvus-fragment-cycle',
          severity: 'blocker',
          message: `Milvus fragment cycle: ${[...input.stack, fragmentPath].join(' -> ')}`,
          location,
          referenceChain: [...input.referenceChain, location]
        });
        return match[0];
      }
      let raw: string;
      try {
        raw = await readFile(fragmentPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        input.blockers.push({
          code: 'missing-milvus-fragment',
          severity: 'blocker',
          message: `Milvus fragment does not exist: ${fragmentPath}`,
          location,
          referenceChain: [...input.referenceChain, location]
        });
        return match[0];
      }
      input.dependencies.set(fragmentPath, {
        kind: 'file',
        identity: fragmentPath,
        fingerprint: sha256(raw)
      });
      return expandDocument({
        ...input,
        markdown: raw,
        sourcePath: fragmentPath,
        stack: [...input.stack, fragmentPath],
        referenceChain: [...input.referenceChain, location]
      });
    }
  );

  markdown = await replaceUnprotectedMatches(
    markdown,
    /\{\{var\.([A-Za-z0-9_.-]+)\}\}/g,
    async (match, offset) => {
      const value = variableAtPath(input.values, match[1] ?? '');
      if (value === undefined) {
        const location = locationAt(input.sourcePath, markdown, offset);
        input.blockers.push({
          code: 'missing-milvus-variable',
          severity: 'blocker',
          message: `Milvus variable is not defined: ${match[1]}`,
          location,
          referenceChain: [...input.referenceChain, location]
        });
        return match[0];
      }
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(value);
    }
  );
  return markdown;
}

async function replaceUnprotectedMatches(
  markdown: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray, offset: number) => Promise<string>
): Promise<string> {
  const ranges = protectedCodeRanges(markdown);
  const matches = [...markdown.matchAll(pattern)].filter((match) => {
    return !isProtectedOffset(match.index ?? 0, ranges);
  });
  const replacements = await Promise.all(matches.map(async (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    value: await replace(match, match.index ?? 0)
  })));
  return replacements.sort((left, right) => right.start - left.start).reduce((current, item) => {
    return current.slice(0, item.start) + item.value + current.slice(item.end);
  }, markdown);
}

function firstUnsupportedDirective(markdown: string, sourcePath: string): DialectDiagnostic | undefined {
  const ranges = protectedCodeRanges(markdown);
  for (const match of markdown.matchAll(/\{\{([^}\n]+)\}\}/g)) {
    const offset = match.index ?? 0;
    if (isProtectedOffset(offset, ranges)) continue;
    return {
      code: 'unsupported-milvus-directive',
      severity: 'blocker',
      message: `Unsupported Milvus authoring directive: {{${match[1]}}}`,
      location: locationAt(sourcePath, markdown, offset)
    };
  }
  return undefined;
}

async function resolveMilvusLinks(input: {
  markdown: string;
  sourcePath: string;
  config: DialectWorkspaceConfig;
  linkResolver?: DocumentLinkResolver;
}): Promise<{
  markdown: string;
  warnings: DialectDiagnostic[];
  blockers: DialectDiagnostic[];
  resolvedLinks: ResolvedDocumentLink[];
  linkResolution: LinkResolutionSummary;
}> {
  const warnings: DialectDiagnostic[] = [];
  const blockers: DialectDiagnostic[] = [];
  const resolvedLinks: ResolvedDocumentLink[] = [];
  const replacements: Array<{ startOffset: number; endOffset: number; url: string }> = [];
  const linkResolution = emptyLinkSummary();
  for (const link of markdownDocumentLinks(input.markdown)) {
    if (!isRelativeDocumentUrl(link.url)) continue;
    const parsed = parseMilvusLink(link.url);
    const location = { file: input.sourcePath, line: link.line, column: link.column };
    if (!parsed.slug) {
      blockers.push(unresolvedLink(link.url, location));
      linkResolution.unresolved += 1;
      continue;
    }
    const resolverResult = input.linkResolver
      ? await input.linkResolver.resolve({ slug: parsed.slug, originalUrl: link.url, location })
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
      continue;
    }
    if (resolverResult.diagnostics.some(({ severity }) => severity === 'blocker')) {
      linkResolution.unresolved += 1;
      continue;
    }
    if (input.config.publicSiteBaseUrl) {
      const base = input.config.publicSiteBaseUrl.replace(/\/$/, '');
      const resolvedUrl = `${base}/${parsed.publicPath}${parsed.fragment ? `#${parsed.fragment}` : ''}`;
      const resolved: ResolvedDocumentLink = {
        originalUrl: link.url,
        slug: parsed.slug,
        resolvedUrl,
        source: 'public-site',
        location
      };
      replacements.push({
        startOffset: link.destinationStartOffset,
        endOffset: link.destinationEndOffset,
        url: resolvedUrl
      });
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
    blockers.push(unresolvedLink(link.url, location));
    linkResolution.unresolved += 1;
  }
  return {
    markdown: applyUrlReplacements(input.markdown, replacements),
    warnings,
    blockers,
    resolvedLinks,
    linkResolution
  };
}

function parseMilvusLink(url: string): { slug?: string; publicPath: string; fragment?: string } {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex === -1 ? undefined : url.slice(hashIndex + 1) || undefined;
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const publicPath = withoutHash.split('?')[0]?.replace(/^\.\//, '') ?? '';
  const fileName = publicPath.split('/').filter(Boolean).at(-1) ?? '';
  const slug = fileName.replace(/\.(?:md|mdx)$/i, '').trim();
  return { slug: slug || undefined, publicPath, fragment };
}

function unresolvedLink(url: string, location: SourceLocation): DialectDiagnostic {
  return {
    code: 'relative-link-unresolved',
    severity: 'blocker',
    message: `Cannot resolve Milvus document link: ${url}`,
    location
  };
}

function variableAtPath(values: Record<string, unknown>, variablePath: string): unknown {
  return variablePath.split('.').reduce<unknown>((current, key) => {
    return current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }, values);
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = isRecord(merged[key]) && isRecord(value)
      ? deepMerge(merged[key], value)
      : value;
  }
  return merged;
}

function locationAt(sourcePath: string, markdown: string, offset: number): SourceLocation {
  return { file: sourcePath, ...lineAndColumnAt(markdown, offset) };
}

async function readableFile(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
