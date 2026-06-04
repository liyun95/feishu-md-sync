import type { FeishuBlock, TextElement, TextElementStyle } from '../feishu/types.js';
import { normalizeMarkdownLinkUrl } from './links.js';

const BLOCK_TYPES = {
  text: 2,
  heading1: 3,
  heading2: 4,
  heading3: 5,
  heading4: 6,
  heading5: 7,
  heading6: 8,
  bullet: 12,
  ordered: 13,
  code: 14,
  table: 31
} as const;

export const LANG_IDS: Record<string, number> = {
  plaintext: 1,
  text: 1,
  bash: 7,
  shell: 62,
  sh: 62,
  cpp: 9,
  c: 10,
  go: 22,
  golang: 22,
  json: 28,
  java: 29,
  javascript: 30,
  js: 30,
  nodejs: 30,
  node: 30,
  markdown: 40,
  python: 49,
  py: 49,
  restful: 7,
  rest: 7,
  sql: 57,
  typescript: 64,
  ts: 64,
  yaml: 67,
  yml: 67
};

export function languageIdForMarkdownLanguage(language: string): number {
  return LANG_IDS[language.toLowerCase()] ?? LANG_IDS.plaintext;
}

type ListMarker = {
  ordered: boolean;
  text: string;
};

export function markdownToFeishuBlocks(markdown: string): FeishuBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: FeishuBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] || 'plaintext';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(codeBlock(codeLines.join('\n'), lang));
      continue;
    }

    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? '')) {
        tableLines.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push(tableBlock(tableLines));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push(headingBlock(heading[1].length, stripHeadingAnchor(heading[2])));
      index += 1;
      continue;
    }

    const listMarker = parseListMarker(line);
    if (listMarker) {
      while (index < lines.length) {
        const item = parseListMarker(lines[index] ?? '');
        if (!item) break;
        index += 1;

        const childLines: string[] = [];
        while (index < lines.length) {
          const childLine = lines[index] ?? '';
          if (childLine.trim() === '') break;
          if (parseListMarker(childLine)) break;
          if (/^(#{1,6})\s+/.test(childLine) || /^```/.test(childLine) || isTableStart(lines, index)) break;
          childLines.push(childLine.trim());
          index += 1;
        }

        blocks.push(listBlock(
          item.text,
          item.ordered,
          childLines.map((childLine) => textBlock(childLine))
        ));
      }
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[index] ?? '') &&
      !/^```/.test(lines[index] ?? '') &&
      !parseListMarker(lines[index] ?? '') &&
      !isTableStart(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? '').trim());
      index += 1;
    }
    blocks.push(textBlock(paragraphLines.join(' ')));
  }

  return blocks;
}

function textElement(content: string, style: TextElementStyle = {}): TextElement {
  return {
    text_run: {
      content,
      text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false,
        ...style
      }
    }
  };
}

export function parseInlineText(text: string): TextElement[] {
  const elements: TextElement[] = [];
  let cursor = 0;
  const pattern = /(==[^=]+==|`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      elements.push(textElement(text.slice(cursor, start)));
    }

    const token = match[0];
    if (token.startsWith('==')) {
      elements.push(textElement(token.slice(2, -2), { background_color: 5 }));
    } else if (token.startsWith('`')) {
      elements.push(textElement(token.slice(1, -1), { inline_code: true }));
    } else if (token.startsWith('**')) {
      elements.push(textElement(token.slice(2, -2), { bold: true }));
    } else if (token.startsWith('*')) {
      elements.push(textElement(token.slice(1, -1), { italic: true }));
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        elements.push(textElement(link[1], { link: { url: normalizeMarkdownLinkUrl(link[2]) } }));
      }
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) {
    elements.push(textElement(text.slice(cursor)));
  }

  return elements.length > 0 ? elements : [textElement('')];
}

function textBlock(text: string, style: TextElementStyle = {}): FeishuBlock {
  return {
    block_type: BLOCK_TYPES.text,
    text: {
      elements: parseInlineText(text).map((element) => {
        if (!element.text_run) return element;
        return {
          ...element,
          text_run: {
            ...element.text_run,
            text_element_style: {
              ...element.text_run.text_element_style,
              ...style
            }
          }
        };
      }),
      style: { align: 1 }
    }
  };
}

function headingBlock(level: number, text: string): FeishuBlock {
  const safeLevel = Math.min(Math.max(level, 1), 6);
  return {
    block_type: BLOCK_TYPES[`heading${safeLevel}` as keyof typeof BLOCK_TYPES],
    [`heading${safeLevel}`]: {
      elements: parseInlineText(text),
      style: { align: 1 }
    }
  };
}

function listBlock(text: string, ordered: boolean, children: FeishuBlock[] = []): FeishuBlock {
  const key = ordered ? 'ordered' : 'bullet';
  const block: FeishuBlock = {
    block_type: ordered ? BLOCK_TYPES.ordered : BLOCK_TYPES.bullet,
    [key]: {
      elements: parseInlineText(text),
      style: {}
    }
  };
  if (children.length > 0) block.children = children;
  return block;
}

function codeBlock(text: string, lang: string): FeishuBlock {
  return {
    block_type: BLOCK_TYPES.code,
    code: {
      elements: [textElement(text)],
      style: {
        language: languageIdForMarkdownLanguage(lang)
      }
    }
  };
}

function parseListMarker(line: string): ListMarker | null {
  const bullet = line.match(/^\s*[-*]\s+(.+)$/);
  if (bullet) return { ordered: false, text: bullet[1].trim() };

  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1].trim() };

  return null;
}

function stripHeadingAnchor(text: string): string {
  return text.trim().replace(/\s*\{#[A-Za-z0-9_-]+\}\s*$/, '').trim();
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    /^\s*\|.*\|\s*$/.test(lines[index] ?? '') &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? '')
  );
}

function tableBlock(lines: string[]): FeishuBlock {
  const dataRows = lines.filter((_, index) => index !== 1).map(parseTableRow);
  const rowSize = dataRows.length;
  const columnSize = Math.max(...dataRows.map((row) => row.length));
  const cells = dataRows.flatMap((row) => {
    return Array.from({ length: columnSize }, (_, index) => textBlock(row[index] ?? '', row === dataRows[0] ? { bold: true } : {}));
  });

  return {
    block_type: BLOCK_TYPES.table,
    table: {
      property: {
        row_size: rowSize,
        column_size: columnSize,
        merge_info: Array.from({ length: rowSize * columnSize }, () => null)
      },
      cells
    }
  };
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = hasUnescapedTrailingPipe(content) ? content.slice(0, -1) : content;
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  let escaping = false;

  for (const char of withoutTrailingPipe) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }

    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  cells.push(current.trim());
  return cells;
}

function hasUnescapedTrailingPipe(value: string): boolean {
  if (!value.endsWith('|')) return false;
  let backslashCount = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}
