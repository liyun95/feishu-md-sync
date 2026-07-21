import type { DesiredNode, InlineContent, PreparedProviderBlock } from './model.js';
import type { ProviderBlock } from './transport.js';

type NonTableDesiredNode = Exclude<DesiredNode, { kind: 'table' }>;
type TableNode = Extract<DesiredNode, { kind: 'table' }>;
type ListNode = Extract<DesiredNode, { kind: 'list' }>;
type CalloutNode = Extract<DesiredNode, { kind: 'callout' }>;

type TextElementStyle = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  inline_code: boolean;
  link?: { url: string };
};

type TextElement = {
  text_run: {
    content: string;
    text_element_style: TextElementStyle;
  };
};

const BLOCK_TYPE = {
  page: 1,
  text: 2,
  heading1: 3,
  bullet: 12,
  ordered: 13,
  code: 14,
  quote: 15,
} as const;

// Provider numeric IDs are physical Docx data, so this mapping belongs to the
// engine rather than either product CLI's Markdown or localization policy.
const CODE_LANGUAGE_IDS = {
  plaintext: 1,
  bash: 7,
  cpp: 9,
  c: 10,
  css: 12,
  dart: 15,
  dockerfile: 18,
  erlang: 19,
  go: 22,
  groovy: 23,
  html: 24,
  http: 26,
  haskell: 27,
  json: 28,
  java: 29,
  javascript: 30,
  kotlin: 32,
  latex: 33,
  lisp: 34,
  lua: 36,
  matlab: 37,
  makefile: 38,
  markdown: 40,
  nginx: 41,
  php: 44,
  perl: 45,
  powershell: 47,
  protobuf: 48,
  python: 49,
  ruby: 52,
  rust: 53,
  scss: 55,
  scheme: 56,
  sql: 57,
  scala: 58,
  swift: 59,
  thrift: 60,
  shell: 62,
  typescript: 64,
  vb: 65,
  xml: 66,
  yaml: 67,
  cmake: 68,
  diff: 69,
  gherkin: 70,
  graphql: 71,
  properties: 73,
  solidity: 74,
  toml: 75,
} as const;

const CODE_LANGUAGE_ALIASES: Record<string, keyof typeof CODE_LANGUAGE_IDS> = {
  'plain text': 'plaintext',
  text: 'plaintext',
  txt: 'plaintext',
  conf: 'plaintext',
  config: 'plaintext',
  log: 'plaintext',
  promql: 'plaintext',
  curl: 'bash',
  rest: 'bash',
  restful: 'bash',
  sh: 'shell',
  zsh: 'shell',
  cxx: 'cpp',
  golang: 'go',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  md: 'markdown',
  py: 'python',
  ps1: 'powershell',
  proto: 'protobuf',
  rs: 'rust',
  ts: 'typescript',
  visualbasic: 'vb',
  yml: 'yaml',
};

/**
 * Encode one provider block shell.
 *
 * `title` intentionally maps to the Docx page shell (`block_type: 1`). It is
 * page metadata, not a body heading or paragraph. Mutation planning decides
 * when that shell may target the existing document root.
 *
 * A list node can contain several provider sibling blocks. Use
 * `toProviderTree` for that general case; this single-block helper accepts a
 * list only when it contains exactly one item. Callouts and tables are XML
 * mutations and deliberately have no raw children-create representation.
 */
export function toProviderBlock(node: NonTableDesiredNode): ProviderBlock {
  assertRecord(node, 'Desired node');

  switch (node.kind) {
    case 'title':
      return {
        block_type: BLOCK_TYPE.page,
        page: { elements: inlineElements(node.content, 'title content') },
      };
    case 'paragraph':
      return textBlock('text', BLOCK_TYPE.text, node.content);
    case 'heading': {
      if (!Number.isInteger(node.level) || node.level < 1 || node.level > 6) {
        throw new Error('heading level must be an integer from 1 through 6');
      }
      const key = `heading${node.level}`;
      return textBlock(key, BLOCK_TYPE.heading1 + node.level - 1, node.content);
    }
    case 'list':
      assertListNode(node, 'list');
      if (node.items.length !== 1) {
        throw new Error('toProviderBlock requires a list with exactly one item');
      }
      return listItemBlock(node.ordered, node.items[0]!, 'list.items[0]');
    case 'code':
      assertString(node.text, 'Code text');
      if (node.caption !== undefined) assertString(node.caption, 'Code caption');
      return {
        block_type: BLOCK_TYPE.code,
        code: {
          elements: [textElement(node.text)],
          style: {
            language: codeLanguageId(node.language),
            ...(node.caption !== undefined ? { caption: node.caption } : {}),
          },
        },
      };
    case 'quote':
      return textBlock('quote', BLOCK_TYPE.quote, node.content);
    case 'callout':
      throw new Error('Callout nodes require calloutToXml and cannot be encoded as child blocks');
    default:
      throw new Error(`unsupported desired node: ${nodeKind(node)}`);
  }
}

