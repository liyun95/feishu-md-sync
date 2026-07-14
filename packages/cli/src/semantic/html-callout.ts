import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import type { SemanticCallout, SemanticLocator } from './types.js';

export function parseHtmlCallout(html: string, locator: SemanticLocator): SemanticCallout {
  const match = html.trim().match(/^<div\b([^>]*)>([\s\S]*)<\/div\s*>$/i);
  const classes = match ? classNames(match[1] ?? '') : [];
  const calloutType = classes.includes('note')
    ? 'note'
    : classes.includes('warning')
      ? 'warning'
      : undefined;
  if (!match || !classes.includes('alert') || !calloutType) {
    throw new Error('Expected a div with alert and note or warning classes.');
  }

  const body = (match[2] ?? '').trim();
  const unsupported: string[] = [];
  detectUnsupportedMarkdown(body, unsupported);
  const blocks = markdownToFeishuBlocks(body);
  for (const block of blocks) {
    if ((block.block_type === 12 || block.block_type === 13) && Array.isArray(block.children) && block.children.length > 0) {
      addUnsupported(unsupported, 'nested lists are unsupported');
    }
    if (!isSupportedCalloutBlockType(block.block_type)) {
      addUnsupported(unsupported, `block_type ${block.block_type} in Callout is unsupported`);
    }
  }

  return {
    kind: 'callout',
    locator,
    calloutType,
    children: blocks.map((block, ordinal) => ({
      ordinal,
      blockType: block.block_type,
      markdown: feishuBlocksToMarkdown([block]).trim()
    })),
    unsupported
  };
}

function classNames(attributes: string): string[] {
  const match = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/i);
  return (match?.[2] ?? '').split(/\s+/).map((value) => value.toLowerCase()).filter(Boolean);
}

function detectUnsupportedMarkdown(markdown: string, unsupported: string[]): void {
  if (/^\s*```/m.test(markdown)) addUnsupported(unsupported, 'fenced code blocks are unsupported');
  if (/^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(markdown)) {
    addUnsupported(unsupported, 'tables are unsupported');
  }
  if (/!\[[^\]]*\]\([^)]+\)/.test(markdown)) addUnsupported(unsupported, 'images are unsupported');
  if (/<(?:div|callout|table|img|whiteboard)\b/i.test(markdown)) {
    addUnsupported(unsupported, 'nested Callouts are unsupported');
  }
  if (/^(?: {2,}|\t)(?:[-*]|\d+[.)])\s+/m.test(markdown)) {
    addUnsupported(unsupported, 'nested lists are unsupported');
  }
  for (const link of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    if (!/^https?:\/\//i.test((link[1] ?? '').trim())) {
      addUnsupported(unsupported, 'relative links are unsupported');
    }
  }
  if (/^\s*>/m.test(markdown)) addUnsupported(unsupported, 'blockquotes are unsupported');
  if (/^\s*[-*]\s+\[[ xX]\]\s+/m.test(markdown)) addUnsupported(unsupported, 'checkboxes are unsupported');
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/m.test(markdown)) addUnsupported(unsupported, 'dividers are unsupported');
}

function isSupportedCalloutBlockType(blockType: number): boolean {
  return blockType === 2 ||
    (blockType >= 3 && blockType <= 8) ||
    blockType === 12 ||
    blockType === 13;
}

function addUnsupported(unsupported: string[], message: string): void {
  if (!unsupported.includes(message)) unsupported.push(message);
}
