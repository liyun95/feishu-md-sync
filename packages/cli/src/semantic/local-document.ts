import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import { findNextFencedCode, type CodeBlockIssue } from '../code-blocks/code-markdown.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { parseHtmlTable } from './html-table.js';
import { parseHtmlCallout } from './html-callout.js';
import { splitMarkdownImageBlocks } from './markdown-image.js';
import { semanticHash } from './normalize.js';
import type { SemanticDocument, SemanticLocator, SemanticNode } from './types.js';

type LocalSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'asset'; alt: string; source: string }
  | { kind: 'code'; content: string; sourceLanguage: string; resolvedLanguage: string; issues: CodeBlockIssue[] }
  | { kind: 'table'; content: string }
  | { kind: 'callout'; content: string }
  | { kind: 'opaque'; content: string; description: string };

export function localSemanticDocument(
  markdown: string,
  codeBlocks: CodeBlockConfig = DEFAULT_CODE_BLOCK_CONFIG
): SemanticDocument {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const { frontmatter, body } = extractFrontmatter(normalized);
  const nodes: SemanticNode[] = [];
  const headingPath: string[] = [];
  const ordinals = new Map<string, number>();

  if (frontmatter) {
    nodes.push({
      kind: 'opaque',
      locator: nextLocator(headingPath, 'opaque', ordinals),
      description: 'local YAML frontmatter',
      fingerprint: semanticHash(frontmatter)
    });
  }

  for (const segment of splitLocalSegments(body, codeBlocks)) {
    if (segment.kind === 'asset') {
      nodes.push({
        kind: 'asset',
        locator: nextLocator(headingPath, 'asset', ordinals),
        representation: 'image',
        alt: segment.alt,
        source: segment.source
      });
      continue;
    }
    if (segment.kind === 'code') {
      nodes.push({
        kind: 'code',
        locator: nextLocator(headingPath, 'code', ordinals),
        content: segment.content,
        sourceLanguage: segment.sourceLanguage,
        resolvedLanguage: segment.resolvedLanguage,
        issues: segment.issues
      });
      continue;
    }
    if (segment.kind === 'table') {
      nodes.push(parseHtmlTable(segment.content, nextLocator(headingPath, 'table', ordinals)));
      continue;
    }
    if (segment.kind === 'callout') {
      nodes.push(parseHtmlCallout(segment.content, nextLocator(headingPath, 'callout', ordinals)));
      continue;
    }
    if (segment.kind === 'opaque') {
      nodes.push({
        kind: 'opaque',
        locator: nextLocator(headingPath, 'opaque', ordinals),
        description: segment.description,
        fingerprint: semanticHash(segment.content)
      });
      continue;
    }

    for (const block of markdownToFeishuBlocks(segment.content)) {
      const rendered = feishuBlocksToMarkdown([block]).trim();
      if (!rendered) continue;
      if (block.block_type >= 3 && block.block_type <= 8) {
        const level = block.block_type - 2;
        const title = rendered.replace(/^#{1,6}\s+/, '').trim();
        headingPath.length = level - 1;
        headingPath[level - 1] = title;
      }
      nodes.push({
        kind: 'text',
        locator: nextLocator(headingPath, 'text', ordinals),
        blockType: block.block_type,
        markdown: rendered
      });
    }
  }

  return { nodes };
}

function extractFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  const match = markdown.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (!match) return { body: markdown };
  return {
    frontmatter: match[0],
    body: markdown.slice(match[0].length)
  };
}

