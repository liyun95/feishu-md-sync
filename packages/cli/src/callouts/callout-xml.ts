import type { CalloutConfig } from '../config/sync-config.js';
import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import type { SemanticCallout } from '../semantic/types.js';

export function renderCalloutXml(input: {
  callout: SemanticCallout;
  config: CalloutConfig;
}): string {
  if (input.callout.unsupported.length > 0) {
    throw new Error(`Cannot render unsupported Callout content: ${input.callout.unsupported.join('; ')}`);
  }
  const type = input.callout.calloutType;
  if (!type) throw new Error('Cannot render a Callout without a known type.');
  const presentation = type === 'note'
    ? { emoji: '📘', background: 'light-orange', border: 'orange', title: input.config.noteTitle }
    : { emoji: '❗', background: 'light-red', border: 'red', title: input.config.warningTitle };
  const title = input.callout.titleManaged && input.callout.title
    ? input.callout.title.markdown
    : presentation.title;
  const blocks = input.callout.children.flatMap((child) => markdownToFeishuBlocks(child.markdown));
  const body = renderBlocks(blocks);
  return `<callout emoji="${presentation.emoji}" background-color="${presentation.background}" border-color="${presentation.border}">` +
    `<p>${escapeXml(title)}</p>${body}</callout>`;
}

function renderBlocks(blocks: FeishuBlock[]): string {
  const output: string[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (block.block_type === 12 || block.block_type === 13) {
      const ordered = block.block_type === 13;
      const items: string[] = [];
      while (index < blocks.length && blocks[index]?.block_type === block.block_type) {
        const item = blocks[index]!;
        items.push(ordered
          ? `<li seq="auto">${renderTextBlock(item)}</li>`
          : `<li>${renderTextBlock(item)}</li>`);
        index += 1;
      }
      output.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    output.push(renderBlock(block));
    index += 1;
  }
  return output.join('');
}

function renderBlock(block: FeishuBlock): string {
  if (block.block_type === 2) return `<p>${renderTextBlock(block)}</p>`;
  if (block.block_type >= 3 && block.block_type <= 8) {
    const level = block.block_type - 2;
    return `<h${level}>${renderTextBlock(block)}</h${level}>`;
  }
  throw new Error(`Cannot render unsupported Callout block_type ${block.block_type}.`);
}

function renderTextBlock(block: FeishuBlock): string {
  const key = block.block_type === 2
    ? 'text'
    : block.block_type === 12
      ? 'bullet'
      : block.block_type === 13
        ? 'ordered'
        : `heading${block.block_type - 2}`;
  const value = asRecord(block[key]);
  const elements = Array.isArray(value?.elements) ? value.elements.filter(isTextElement) : [];
  return elements.map(renderTextElement).join('');
}

function renderTextElement(element: TextElement): string {
  const run = element.text_run;
  if (!run) throw new Error('Cannot render non-text inline content in a Callout.');
  const style = run.text_element_style ?? {};
  let value = escapeXml(run.content);
  if (style.inline_code) value = `<code>${value}</code>`;
  if (style.italic) value = `<em>${value}</em>`;
  if (style.bold) value = `<b>${value}</b>`;
  if (style.link?.url) value = `<a href="${escapeXml(style.link.url)}">${value}</a>`;
  return value;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTextElement(value: unknown): value is TextElement {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
