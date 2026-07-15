import { parse } from 'yaml';

export type FrontmatterResult = {
  data: Record<string, unknown>;
  body: string;
  raw?: string;
  bodyStartLine: number;
};

export function parseLeadingFrontmatter(markdown: string): FrontmatterResult {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { data: {}, body: markdown, bodyStartLine: 1 };
  const parsed = parse(match[1] ?? '');
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const raw = match[0];
  return {
    data,
    body: markdown.slice(raw.length),
    raw,
    bodyStartLine: raw.split(/\r?\n/).length
  };
}
