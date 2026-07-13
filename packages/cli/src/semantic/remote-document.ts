import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { findPageBlock, renderableDirectChildBlocks } from '../publish/block-state.js';
import { normalizeRowKey, semanticHash } from './normalize.js';
import type {
  SemanticCell,
  SemanticCellBlock,
  SemanticDocument,
  SemanticInline,
  SemanticLocator,
  SemanticMarks,
  SemanticNode,
  SemanticTable
} from './types.js';

const TEXT_KEY_BY_TYPE: Record<number, string> = {
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  12: 'bullet',
  13: 'ordered',
  14: 'code'
};

export function remoteSemanticDocument(blocks: FeishuBlock[], documentId: string): SemanticDocument {
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const nodes: SemanticNode[] = [];
  const headingPath: string[] = [];
  const ordinals = new Map<string, number>();

  for (const block of direct) {
    if (isSupportedTextBlock(block)) {
      const markdown = feishuBlocksToMarkdown([block]).trim();
      if (block.block_type >= 3 && block.block_type <= 8) {
        const level = block.block_type - 2;
        const title = markdown.replace(/^#{1,6}\s+/, '').trim();
        headingPath.length = level - 1;
        headingPath[level - 1] = title;
      }
      nodes.push({
        kind: 'text',
        locator: nextLocator(headingPath, 'text', ordinals),
        blockType: block.block_type,
        markdown,
        remoteBlockId: block.block_id
      });
      continue;
    }

    if (block.block_type === 31) {
      nodes.push(remoteTable(block, nextLocator(headingPath, 'table', ordinals)));
      continue;
    }

    nodes.push({
      kind: 'opaque',
      locator: nextLocator(headingPath, 'opaque', ordinals),
      description: `unsupported remote block_type ${block.block_type}`,
      fingerprint: semanticHash(normalizeRemoteBlock(block)),
      remoteBlockId: block.block_id
    });
  }

  return { nodes };
}

function remoteTable(block: FeishuBlock, locator: SemanticLocator): SemanticTable {
  const unsupported: string[] = [];
  const table = asRecord(block.table);
  const property = asRecord(table?.property);
  const rows = numberValue(property?.row_size);
  const columns = numberValue(property?.column_size);
  const cells = Array.isArray(table?.cells) ? table.cells.filter(isFeishuBlock) : [];

  if (rows === 0 || columns === 0) addUnsupported(unsupported, 'table has no rows or columns');
  if (cells.length !== rows * columns) addUnsupported(unsupported, 'inconsistent table cell count');
  const mergeInfo = property?.merge_info;
  if (Array.isArray(mergeInfo) && mergeInfo.some((item) => item !== null && item !== undefined)) {
    addUnsupported(unsupported, 'merged cells are unsupported');
  }

  const parsedCells = Array.from({ length: rows * columns }, (_, index) => {
    return remoteCell(cells[index], unsupported);
  });
  const headers = parsedCells.slice(0, columns);
  const dataRows = Array.from({ length: Math.max(0, rows - 1) }, (_, rowIndex) => {
    const rowCells = parsedCells.slice((rowIndex + 1) * columns, (rowIndex + 2) * columns);
    return {
      key: normalizeRowKey(rowCells[0] ?? { blocks: [] }),
      cells: rowCells
    };
  });

  const counts = new Map<string, number>();
  for (const row of dataRows) {
    if (!row.key) addUnsupported(unsupported, 'empty row key');
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (key && count > 1) addUnsupported(unsupported, `duplicate row key: ${key}`);
  }

  return {
    kind: 'table',
    locator,
    headers,
    rows: dataRows,
    remoteBlockId: block.block_id,
    unsupported
  };
}

function remoteCell(cell: FeishuBlock | undefined, unsupported: string[]): SemanticCell {
  if (!cell) return { blocks: [] };
  const children = cell.block_type === 32 && Array.isArray(cell.children)
    ? cell.children.filter(isFeishuBlock)
    : [cell];
  const blocks: SemanticCellBlock[] = [];
  let listItems: SemanticInline[][] = [];
  let listOrdered: boolean | undefined;

  const flushList = (): void => {
    if (listOrdered === undefined) return;
    blocks.push({ kind: 'list', ordered: listOrdered, items: listItems });
    listItems = [];
    listOrdered = undefined;
  };

  for (const child of children) {
    if (child.block_type === 2) {
      flushList();
      blocks.push({ kind: 'paragraph', inlines: inlinesForBlock(child, unsupported) });
      continue;
    }
    if (child.block_type === 12 || child.block_type === 13) {
      const ordered = child.block_type === 13;
      if (listOrdered !== undefined && listOrdered !== ordered) flushList();
      listOrdered = ordered;
      listItems.push(inlinesForBlock(child, unsupported));
      if (Array.isArray(child.children) && child.children.length > 0) {
        addUnsupported(unsupported, 'nested lists are unsupported');
      }
      continue;
    }
    flushList();
    addUnsupported(unsupported, `block_type ${child.block_type} in cell`);
  }
  flushList();
  return { blocks };
}

function inlinesForBlock(block: FeishuBlock, unsupported: string[]): SemanticInline[] {
  const key = TEXT_KEY_BY_TYPE[block.block_type];
  const value = key ? asRecord(block[key]) : undefined;
  const elements = Array.isArray(value?.elements) ? value.elements.filter(isTextElement) : [];
  return elements.flatMap((element) => inlineForElement(element, unsupported));
}

function inlineForElement(element: TextElement, unsupported: string[]): SemanticInline[] {
  const run = element.text_run;
  if (!run) {
    addUnsupported(unsupported, 'Feishu citation or non-text element in cell');
    return [];
  }
  const style = run.text_element_style ?? {};
  if (style.strikethrough || style.underline || style.background_color) {
    addUnsupported(unsupported, 'unsupported styling');
  }
  const marks: SemanticMarks = {};
  if (style.bold) marks.bold = true;
  if (style.italic) marks.italic = true;
  if (style.inline_code) marks.code = true;
  if (style.link?.url) {
    if (/^https?:\/\//i.test(style.link.url)) marks.link = style.link.url;
    else addUnsupported(unsupported, 'relative links are unsupported');
  }

  return run.content.split('\n').flatMap((value, index, values) => {
    const items: SemanticInline[] = [];
    if (value) items.push(Object.keys(marks).length > 0
      ? { kind: 'text', value, marks: { ...marks } }
      : { kind: 'text', value });
    if (index < values.length - 1) items.push({ kind: 'break' });
    return items;
  });
}

function isSupportedTextBlock(block: FeishuBlock): boolean {
  return block.block_type === 2 ||
    (block.block_type >= 3 && block.block_type <= 8) ||
    block.block_type === 12 ||
    block.block_type === 13 ||
    block.block_type === 14;
}

function nextLocator(
  sectionPath: string[],
  kind: SemanticLocator['kind'],
  ordinals: Map<string, number>
): SemanticLocator {
  const stablePath = [...sectionPath];
  const key = `${kind}:${JSON.stringify(stablePath)}`;
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  return { sectionPath: stablePath, kind, ordinal };
}

function normalizeRemoteBlock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRemoteBlock);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === 'block_id' || key === 'parent_id' || key === 'merge_info') return [];
    return [[key, normalizeRemoteBlock(child)]];
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}

function isTextElement(value: unknown): value is TextElement {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addUnsupported(unsupported: string[], message: string): void {
  if (!unsupported.includes(message)) unsupported.push(message);
}
