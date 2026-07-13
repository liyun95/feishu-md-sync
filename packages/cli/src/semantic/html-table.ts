import { parseFragment } from 'parse5';
import { normalizeRowKey } from './normalize.js';
import type {
  SemanticCell,
  SemanticCellBlock,
  SemanticInline,
  SemanticLocator,
  SemanticMarks,
  SemanticTable
} from './types.js';

type HtmlAttribute = { name: string; value: string };
type HtmlNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
};

export function parseHtmlTable(html: string, locator: SemanticLocator): SemanticTable {
  const fragment = parseFragment(html) as unknown as HtmlNode;
  const tables = elementChildren(fragment).filter((node) => node.tagName === 'table');
  if (tables.length !== 1) {
    throw new Error(`Expected exactly one top-level HTML table, found ${tables.length}.`);
  }

  const unsupported: string[] = [];
  const rows = tableRows(tables[0], unsupported);
  if (rows.length === 0) {
    return {
      kind: 'table',
      locator,
      headers: [],
      rows: [],
      unsupported: ['table has no rows']
    };
  }

  const parsedRows = rows.map((row) => rowCells(row).map((cell) => parseCell(cell, unsupported)));
  const columnCount = parsedRows[0]?.length ?? 0;
  if (columnCount === 0) addUnsupported(unsupported, 'table header has no cells');
  for (const row of parsedRows) {
    if (row.length !== columnCount) addUnsupported(unsupported, 'inconsistent column count');
  }

  const headers = parsedRows[0] ?? [];
  const dataRows = parsedRows.slice(1).map((cells) => ({
    key: normalizeRowKey(cells[0] ?? { blocks: [] }),
    cells
  }));

  const keyCounts = new Map<string, number>();
  for (const row of dataRows) {
    if (!row.key) {
      addUnsupported(unsupported, 'empty row key');
      continue;
    }
    keyCounts.set(row.key, (keyCounts.get(row.key) ?? 0) + 1);
  }
  for (const [key, count] of keyCounts) {
    if (count > 1) addUnsupported(unsupported, `duplicate row key: ${key}`);
  }

  return {
    kind: 'table',
    locator,
    headers,
    rows: dataRows,
    unsupported
  };
}

function tableRows(table: HtmlNode, unsupported: string[]): HtmlNode[] {
  const rows: HtmlNode[] = [];
  for (const child of elementChildren(table)) {
    if (child.tagName === 'tr') {
      rows.push(child);
      continue;
    }
    if (child.tagName === 'thead' || child.tagName === 'tbody' || child.tagName === 'tfoot') {
      rows.push(...elementChildren(child).filter((node) => node.tagName === 'tr'));
      continue;
    }
    if (child.tagName === 'colgroup') continue;
    if (child.tagName === 'table') addUnsupported(unsupported, 'nested tables are unsupported');
  }
  return rows;
}

function rowCells(row: HtmlNode): HtmlNode[] {
  return elementChildren(row).filter((node) => node.tagName === 'th' || node.tagName === 'td');
}

function parseCell(cell: HtmlNode, unsupported: string[]): SemanticCell {
  if (hasMergedSpan(cell)) addUnsupported(unsupported, 'merged cells are unsupported');

  const blocks: SemanticCellBlock[] = [];
  let pendingInlineNodes: HtmlNode[] = [];

  const flushPending = (): void => {
    if (pendingInlineNodes.length === 0) return;
    const inlines = parseInlines(pendingInlineNodes, {}, unsupported);
    if (hasVisibleInline(inlines)) blocks.push({ kind: 'paragraph', inlines });
    pendingInlineNodes = [];
  };

  for (const child of childNodes(cell)) {
    if (isWhitespaceText(child)) continue;
    if (child.tagName === 'p') {
      flushPending();
      blocks.push(parseParagraph(child, unsupported));
      continue;
    }
    if (child.tagName === 'ul' || child.tagName === 'ol') {
      flushPending();
      blocks.push(parseList(child, unsupported));
      continue;
    }
    if (child.tagName === 'table') {
      flushPending();
      addUnsupported(unsupported, 'nested tables are unsupported');
      continue;
    }
    if (child.tagName === 'img' || child.tagName === 'source' || child.tagName === 'figure') {
      flushPending();
      addUnsupported(unsupported, `unsupported cell element <${child.tagName}>`);
      continue;
    }
    pendingInlineNodes.push(child);
  }
  flushPending();

  return { blocks };
}

