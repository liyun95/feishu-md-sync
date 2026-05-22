import type { FeishuBlock, TextElement } from '../feishu/types.js';

const LANGUAGE_BY_ID: Record<number, string> = {
  7: 'bash',
  9: 'cpp',
  22: 'go',
  28: 'json',
  29: 'java',
  30: 'javascript',
  40: 'markdown',
  49: 'python',
  50: 'python',
  57: 'sql',
  64: 'typescript',
  67: 'yaml'
};

export function feishuBlocksToMarkdown(blocks: FeishuBlock[]): string {
  const parts = blocks.map(renderBlock).filter((part) => part.trim() !== '');
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

function renderBlock(block: FeishuBlock): string {
  if (block.block_type >= 3 && block.block_type <= 8) {
    const level = block.block_type - 2;
    const heading = block[`heading${level}`] as { elements?: TextElement[] } | undefined;
    return `${'#'.repeat(level)} ${renderElements(heading?.elements)}`;
  }

  if (block.block_type === 2) {
    return renderElements((block.text as { elements?: TextElement[] } | undefined)?.elements);
  }

  if (block.block_type === 12) {
    return `- ${renderElements((block.bullet as { elements?: TextElement[] } | undefined)?.elements)}`;
  }

  if (block.block_type === 13) {
    return `1. ${renderElements((block.ordered as { elements?: TextElement[] } | undefined)?.elements)}`;
  }

  if (block.block_type === 14) {
    const code = block.code as { elements?: TextElement[]; style?: { language?: number } } | undefined;
    const lang = code?.style?.language ? LANGUAGE_BY_ID[code.style.language] ?? '' : '';
    return `\`\`\`${lang}\n${renderElements(code?.elements)}\n\`\`\``;
  }

  if (block.block_type === 31) {
    return renderTable(block);
  }

  return `<!-- unsupported Feishu block_type ${block.block_type} omitted by pull -->`;
}

function renderElements(elements: TextElement[] = []): string {
  return elements.map((element) => {
    const run = element.text_run;
    if (!run) {
      return renderNonTextElement(element);
    }

    const style = run.text_element_style ?? {};
    let text = run.content;
    if (style.inline_code) text = `\`${text}\``;
    if (style.bold) text = `**${text}**`;
    if (style.link?.url) text = `[${text}](${style.link.url})`;
    return text;
  }).join('');
}

function renderNonTextElement(element: TextElement): string {
  const mentionDoc = element.mention_doc;
  if (mentionDoc?.title && mentionDoc.url) {
    return `[${mentionDoc.title}](${mentionDoc.url})`;
  }
  if (mentionDoc?.title) {
    return mentionDoc.title;
  }
  return '';
}

function renderTable(block: FeishuBlock): string {
  const table = block.table as { property?: { row_size?: number; column_size?: number }; cells?: FeishuBlock[] } | undefined;
  const rows = table?.property?.row_size ?? 0;
  const cols = table?.property?.column_size ?? 0;
  const cells = table?.cells ?? [];
  if (rows === 0 || cols === 0) return '';

  const renderedRows = Array.from({ length: rows }, (_, row) => {
    const values = Array.from({ length: cols }, (_, col) => renderBlock(cells[row * cols + col] ?? { block_type: 2 }));
    return `| ${values.join(' | ')} |`;
  });
  const separator = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  return [renderedRows[0], separator, ...renderedRows.slice(1)].join('\n');
}
