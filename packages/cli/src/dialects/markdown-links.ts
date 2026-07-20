import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { visit } from 'unist-util-visit';

export type MarkdownDocumentLink = {
  url: string;
  startOffset: number;
  endOffset: number;
  destinationStartOffset: number;
  destinationEndOffset: number;
  line: number;
  column: number;
};

export function markdownDocumentLinks(markdown: string): MarkdownDocumentLink[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  });
  const links: MarkdownDocumentLink[] = [];

  visit(tree, 'link', (node) => {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) return;
    const destination = destinationRange(markdown.slice(startOffset, endOffset), startOffset);
    if (!destination) return;
    const rawUrl = markdown.slice(destination.startOffset, destination.endOffset);
    if (normalizeDestination(rawUrl) !== normalizeDestination(node.url)) return;
    links.push({
      url: rawUrl,
      startOffset,
      endOffset,
      destinationStartOffset: destination.startOffset,
      destinationEndOffset: destination.endOffset,
      line: node.position?.start.line ?? 1,
      column: node.position?.start.column ?? 1
    });
  });
  return links;
}

export function applyUrlReplacements(
  markdown: string,
  replacements: Array<{ startOffset: number; endOffset: number; url: string }>
): string {
  return [...replacements]
    .sort((left, right) => right.startOffset - left.startOffset)
    .reduce((current, replacement) => {
      return current.slice(0, replacement.startOffset) +
        replacement.url +
        current.slice(replacement.endOffset);
    }, markdown);
}

export function isRelativeDocumentUrl(url: string): boolean {
  if (url.startsWith('#') || url.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  return !url.startsWith('//');
}

function destinationRange(raw: string, absoluteStart: number): { startOffset: number; endOffset: number } | undefined {
  const opener = raw.indexOf('](');
  if (opener === -1) return undefined;
  let cursor = opener + 2;
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  if (raw[cursor] === '<') {
    const closing = raw.indexOf('>', cursor + 1);
    return closing === -1
      ? undefined
      : { startOffset: absoluteStart + cursor + 1, endOffset: absoluteStart + closing };
  }
  const start = cursor;
  let escaping = false;
  while (cursor < raw.length) {
    const char = raw[cursor] ?? '';
    if (escaping) {
      escaping = false;
      cursor += 1;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      cursor += 1;
      continue;
    }
    if (char === ')' || /\s/.test(char)) break;
    cursor += 1;
  }
  return cursor === start
    ? undefined
    : { startOffset: absoluteStart + start, endOffset: absoluteStart + cursor };
}

function normalizeDestination(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