export function toProviderTree(nodes: DesiredNode[]): ProviderBlock[] {
  if (!Array.isArray(nodes)) throw new Error('Desired nodes must be an array');

  return nodes.flatMap((node, index) => {
    assertRecord(node, `Desired nodes[${index}]`);
    if (node.kind === 'list') return listBlocks(node, `Desired nodes[${index}]`);
    if (node.kind === 'title') {
      throw new Error('title nodes describe the page root and cannot be encoded as child blocks');
    }
    if (node.kind === 'callout') {
      throw new Error('Callout nodes require calloutToXml and cannot be encoded as child blocks');
    }
    if (node.kind === 'table') {
      throw new Error('table nodes require tableToXml and cannot be encoded as child blocks');
    }
    return [toProviderBlock(node)];
  });
}

export function calloutToXml(callout: CalloutNode): string {
  assertRecord(callout, 'Callout');
  if (callout.kind !== 'callout') throw new Error('Callout input must be a callout node');
  assertString(callout.calloutType, 'Callout type');
  const presentation = callout.calloutType === 'note'
    ? { emoji: '📘', background: 'light-orange', border: 'orange' }
    : callout.calloutType === 'warning'
      ? { emoji: '❗', background: 'light-red', border: 'red' }
      : undefined;
  if (!presentation) throw new Error(`unsupported Callout type: ${callout.calloutType}`);
  if (callout.title !== undefined) assertString(callout.title, 'Callout title');
  if (!Array.isArray(callout.children)) throw new Error('Callout children must be an array');
  assertCalloutChildren(callout.children);

  const title = callout.title === undefined
    ? ''
    : `<p>${escapeInlineText(callout.title)}</p>`;
  const body = callout.children.map((child, index) =>
    structuredNodeToXml(child, `Callout.children[${index}]`, 'callout')
  ).join('');
  return `<callout emoji="${presentation.emoji}" background-color="${presentation.background}" border-color="${presentation.border}">` +
    `${title}${body}</callout>`;
}

export function tableToXml(table: TableNode): string {
  const dimensions = tableDimensions(table, 'table');
  const [header, ...bodyRows] = table.rows;
  const headerXml = `<thead><tr>${header!.cells.map((cell, index) =>
    `<th>${tableCellToXml(cell.content, `table.rows[0].cells[${index}]`)}</th>`
  ).join('')}</tr></thead>`;
  const bodyXml = `<tbody>${bodyRows.map((row, rowOffset) => {
    const rowIndex = rowOffset + 1;
    return `<tr>${row.cells.map((cell, cellIndex) =>
      `<td>${tableCellToXml(cell.content, `table.rows[${rowIndex}].cells[${cellIndex}]`)}</td>`
    ).join('')}</tr>`;
  }).join('')}</tbody>`;

  if (dimensions.rows < 1 || dimensions.columns < 1) {
    throw new Error('table must contain at least one row and one column');
  }
  return `<table>${headerXml}${bodyXml}</table>`;
}

export function providerBlocksToXml(blocks: PreparedProviderBlock[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('Provider XML encoding requires at least one block');
  }
  const output: string[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (block.block_type === BLOCK_TYPE.bullet || block.block_type === BLOCK_TYPE.ordered) {
      const listType = block.block_type;
      const items: string[] = [];
      while (index < blocks.length && blocks[index]!.block_type === listType) {
        items.push(`<li>${providerInlineToXml(blocks[index]!, listType === BLOCK_TYPE.bullet ? 'bullet' : 'ordered')}</li>`);
        index += 1;
      }
      output.push(`<${listType === BLOCK_TYPE.bullet ? 'ul' : 'ol'}>${items.join('')}</${listType === BLOCK_TYPE.bullet ? 'ul' : 'ol'}>`);
      continue;
    }
    output.push(providerBlockToXml(block));
    index += 1;
  }
  return output.join('');
}

