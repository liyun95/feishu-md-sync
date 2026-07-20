import { sha256, stableStringify } from '../core/hash.js';
import type { SemanticCell, SemanticInline } from './types.js';

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeHeading(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase('en-US');
}

export function inlinePlainText(inline: SemanticInline): string {
  return inline.kind === 'break' ? '\n' : inline.value;
}

export function cellPlainText(cell: SemanticCell): string {
  return cell.blocks.map((block) => {
    if (block.kind === 'paragraph') return block.inlines.map(inlinePlainText).join('');
    return block.items.map((item) => item.map(inlinePlainText).join('')).join(' ');
  }).join(' ');
}

export function normalizeRowKey(cell: SemanticCell): string {
  return normalizeWhitespace(cellPlainText(cell));
}

export function canonicalizeAuthoringIncludeMarkup(markdown: string): string {
  return markdown
    .replace(
      /<include\s+target\s*=\s*(["'])milvus\1\s*>([\s\S]*?)<\/include>\s*<include\s+target\s*=\s*(["'])zilliz\3\s*>[\s\S]*?<\/include>/gi,
      '$2'
    )
    .replace(
      /<include\s+target\s*=\s*(["'])milvus\1\s*>([\s\S]*?)<\/include>/gi,
      '$2'
    )
    .replace(
      /<include\s+target\s*=\s*(["'])zilliz\1\s*>[\s\S]*?<\/include>/gi,
      ''
    )
    .replace(/^\s*<include\b[^>]*>\s*$/gim, '')
    .replace(/^\s*<\/include>\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function preserveAuthoringIncludeMarkup(local: string, remote: string): string {
  if (/<include\b/i.test(local)) return local;
  const pattern = /<include\s+target\s*=\s*(["'])milvus\1\s*>([\s\S]*?)<\/include>(?:\s*<include\s+target\s*=\s*(["'])zilliz\3\s*>[\s\S]*?<\/include>)?/gi;
  const constructs = [...remote.matchAll(pattern)].map((match) => ({
    raw: match[0],
    visible: match[2] ?? ''
  })).filter(({ visible }) => visible !== '');
  let result = local;
  const byVisible = new Map<string, string[]>();
  for (const construct of constructs) {
    byVisible.set(construct.visible, [...(byVisible.get(construct.visible) ?? []), construct.raw]);
  }
  for (const [visible, replacements] of byVisible) {
    if (countOccurrences(result, visible) !== replacements.length) continue;
    for (const replacement of replacements) result = result.replace(visible, replacement);
  }
  return result;
}

export function preserveRemoteFeishuLinkDestinations(local: string, remote: string): string {
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const remoteLinks = [...remote.matchAll(linkPattern)].flatMap((match) => {
    const normalized = normalizeFeishuLinkTarget(match[2] ?? '');
    return normalized ? [{ key: `${match[1]}\u0000${normalized}`, url: match[2]! }] : [];
  });
  const localLinks = [...local.matchAll(linkPattern)].flatMap((match) => {
    const normalized = normalizeFeishuLinkTarget(match[2] ?? '');
    return normalized ? [{ key: `${match[1]}\u0000${normalized}` }] : [];
  });
  const remoteByKey = new Map<string, string[]>();
  const localCounts = new Map<string, number>();
  for (const link of remoteLinks) {
    remoteByKey.set(link.key, [...(remoteByKey.get(link.key) ?? []), link.url]);
  }
  for (const link of localLinks) localCounts.set(link.key, (localCounts.get(link.key) ?? 0) + 1);
  const queues = new Map([...remoteByKey].filter(([key, urls]) => localCounts.get(key) === urls.length));
  return local.replace(linkPattern, (raw, label: string, url: string) => {
    const normalized = normalizeFeishuLinkTarget(url);
    if (!normalized) return raw;
    const key = `${label}\u0000${normalized}`;
    const queue = queues.get(key);
    const remoteUrl = queue?.shift();
    return remoteUrl ? `[${label}](${remoteUrl})` : raw;
  });
}

export function semanticHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stripExecutionMetadata<T>(value: T): T {
  return stripExecutionValue(value) as T;
}

function stripExecutionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExecutionValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === 'remoteBlockId' || key === 'remoteToken') return [];
    return [[key, stripExecutionValue(child)]];
  }));
}

function countOccurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}

function normalizeFeishuLinkTarget(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/(?:^|\.)(?:feishu\.cn|larksuite\.com)$/i.test(parsed.hostname)) return undefined;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}
