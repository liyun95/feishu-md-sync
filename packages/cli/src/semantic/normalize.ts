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