function providerBlockToXml(block: PreparedProviderBlock): string {
  const type = block.block_type;
  if (type === BLOCK_TYPE.page) return `<p>${providerInlineToXml(block, 'page')}</p>`;
  if (type === BLOCK_TYPE.text) return `<p>${providerInlineToXml(block, 'text')}</p>`;
  if (type >= BLOCK_TYPE.heading1 && type <= BLOCK_TYPE.heading1 + 5) {
    const level = type - BLOCK_TYPE.heading1 + 1;
    return `<h${level}>${providerInlineToXml(block, `heading${level}`)}</h${level}>`;
  }
  if (type === BLOCK_TYPE.code) {
    const code = asRecord(block.code);
    const style = asRecord(code?.style);
    const language = codeLanguageName(style?.language);
    const caption = typeof style?.caption === 'string'
      ? ` caption="${escapeXmlAttribute(style.caption)}"`
      : '';
    return `<pre lang="${escapeXmlAttribute(language)}"${caption}><code>${escapeXmlText(
      providerInlineText(block, 'code'),
    )}</code></pre>`;
  }
  if (type === BLOCK_TYPE.quote) {
    return `<blockquote><p>${providerInlineToXml(block, 'quote')}</p></blockquote>`;
  }
  throw new Error(`Provider block type ${type} cannot be encoded as lossless Docx XML`);
}

function providerInlineToXml(block: PreparedProviderBlock, key: string): string {
  const payload = asRecord(block[key]);
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  return elements.map((value, index) => {
    const element = asRecord(value);
    const run = asRecord(element?.text_run);
    if (!run || typeof run.content !== 'string') {
      throw new Error(`${key}.elements[${index}] is not a supported text run`);
    }
    const style = asRecord(run.text_element_style);
    const link = asRecord(style?.link);
    let content = escapeXmlText(run.content);
    if (style?.inline_code === true) content = `<code>${content}</code>`;
    if (style?.underline === true) content = `<u>${content}</u>`;
    if (style?.strikethrough === true) content = `<del>${content}</del>`;
    if (style?.italic === true) content = `<em>${content}</em>`;
    if (style?.bold === true) content = `<b>${content}</b>`;
    if (typeof link?.url === 'string') {
      content = `<a href="${escapeXmlAttribute(normalizeProviderLinkUrl(link.url))}">${content}</a>`;
    }
    return content;
  }).join('');
}

function providerInlineText(block: PreparedProviderBlock, key: string): string {
  const payload = asRecord(block[key]);
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  return elements.map((value, index) => {
    const run = asRecord(asRecord(value)?.text_run);
    if (!run || typeof run.content !== 'string') {
      throw new Error(`${key}.elements[${index}] is not a supported text run`);
    }
    return run.content;
  }).join('');
}

