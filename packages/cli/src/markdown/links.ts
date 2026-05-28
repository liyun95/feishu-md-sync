import type { FeishuBlock } from '../feishu/types.js';

export function normalizeMarkdownLinkUrl(url: string): string {
  if (isAbsoluteHttpUrl(url)) return url;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return url;
  }

  return isAbsoluteHttpUrl(decoded) ? decoded : url;
}

export function normalizeFeishuBlockLinkUrls(blocks: FeishuBlock[]): FeishuBlock[] {
  return normalizeValue(blocks) as FeishuBlock[];
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = key === 'url' && typeof child === 'string'
      ? normalizeMarkdownLinkUrl(child)
      : normalizeValue(child);
  }
  return normalized;
}

function isAbsoluteHttpUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
