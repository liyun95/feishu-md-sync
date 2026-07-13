import { sha256, stableStringify } from '../core/hash.js';

export function canonicalWhiteboardRaw(raw: unknown): string {
  return stableStringify(raw);
}

export function whiteboardRemoteStateHash(raw: unknown): string {
  return sha256(canonicalWhiteboardRaw(raw));
}

export function verifyWhiteboardReadback(input: { raw: unknown; expectedTexts: string[] }): void {
  if (!containsContent(input.raw)) {
    throw new Error('Whiteboard readback returned no nodes.');
  }
  const remoteText = collectStrings(input.raw).map(normalizeText).filter(Boolean).join('\n');
  for (const expected of input.expectedTexts.map(normalizeText).filter(Boolean)) {
    if (!remoteText.includes(expected)) {
      throw new Error(`Whiteboard readback is missing expected text: ${expected}`);
    }
  }
}

function containsContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.some(containsContent);
  return Object.values(value).some(containsContent);
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