function codeLanguageName(value: unknown): string {
  if (typeof value === 'string') return value;
  const entry = Object.entries(CODE_LANGUAGE_IDS).find(([, id]) => id === value);
  if (!entry && value === 50) return 'python';
  if (!entry) throw new Error(`unsupported Feishu Code block language ID: ${String(value)}`);
  return entry[0];
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textBlock(
  key: string,
  blockType: number,
  content: InlineContent[],
): ProviderBlock {
  return {
    block_type: blockType,
    [key]: {
      elements: inlineElements(content, `${key} content`),
      style: { align: 1 },
    },
  };
}

function listBlocks(node: ListNode, location: string): ProviderBlock[] {
  assertListNode(node, location);
  return node.items.map((item, index) =>
    listItemBlock(node.ordered, item, `${location}.items[${index}]`)
  );
}

function listItemBlock(
  ordered: boolean,
  item: ListNode['items'][number],
  location: string,
): ProviderBlock {
  assertRecord(item, location);
  if (!Array.isArray(item.children)) throw new Error(`${location}.children must be an array`);
  const key = ordered ? 'ordered' : 'bullet';
  const children = item.children.flatMap((child, index) =>
    listBlocks(child, `${location}.children[${index}]`)
  );
  return {
    block_type: ordered ? BLOCK_TYPE.ordered : BLOCK_TYPE.bullet,
    [key]: {
      elements: inlineElements(item.content, `${location}.content`),
      style: {},
    },
    ...(children.length > 0 ? { children } : {}),
  };
}

function tableDimensions(
  table: TableNode,
  location: string,
): { rows: number; columns: number } {
  assertRecord(table, location);
  if (table.kind !== 'table') throw new Error(`${location} must be a table node`);
  if (!Array.isArray(table.rows) || table.rows.length === 0) {
    throw new Error('table must contain at least one row and one column');
  }

  let columns: number | undefined;
  for (const [rowIndex, row] of table.rows.entries()) {
    assertRecord(row, `${location}.rows[${rowIndex}]`);
    if (!Array.isArray(row.cells) || row.cells.length === 0) {
      throw new Error('table must contain at least one row and one column');
    }
    if (columns === undefined) columns = row.cells.length;
    if (row.cells.length !== columns) {
      throw new Error(`table row ${rowIndex} has ${row.cells.length} cells; expected ${columns}`);
    }
    for (const [cellIndex, cell] of row.cells.entries()) {
      assertRecord(cell, `${location}.rows[${rowIndex}].cells[${cellIndex}]`);
      assertTableCellContent(
        cell.content,
        `${location}.rows[${rowIndex}].cells[${cellIndex}]`,
      );
    }
  }

  return { rows: table.rows.length, columns: columns! };
}

function assertTableCellContent(nodes: DesiredNode[], location: string): void {
  if (!Array.isArray(nodes)) throw new Error(`${location}.content must be an array`);
  for (const [index, node] of nodes.entries()) {
    assertRecord(node, `${location}.content[${index}]`);
    if (
      node.kind === 'title' ||
      node.kind === 'table' ||
      node.kind === 'callout'
    ) {
      throw new Error(`unsupported table cell node: ${node.kind}`);
    }
    if (!['paragraph', 'heading', 'list', 'code', 'quote'].includes(node.kind)) {
      throw new Error(`unsupported table cell node: ${nodeKind(node)}`);
    }
  }
}

function tableCellToXml(nodes: DesiredNode[], location: string): string {
  assertTableCellContent(nodes, location);
  return nodes.map((node, index) =>
    structuredNodeToXml(node, `${location}.content[${index}]`, 'table')
  ).join('');
}

function structuredNodeToXml(
  node: DesiredNode,
  location: string,
  context: 'table' | 'callout',
): string {
  switch (node.kind) {
    case 'paragraph':
      return `<p>${inlineXml(node.content, `${location}.content`)}</p>`;
    case 'heading':
      if (!Number.isInteger(node.level) || node.level < 1 || node.level > 6) {
        throw new Error('heading level must be an integer from 1 through 6');
      }
      return `<h${node.level}>${inlineXml(node.content, `${location}.content`)}</h${node.level}>`;
    case 'list':
      return listToXml(node, location);
    case 'code': {
      if (context === 'callout') throw new Error('unsupported Callout child node: code');
      assertString(node.text, `${location}.text`);
      if (node.caption !== undefined) assertString(node.caption, `${location}.caption`);
      const language = canonicalCodeLanguage(node.language);
      const caption = node.caption === undefined
        ? ''
        : ` caption="${escapeAttribute(node.caption)}"`;
      return `<pre lang="${escapeAttribute(language)}"${caption}><code>${escapeText(node.text)}</code></pre>`;
    }
    case 'quote':
      return `<blockquote>${inlineXml(node.content, `${location}.content`)}</blockquote>`;
    default:
      throw new Error(
        context === 'callout'
          ? `unsupported Callout child node: ${node.kind}`
          : `unsupported table cell node: ${node.kind}`,
      );
  }
}

function listToXml(node: ListNode, location: string): string {
  assertListNode(node, location);
  const tag = node.ordered ? 'ol' : 'ul';
  const items = node.items.map((item, index) => {
    const itemLocation = `${location}.items[${index}]`;
    assertRecord(item, itemLocation);
    if (!Array.isArray(item.children)) throw new Error(`${itemLocation}.children must be an array`);
    return `<li>${inlineXml(item.content, `${itemLocation}.content`)}` +
      `${item.children.map((child, childIndex) =>
        listToXml(child, `${itemLocation}.children[${childIndex}]`)
      ).join('')}</li>`;
  }).join('');
  return `<${tag}>${items}</${tag}>`;
}

function assertCalloutChildren(nodes: DesiredNode[]): void {
  for (const [index, node] of nodes.entries()) {
    assertRecord(node, `Callout.children[${index}]`);
    if (!['paragraph', 'heading', 'list', 'quote'].includes(node.kind)) {
      throw new Error(`unsupported Callout child node: ${nodeKind(node)}`);
    }
  }
}

function inlineElements(content: InlineContent[], location: string): TextElement[] {
  if (!Array.isArray(content)) throw new Error(`${location} must be an array`);
  if (content.length === 0) return [textElement('')];
  return content.map((inline, index) => inlineElement(inline, `${location}[${index}]`));
}

function inlineElement(inline: InlineContent, location: string): TextElement {
  assertRecord(inline, location);
  assertString(inline.text, `${location}.text`);

  switch (inline.kind) {
    case 'text':
      assertOptionalBoolean(inline.bold, `${location}.bold`);
      assertOptionalBoolean(inline.italic, `${location}.italic`);
      assertOptionalBoolean(inline.underline, `${location}.underline`);
      assertOptionalBoolean(inline.strike, `${location}.strike`);
      return textElement(inline.text, {
        ...(inline.bold ? { bold: true } : {}),
        ...(inline.italic ? { italic: true } : {}),
        ...(inline.underline ? { underline: true } : {}),
        ...(inline.strike ? { strikethrough: true } : {}),
      });
    case 'code':
      return textElement(inline.text, { inline_code: true });
    case 'link':
      return textElement(inline.text, { link: { url: providerLinkUrl(inline.url) } });
    default:
      throw new Error(`unsupported inline content: ${nodeKind(inline)}`);
  }
}

function textElement(
  content: string,
  style: Partial<TextElementStyle> = {},
): TextElement {
  return {
    text_run: {
      content,
      text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false,
        ...style,
      },
    },
  };
}

