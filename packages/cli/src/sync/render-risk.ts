import type { FeishuBlock, TextElement } from '../feishu/types.js';

export type TableRenderSummary = {
  index: number;
  rows: number;
  columns: number;
  headerCellCount: number;
  headerBoldCells: number;
};

export type RenderRiskReport = {
  rawHtmlTableInSource: boolean;
  rawHtmlTextBlockCount: number;
  duplicateH1: string[];
  referencesHeadingLevel: 2 | 'missing' | 'wrong-level';
  tableBlockCount: number;
  tableSummaries: TableRenderSummary[];
  risks: string[];
};

export type RenderRiskInput = {
  sourceMarkdown: string;
  desiredBlocks: FeishuBlock[];
  remoteBlocks?: FeishuBlock[];
};

export function analyzeRenderRisks(input: RenderRiskInput): RenderRiskReport {
  const sourceWithoutCode = stripFencedCode(input.sourceMarkdown);
  const rawHtmlTableInSource = /<\s*table\b/i.test(sourceWithoutCode);
  const blocksForReadback = input.remoteBlocks ?? input.desiredBlocks;
  const rawHtmlTextBlockCount = countRawHtmlTextBlocks(blocksForReadback);
  const duplicateH1 = findDuplicateH1(input.desiredBlocks);
  const referencesHeadingLevel = findReferencesHeadingLevel(input.desiredBlocks);
  const tableSummaries = summarizeTables(input.desiredBlocks);
  const risks: string[] = [];

  if (rawHtmlTableInSource) {
    risks.push('source contains raw <table> HTML');
  }
  if (rawHtmlTextBlockCount > 0) {
    risks.push('remote contains raw <table>/<td> text blocks');
  }
  for (const heading of duplicateH1) {
    risks.push(`duplicate H1: ${heading}`);
  }
  if (referencesHeadingLevel === 'missing') {
    risks.push('missing H2 References');
  } else if (referencesHeadingLevel === 'wrong-level') {
    risks.push('References exists but is not H2');
  }
  for (const table of tableSummaries) {
    if (table.headerCellCount > 0 && table.headerBoldCells < table.headerCellCount) {
      risks.push(`table ${table.index} has ${table.headerBoldCells}/${table.headerCellCount} bold header cells`);
    }
  }

  return {
    rawHtmlTableInSource,
    rawHtmlTextBlockCount,
    duplicateH1,
    referencesHeadingLevel,
    tableBlockCount: tableSummaries.length,
    tableSummaries,
    risks
  };
}

export function renderRiskSummaryLines(report: RenderRiskReport): string[] {
  const lines = [
    report.risks.length === 0
      ? 'Render risks: none detected'
      : `Render risks: ${report.risks.join('; ')}`
  ];

  lines.push(`Tables: ${report.tableBlockCount} Feishu table block(s)`);
  for (const table of report.tableSummaries) {
    lines.push(`- table ${table.index}: ${table.rows} rows x ${table.columns} columns, header bold ${table.headerBoldCells}/${table.headerCellCount}`);
  }

  return lines;
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

function countRawHtmlTextBlocks(blocks: FeishuBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.block_type === 2 && /<\s*(table|td)\b/i.test(blockText(block))) {
      count += 1;
    }
    for (const child of childBlocks(block)) {
      count += countRawHtmlTextBlocks([child]);
    }
  }
  return count;
}

function findDuplicateH1(blocks: FeishuBlock[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const block of flattenBlocks(blocks)) {
    if (block.block_type !== 3) continue;
    const text = blockText(block).trim();
    if (!text) continue;
    if (seen.has(text)) duplicates.add(text);
    seen.add(text);
  }
  return Array.from(duplicates);
}

function findReferencesHeadingLevel(blocks: FeishuBlock[]): 2 | 'missing' | 'wrong-level' {
  let foundWrongLevel = false;
  for (const block of flattenBlocks(blocks)) {
    if (block.block_type < 3 || block.block_type > 8) continue;
    if (blockText(block).trim().toLowerCase() !== 'references') continue;
    if (block.block_type === 4) return 2;
    foundWrongLevel = true;
  }
  return foundWrongLevel ? 'wrong-level' : 'missing';
}

function summarizeTables(blocks: FeishuBlock[]): TableRenderSummary[] {
  const tables = flattenBlocks(blocks).filter((block) => block.block_type === 31);
  return tables.map((block, index) => {
    const table = block.table as { property?: { row_size?: number; column_size?: number }; cells?: FeishuBlock[] } | undefined;
    const rows = table?.property?.row_size ?? 0;
    const columns = table?.property?.column_size ?? 0;
    const headerCells = (table?.cells ?? []).slice(0, columns);
    return {
      index: index + 1,
      rows,
      columns,
      headerCellCount: headerCells.length,
      headerBoldCells: headerCells.filter(cellHeaderIsBold).length
    };
  });
}

function cellHeaderIsBold(block: FeishuBlock): boolean {
  const elements = textElementsForBlock(block);
  return elements.length > 0 && elements.every((element) => element.text_run?.text_element_style?.bold === true);
}

function blockText(block: FeishuBlock): string {
  return textElementsForBlock(block).map((element) => element.text_run?.content ?? '').join('');
}

function textElementsForBlock(block: FeishuBlock): TextElement[] {
  if (block.block_type >= 3 && block.block_type <= 8) {
    const level = block.block_type - 2;
    return ((block[`heading${level}`] as { elements?: TextElement[] } | undefined)?.elements) ?? [];
  }
  if (block.block_type === 2) {
    return ((block.text as { elements?: TextElement[] } | undefined)?.elements) ?? [];
  }
  if (block.block_type === 12) {
    return ((block.bullet as { elements?: TextElement[] } | undefined)?.elements) ?? [];
  }
  if (block.block_type === 13) {
    return ((block.ordered as { elements?: TextElement[] } | undefined)?.elements) ?? [];
  }
  return [];
}

function flattenBlocks(blocks: FeishuBlock[]): FeishuBlock[] {
  return blocks.flatMap((block) => [block, ...flattenBlocks(childBlocks(block))]);
}

function childBlocks(block: FeishuBlock): FeishuBlock[] {
  return Array.isArray(block.children) ? block.children.filter(isBlock) : [];
}

function isBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}
