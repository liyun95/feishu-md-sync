import { sha256, stableStringify } from '../core/hash.js';

export function canonicalWhiteboardRaw(raw: unknown): string {
  return stableStringify(normalizeWhiteboardRaw(raw));
}

export function whiteboardRemoteStateHash(raw: unknown): string {
  return sha256(canonicalWhiteboardRaw(raw));
}

export function verifyWhiteboardReadback(input: { raw: unknown; expectedTexts: string[] }): void {
  const nodes = whiteboardNodes(input.raw);
  if (!nodes || nodes.length === 0) {
    throw new Error('Whiteboard readback returned no nodes.');
  }
  const remoteText = nodes.flatMap(textFromNode).map(normalizeText).filter(Boolean).join('\n');
  for (const expected of input.expectedTexts.map(normalizeText).filter(Boolean)) {
    if (!remoteText.includes(expected)) {
      throw new Error(`Whiteboard readback is missing expected text: ${expected}`);
    }
  }
}

function whiteboardNodes(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return undefined;
  const nodes = (raw as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes : undefined;
}

function textFromNode(node: unknown): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const record = node as { type?: unknown; text?: unknown };
  if (record.type !== 'text_shape') return [];
  return collectStrings(record.text);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStrings);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeWhiteboardRaw(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeWhiteboardRaw(item));
    if (key === 'nodes' && normalized.every(isIdentifiedNode)) {
      return normalized.sort((left, right) => left.id.localeCompare(right.id));
    }
    return normalized;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => {
    return [childKey, normalizeWhiteboardRaw(child, childKey)];
  }));
}

function isIdentifiedNode(value: unknown): value is { id: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string');
}