function inlineXml(content: InlineContent[], location: string): string {
  if (!Array.isArray(content)) throw new Error(`${location} must be an array`);
  return content.map((inline, index) => inlineToXml(inline, `${location}[${index}]`)).join('');
}

function inlineToXml(inline: InlineContent, location: string): string {
  assertRecord(inline, location);
  assertString(inline.text, `${location}.text`);

  if (inline.kind === 'code') return `<code>${escapeText(inline.text)}</code>`;
  if (inline.kind === 'link') {
    const url = normalizeProviderLinkUrl(inline.url);
    return `<a href="${escapeAttribute(url)}">${escapeInlineText(inline.text)}</a>`;
  }
  if (inline.kind !== 'text') {
    throw new Error(`unsupported inline content: ${nodeKind(inline)}`);
  }

  assertOptionalBoolean(inline.bold, `${location}.bold`);
  assertOptionalBoolean(inline.italic, `${location}.italic`);
  assertOptionalBoolean(inline.underline, `${location}.underline`);
  assertOptionalBoolean(inline.strike, `${location}.strike`);
  let rendered = escapeInlineText(inline.text);
  if (inline.underline) rendered = `<u>${rendered}</u>`;
  if (inline.strike) rendered = `<del>${rendered}</del>`;
  if (inline.italic) rendered = `<em>${rendered}</em>`;
  if (inline.bold) rendered = `<b>${rendered}</b>`;
  return rendered;
}

function providerLinkUrl(value: string): string {
  return encodeURIComponent(normalizeProviderLinkUrl(value));
}

export function normalizeProviderLinkUrl(value: string): string {
  assertString(value, 'provider link URL');
  const direct = validHttpUrl(value);
  if (direct) return direct;
  try {
    const decoded = decodeURIComponent(value);
    const normalized = validHttpUrl(decoded);
    if (normalized) return normalized;
  } catch {
    // Report the same closed validation error below.
  }
  throw new Error('provider links must use an absolute http(s) URL');
}

function validHttpUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function codeLanguageId(language: string): number {
  const canonical = canonicalCodeLanguage(language);
  return CODE_LANGUAGE_IDS[canonical];
}

function canonicalCodeLanguage(language: string): keyof typeof CODE_LANGUAGE_IDS {
  assertString(language, 'Code language');
  const source = language.trim().toLowerCase() || 'plaintext';
  const canonical = source in CODE_LANGUAGE_IDS
    ? source as keyof typeof CODE_LANGUAGE_IDS
    : CODE_LANGUAGE_ALIASES[source];
  if (!canonical) throw new Error(`unsupported Code block language: ${source}`);
  return canonical;
}

function assertListNode(node: ListNode, location: string): void {
  assertRecord(node, location);
  if (node.kind !== 'list') throw new Error(`${location} must be a list node`);
  if (typeof node.ordered !== 'boolean') throw new Error(`${location}.ordered must be a boolean`);
  if (!Array.isArray(node.items) || node.items.length === 0) {
    throw new Error(`${location}.items must be a non-empty array`);
  }
}

function assertOptionalBoolean(value: unknown, location: string): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${location} must be a boolean when present`);
  }
}

function assertString(value: unknown, location: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${location} must be a string`);
}

function assertRecord(value: unknown, location: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
}

function nodeKind(value: object): string {
  return 'kind' in value && typeof value.kind === 'string' ? value.kind : 'unknown';
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeInlineText(value: string): string {
  return escapeText(value).replace(/\r\n|\r|\n/g, '<br/>');
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
