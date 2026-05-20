import { createHash } from 'node:crypto';
import type { FeishuBlock } from '../feishu/types.js';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashSource(content: string): string {
  return sha256(content);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function normalizeBlockForHash(block: FeishuBlock): unknown {
  return normalizeValue(block);
}

export function hashBlocks(blocks: FeishuBlock[]): string {
  return sha256(stableStringify(blocks.map(normalizeBlockForHash)));
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return mergeAdjacentTextRuns(value.map(normalizeValue));
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'block_id') continue;
      if (key === 'parent_id') continue;
      if (key === 'children') continue;
      if (key === 'merge_info') continue;
      if (key === 'column_width' && isDefaultColumnWidth(child)) continue;
      if (key === 'folded' && child === false) continue;
      if (key === 'align' && child === 1) continue;
      if (key === 'wrap' && child === false) continue;
      normalized[key] = normalizeValue(child);
    }
    return normalized;
  }

  return value;
}

function isDefaultColumnWidth(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => item === 100);
}

function mergeAdjacentTextRuns(values: unknown[]): unknown[] {
  const merged: unknown[] = [];

  for (const value of values) {
    const previous = merged[merged.length - 1];
    if (isTextRun(previous) && isTextRun(value) && sameTextRunStyle(previous, value)) {
      const previousRun = previous.text_run;
      const currentRun = value.text_run;
      previousRun.content = `${previousRun.content}${currentRun.content}`;
      continue;
    }
    merged.push(value);
  }

  return merged;
}

function sameTextRunStyle(
  previous: unknown,
  current: unknown
): boolean {
  if (!isTextRun(previous) || !isTextRun(current)) return false;
  return stableStringify(previous.text_run.text_element_style) === stableStringify(current.text_run.text_element_style);
}

function isTextRun(value: unknown): value is { text_run: { content: string; text_element_style: unknown } } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const textRun = (value as { text_run?: unknown }).text_run;
  return Boolean(
    textRun &&
    typeof textRun === 'object' &&
    !Array.isArray(textRun) &&
    typeof (textRun as { content?: unknown }).content === 'string'
  );
}