function parseParagraph(node: HtmlNode, unsupported: string[]): SemanticCellBlock {
  return {
    kind: 'paragraph',
    inlines: parseInlines(childNodes(node), {}, unsupported)
  };
}

function parseList(node: HtmlNode, unsupported: string[]): SemanticCellBlock {
  const items = elementChildren(node).filter((child) => child.tagName === 'li').map((item) => {
    const nested = elementChildren(item).some((child) => child.tagName === 'ul' || child.tagName === 'ol');
    if (nested) addUnsupported(unsupported, 'nested lists are unsupported');
    return parseInlines(childNodes(item).filter((child) => child.tagName !== 'ul' && child.tagName !== 'ol'), {}, unsupported);
  });

  return {
    kind: 'list',
    ordered: node.tagName === 'ol',
    items
  };
}

function parseInlines(nodes: HtmlNode[], marks: SemanticMarks, unsupported: string[]): SemanticInline[] {
  const inlines: SemanticInline[] = [];
  for (const node of nodes) {
    if (node.nodeName === '#text') {
      if (node.value) inlines.push(textInline(node.value, marks));
      continue;
    }
    if (node.tagName === 'br') {
      inlines.push({ kind: 'break' });
      continue;
    }

    const nextMarks = { ...marks };
    if (node.tagName === 'code') nextMarks.code = true;
    else if (node.tagName === 'b' || node.tagName === 'strong') nextMarks.bold = true;
    else if (node.tagName === 'i' || node.tagName === 'em') nextMarks.italic = true;
    else if (node.tagName === 'a') {
      const href = attribute(node, 'href');
      if (href && /^https?:\/\//i.test(href)) nextMarks.link = href;
      else addUnsupported(unsupported, 'relative links are unsupported');
    } else if (node.tagName === 'ul' || node.tagName === 'ol') {
      addUnsupported(unsupported, 'nested lists are unsupported');
      continue;
    } else if (node.tagName) {
      addUnsupported(unsupported, `unsupported cell element <${node.tagName}>`);
    }
    inlines.push(...parseInlines(childNodes(node), nextMarks, unsupported));
  }
  return inlines;
}

function textInline(value: string, marks: SemanticMarks): SemanticInline {
  const normalizedMarks = Object.keys(marks).length > 0 ? marks : undefined;
  return normalizedMarks
    ? { kind: 'text', value, marks: normalizedMarks }
    : { kind: 'text', value };
}

function hasMergedSpan(node: HtmlNode): boolean {
  return ['rowspan', 'colspan'].some((name) => {
    const value = attribute(node, name);
    return value !== undefined && value !== '1';
  });
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function elementChildren(node: HtmlNode): HtmlNode[] {
  return childNodes(node).filter((child) => Boolean(child.tagName));
}

function childNodes(node: HtmlNode): HtmlNode[] {
  return node.childNodes ?? [];
}

function isWhitespaceText(node: HtmlNode): boolean {
  return node.nodeName === '#text' && (node.value?.trim() ?? '') === '';
}

function hasVisibleInline(inlines: SemanticInline[]): boolean {
  return inlines.some((inline) => inline.kind === 'break' || inline.value.trim() !== '');
}

function addUnsupported(unsupported: string[], message: string): void {
  if (!unsupported.includes(message)) unsupported.push(message);
}
