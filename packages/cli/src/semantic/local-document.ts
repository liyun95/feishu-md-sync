import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { parseHtmlTable } from './html-table.js';
import { semanticHash } from './normalize.js';
import type { SemanticDocument, SemanticLocator, SemanticNode } from './types.js';

type LocalSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'table'; content: string }
  | { kind: 'opaque'; content: string; description: string };

export function localSemanticDocument(markdown: string): SemanticDocument {
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

  for (const segment of splitLocalSegments(body)) {
    if (segment.kind === 'table') {
      nodes.push(parseHtmlTable(segment.content, nextLocator(headingPath, 'table', ordinals)));
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

function splitLocalSegments(markdown: string): LocalSegment[] {
  const segments: LocalSegment[] = [];
  let cursor = 0;

  while (cursor < markdown.length) {
    const tail = markdown.slice(cursor);
    const openingIndex = tail.search(/<(table|div)\b/i);
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
      : { kind: 'opaque', content, description: `unsupported local HTML container: ${tag}` });
    cursor = end;
  }

  return segments;
}

function pushMarkdown(segments: LocalSegment[], content: string): void {
  if (content.trim()) segments.push({ kind: 'markdown', content });
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