function splitLocalSegments(markdown: string, codeBlocks: CodeBlockConfig): LocalSegment[] {
  const segments: LocalSegment[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const tail = markdown.slice(cursor);
    const openingIndex = tail.search(/<(table|div)\b/i);
    const code = findNextFencedCode(markdown, cursor, codeBlocks);
    const indentedCode = findNextIndentedFence(markdown, cursor);
    const htmlIndex = openingIndex === -1 ? -1 : cursor + openingIndex;
    if (indentedCode &&
      (!code || indentedCode.start < code.start) &&
      (htmlIndex === -1 || indentedCode.start < htmlIndex)) {
      pushMarkdown(segments, markdown.slice(cursor, indentedCode.start));
      segments.push({
        kind: 'opaque',
        content: markdown.slice(indentedCode.start, indentedCode.end),
        description: 'unsupported indented fenced Code block'
      });
      cursor = indentedCode.end;
      continue;
    }
    if (code && (htmlIndex === -1 || code.start < htmlIndex) &&
      (!indentedCode || code.start < indentedCode.start)) {
      pushMarkdown(segments, markdown.slice(cursor, code.start));
      segments.push({
        kind: 'code',
        content: code.content,
        sourceLanguage: code.sourceLanguage,
        resolvedLanguage: code.resolvedLanguage,
        issues: code.issues
      });
      cursor = code.end;
      continue;
    }
    if (openingIndex === -1) {
      pushMarkdown(segments, tail);
      break;
    }

    pushMarkdown(segments, tail.slice(0, openingIndex));
    const start = cursor + openingIndex;
    const opening = markdown.slice(start).match(/^<(table|div)\b/i);
    const tag = opening?.[1]?.toLowerCase();
    if (!tag) {
      pushMarkdown(segments, markdown.slice(start, start + 1));
      cursor = start + 1;
      continue;
    }

    const rest = markdown.slice(start);
    const closeMatch = rest.match(new RegExp(`</${tag}\\s*>`, 'i'));
    if (!closeMatch || closeMatch.index === undefined) {
      segments.push({
        kind: 'opaque',
        content: rest,
        description: tag === 'table' ? 'unterminated HTML table' : `unsupported local HTML container: ${tag}`
      });
      break;
    }

    const end = start + closeMatch.index + closeMatch[0].length;
    const content = markdown.slice(start, end);
    segments.push(tag === 'table'
      ? { kind: 'table', content }
      : isCalloutDiv(content)
        ? { kind: 'callout', content }
        : { kind: 'opaque', content, description: `unsupported local HTML container: ${tag}` });
    cursor = end;
  }

  return segments;
}

function findNextIndentedFence(markdown: string, from: number): { start: number; end: number } | undefined {
  const pattern = /(^|\n)( {4,})(`{3,}|~{3,})[^\n]*(?:\n|$)/g;
  pattern.lastIndex = from;
  const opening = pattern.exec(markdown);
  if (!opening) return undefined;
  const start = opening.index + (opening[1] ? 1 : 0);
  const fence = opening[3]!;
  const marker = fence[0];
  let lineStart = pattern.lastIndex;
  while (lineStart <= markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? markdown.length : lineEnd;
    const line = markdown.slice(lineStart, end);
    const closing = line.match(/^ {4,}(`+|~+)[ \t]*$/);
    if (closing?.[1]?.[0] === marker && closing[1].length >= fence.length) {
      return { start, end: lineEnd === -1 ? end : lineEnd + 1 };
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return { start, end: markdown.length };
}

function isCalloutDiv(content: string): boolean {
  const opening = content.match(/^<div\b([^>]*)>/i);
  const classMatch = opening?.[1]?.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  const classes = (classMatch?.[2] ?? '').split(/\s+/).map((value) => value.toLowerCase());
  return classes.includes('alert') && (classes.includes('note') || classes.includes('warning'));
}

function pushMarkdown(segments: LocalSegment[], content: string): void {
  for (const segment of splitMarkdownImageBlocks(content)) {
    if (segment.kind === 'image') {
      segments.push({ kind: 'asset', alt: segment.alt, source: segment.source });
      continue;
    }
    const markdown = segment.content;
    if (markdown.trim()) segments.push({ kind: 'markdown', content: markdown });
  }
}

function nextLocator(
  sectionPath: string[],
  kind: SemanticLocator['kind'],
  ordinals: Map<string, number>
): SemanticLocator {
  const stablePath = sectionPath.filter((part): part is string => typeof part === 'string');
  const key = `${kind}:${JSON.stringify(stablePath)}`;
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  return { sectionPath: stablePath, kind, ordinal };
}
