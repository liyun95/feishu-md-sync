import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { codeLanguageForId } from '../code-blocks/code-language.js';
import { calloutTypeForTitle } from '../callouts/callout-presentation.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { findPageBlock, renderableDirectChildBlocks } from '../publish/block-state.js';
import { normalizeRowKey, semanticHash } from './normalize.js';
import type {
  SemanticCell,
  SemanticCellBlock,
  SemanticCallout,
  SemanticCodeBlock,
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

export function remoteSemanticDocument(
  blocks: FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig = DEFAULT_CALLOUT_CONFIG
): SemanticDocument {
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const nodes: SemanticNode[] = [];
  const headingPath: string[] = [];
  const ordinals = new Map<string, number>();

  for (const block of direct) {
    if (block.block_type === 14) {
      nodes.push(remoteCodeBlock(block, nextLocator(headingPath, 'code', ordinals)));
      continue;
    }
    if (isSupportedTextBlock(block)) {
      const markdown = feishuBlocksToMarkdown([block]).trim();
      if (!markdown) continue;
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

    if (block.block_type === 19) {
      nodes.push(remoteCallout(block, nextLocator(headingPath, 'callout', ordinals), callouts));
      continue;
    }

    if (block.block_type === 27 || block.block_type === 43) {
      nodes.push(remoteAsset(block, nextLocator(headingPath, 'asset', ordinals)));
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

function remoteCodeBlock(block: FeishuBlock, locator: SemanticLocator): SemanticCodeBlock {
  const code = asRecord(block.code);
  const style = asRecord(code?.style);
  const elements = Array.isArray(code?.elements) ? code.elements.filter(isTextElement) : [];
  const content = elements.map((element) => element.text_run?.content ?? '').join('');
  const languageId = numberValue(style?.language) || 1;
  const issues: SemanticCodeBlock['issues'] = [];
  let resolvedLanguage = 'plaintext';
  try {
    resolvedLanguage = codeLanguageForId(languageId);
  } catch (error) {
    issues.push({
      code: 'unsupported-code-language',
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const caption = typeof style?.caption === 'string'
    ? style.caption
    : typeof code?.caption === 'string'
      ? code.caption
      : undefined;
  return {
    kind: 'code',
    locator,
    content,
    sourceLanguage: resolvedLanguage,
    resolvedLanguage,
    caption,
    remoteBlockId: block.block_id,
    issues
  };
}

function remoteCallout(
  block: FeishuBlock,
  locator: SemanticLocator,
  config: CalloutConfig
): SemanticCallout {
  const unsupported: string[] = [];
  const children = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const titleBlock = children[0];
  const titleMarkdown = titleBlock ? feishuBlocksToMarkdown([titleBlock], config).trim() : '';
  const calloutType = calloutTypeForTitle(titleMarkdown, config);
  if (!calloutType) addUnsupported(unsupported, 'remote Callout title is unrecognized');
  if (!titleBlock || titleBlock.block_type !== 2) {
    addUnsupported(unsupported, 'remote Callout presentation title must be a text block');
  }

  const body = children.slice(1).map((child, ordinal) => {
    if (!isSupportedCalloutBlock(child.block_type)) {
      addUnsupported(unsupported, `block_type ${child.block_type} in Callout is unsupported`);
    }
    if ((child.block_type === 12 || child.block_type === 13) && Array.isArray(child.children) && child.children.length > 0) {
      addUnsupported(unsupported, 'nested lists are unsupported');
    }
    if (hasNonTextInline(child)) addUnsupported(unsupported, 'non-text inline element in Callout is unsupported');
    const markdown = feishuBlocksToMarkdown([child], config).trim();
    for (const link of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      if (!/^https?:\/\//i.test((link[1] ?? '').trim())) {
        addUnsupported(unsupported, 'relative links are unsupported');
      }
    }
    return {
      ordinal,
      blockType: child.block_type,
      markdown,
      remoteBlockId: child.block_id
    };
  });

  const shell = asRecord(block.callout);
  return {
    kind: 'callout',
    locator,
    calloutType,
    title: titleBlock ? { markdown: titleMarkdown, remoteBlockId: titleBlock.block_id } : undefined,
    children: body,
    remoteBlockId: block.block_id,
    shell: {
      emojiId: typeof shell?.emoji_id === 'string' ? shell.emoji_id : undefined,
      backgroundColor: optionalNumber(shell?.background_color),
      borderColor: optionalNumber(shell?.border_color),
      textColor: optionalNumber(shell?.text_color)
    },
    unsupported
  };
}

function remoteAsset(block: FeishuBlock, locator: SemanticLocator): SemanticNode {
  const representation = block.block_type === 43 ? 'whiteboard' : 'image';
  const value = asRecord(block[representation]) ?? (representation === 'whiteboard' ? asRecord(block.board) : undefined);
  const token = typeof value?.token === 'string' ? value.token : undefined;
  return {
    kind: 'asset',
    locator,
    representation,
    remoteBlockId: block.block_id,
    remoteToken: token,
    ...(token ? {} : { unsupported: [`remote ${representation} token missing`] })
  };
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
  if (Array.isArray(mergeInfo) && mergeInfo.some(isMergedCellInfo)) {
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
    block.block_type === 13;
}

function isSupportedCalloutBlock(blockType: number): boolean {
  return blockType === 2 ||
    (blockType >= 3 && blockType <= 8) ||
    blockType === 12 ||
    blockType === 13;
}

function hasNonTextInline(block: FeishuBlock): boolean {
  const key = TEXT_KEY_BY_TYPE[block.block_type];
  const value = key ? asRecord(block[key]) : undefined;
  const elements = Array.isArray(value?.elements) ? value.elements : [];
  return elements.some((element) => {
    return Boolean(element && typeof element === 'object' && !Array.isArray(element) && !('text_run' in element));
  });
}

function nextLocator(
  sectionPath: string[],
  kind: SemanticLocator['kind'],
  ordinals: Map<string, number>
): SemanticLocator {
  const stablePath = sectionPath.filter((part): part is string => typeof part === 'string');
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isMergedCellInfo(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const info = asRecord(value);
  if (!info) return true;
  return info.row_span !== 1 || info.col_span !== 1;
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
