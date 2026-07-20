import {
  canonicalizeAuthoringIncludeMarkup,
  cellPlainText,
  normalizeHeading,
  semanticHash,
  stripExecutionMetadata
} from '../semantic/normalize.js';
import type { SemanticCell, SemanticDocument, SemanticRow, SemanticTable } from '../semantic/types.js';

export type TableRowAddition = { key: string; index: number };
export type TableRowUpdate = { key: string; changedCellIndexes: number[] };
export type TableDiff = {
  kind: 'table-diff';
  additions: TableRowAddition[];
  updates: TableRowUpdate[];
  headerChanged?: true;
  blockers: string[];
};

export function tableIdentity(table: SemanticTable): string {
  const path = table.locator.sectionPath.map(normalizeHeading).join(' > ') || '<root>';
  const headers = table.headers.map((cell) => normalizeHeading(cellPlainText(cell))).join(' | ');
  return `${path} [${table.locator.ordinal}] :: ${headers}`;
}

export function tablesCorrespond(source: SemanticTable, remote: SemanticTable): boolean {
  if (tableIdentity(source) !== tableIdentity(remote)) return false;
  const sourceKeys = new Set(source.rows.map((row) => row.key));
  const remoteKeys = remote.rows.map((row) => row.key);
  if (sourceKeys.size === 0 && remoteKeys.length === 0) return true;
  return remoteKeys.some((key) => sourceKeys.has(key));
}

export function findCorrespondingRemoteTable(
  source: SemanticTable,
  remoteDocument: SemanticDocument
): { table?: SemanticTable; blocker?: string } {
  const matches = remoteDocument.nodes.filter((node): node is SemanticTable => {
    return node.kind === 'table' && tablesCorrespond(source, node);
  });
  const identity = tableIdentity(source);
  if (matches.length === 0) return { blocker: `table correspondence missing: ${identity}` };
  if (matches.length > 1) return { blocker: `table correspondence ambiguous: ${identity}` };
  return { table: matches[0] };
}

export function diffCorrespondingTable(
  remote: SemanticTable,
  source: SemanticTable,
  options: { allowHeaderChanges?: boolean; allowSingleRowRename?: boolean } = {}
): TableDiff {
  const blockers: string[] = [];
  for (const reason of source.unsupported) addBlocker(blockers, `source table has unsupported content: ${reason}`);
  for (const reason of remote.unsupported) addBlocker(blockers, `remote table has unsupported content: ${reason}`);

  const headerChanged = !cellsEquivalent(remote.headers, source.headers);
  if (remote.headers.length !== source.headers.length || (headerChanged && !options.allowHeaderChanges)) {
    addBlocker(blockers, 'table headers differ');
  }

  validateKeys(source, 'source', blockers);
  validateKeys(remote, 'remote', blockers);

  const sourceByKey = new Map(source.rows.map((row) => [row.key, row]));
  const remoteByKey = new Map(remote.rows.map((row) => [row.key, row]));
  const correspondingRemoteRows = new Map<string, SemanticRow>();
  for (const row of source.rows) {
    const remoteRow = remoteByKey.get(row.key);
    if (remoteRow) correspondingRemoteRows.set(row.key, remoteRow);
  }
  const unmatchedSource = source.rows.filter((row) => !remoteByKey.has(row.key));
  const unmatchedRemote = remote.rows.filter((row) => !sourceByKey.has(row.key));
  if (options.allowSingleRowRename && unmatchedSource.length === 1 && unmatchedRemote.length === 1) {
    const sourceRow = unmatchedSource[0]!;
    const remoteRow = unmatchedRemote[0]!;
    const sourceIndex = source.rows.indexOf(sourceRow);
    const remoteIndex = remote.rows.indexOf(remoteRow);
    const hasStableNonKeyCell = sourceRow.cells.slice(1).some((cell, index) => {
      const remoteCell = remoteRow.cells[index + 1];
      return remoteCell ? tableCellsSemanticallyEquivalent(cell, remoteCell) : false;
    });
    if (source.rows.length === remote.rows.length && sourceIndex === remoteIndex &&
      sourceRow.cells.length === remoteRow.cells.length && hasStableNonKeyCell) {
      correspondingRemoteRows.set(sourceRow.key, remoteRow);
    }
  }
  const matchedRemoteKeys = new Set([...correspondingRemoteRows.values()].map((row) => row.key));
  for (const row of remote.rows) {
    if (!matchedRemoteKeys.has(row.key)) addBlocker(blockers, `source table deletes remote row: ${row.key}`);
  }

  const existingSourceOrder = source.rows.flatMap((row) => {
    const remoteRow = correspondingRemoteRows.get(row.key);
    return remoteRow ? [remoteRow.key] : [];
  });
  const remoteOrder = remote.rows.map((row) => row.key);
  if (existingSourceOrder.length === remoteOrder.length && existingSourceOrder.some((key, index) => key !== remoteOrder[index])) {
    addBlocker(blockers, 'source table reorders existing rows');
  }

  const additions = source.rows.flatMap((row, index) => {
    return correspondingRemoteRows.has(row.key) ? [] : [{ key: row.key, index }];
  });
  const updates = source.rows.flatMap((sourceRow) => {
    const remoteRow = correspondingRemoteRows.get(sourceRow.key);
    if (!remoteRow) return [];
    const max = Math.max(sourceRow.cells.length, remoteRow.cells.length);
    const changedCellIndexes = Array.from({ length: max }, (_, index) => index).filter((index) => {
      const sourceCell = sourceRow.cells[index];
      const remoteCell = remoteRow.cells[index];
      if (!sourceCell || !remoteCell) return true;
      return !tableCellsSemanticallyEquivalent(sourceCell, remoteCell);
    });
    return changedCellIndexes.length > 0 ? [{ key: sourceRow.key, changedCellIndexes }] : [];
  });

  return {
    kind: 'table-diff',
    additions,
    updates,
    ...(headerChanged && remote.headers.length === source.headers.length ? { headerChanged: true as const } : {}),
    blockers
  };
}

export function preserveEquivalentRemoteTableRepresentation(
  source: SemanticTable,
  remote: SemanticTable
): SemanticTable {
  const remoteByKey = new Map(remote.rows.map((row) => [row.key, row]));
  return {
    ...source,
    headers: cellsEquivalent(remote.headers, source.headers) ? remote.headers : source.headers,
    rows: source.rows.map((row) => {
      const remoteRow = remoteByKey.get(row.key);
      if (!remoteRow || remoteRow.cells.length !== row.cells.length) return row;
      return {
        ...row,
        cells: row.cells.map((cell, index) => {
          const remoteCell = remoteRow.cells[index];
          return remoteCell && tableCellsSemanticallyEquivalent(cell, remoteCell) ? remoteCell : cell;
        })
      };
    })
  };
}

function cellsEquivalent(left: SemanticTable['headers'], right: SemanticTable['headers']): boolean {
  if (left.length !== right.length) return false;
  return left.every((cell, index) => {
    return semanticHash(normalizeHeaderCell(cell)) === semanticHash(normalizeHeaderCell(right[index]!));
  });
}

function normalizeHeaderCell(cell: SemanticTable['headers'][number]): SemanticTable['headers'][number] {
  return normalizeCell(cell, true);
}

export function tableCellsSemanticallyEquivalent(left: SemanticCell, right: SemanticCell): boolean {
  return semanticHash(normalizeCell(left, false)) === semanticHash(normalizeCell(right, false));
}

export function tableHeaderCellsSemanticallyEquivalent(
  left: SemanticCell,
  right: SemanticCell
): boolean {
  return semanticHash(normalizeHeaderCell(left)) === semanticHash(normalizeHeaderCell(right));
}

function normalizeCell(cell: SemanticCell, ignoreBold: boolean): SemanticCell {
  const blocks = stripExecutionMetadata(cell).blocks.map((block) => {
    if (block.kind !== 'paragraph') return block;
    return {
      ...block,
      inlines: block.inlines.map((inline) => {
        if (inline.kind === 'text') {
          inline = { ...inline, value: canonicalizeAuthoringIncludeMarkup(inline.value) };
        }
        if (!ignoreBold || inline.kind !== 'text' || !inline.marks?.bold) return inline;
        const { bold: _bold, ...marks } = inline.marks;
        const { marks: _marks, ...text } = inline;
        return {
          ...text,
          ...(Object.keys(marks).length > 0 ? { marks } : {})
        };
      })
    };
  });
  while (true) {
    const last = blocks.at(-1);
    if (last?.kind !== 'paragraph' || last.inlines.length > 0) break;
    blocks.pop();
  }
  return { blocks };
}

function validateKeys(table: SemanticTable, side: 'source' | 'remote', blockers: string[]): void {
  const counts = new Map<string, number>();
  for (const row of table.rows) {
    if (!row.key) addBlocker(blockers, `${side} table has empty row key`);
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (key && count > 1) addBlocker(blockers, `${side} table has duplicate row key: ${key}`);
  }
}

function addBlocker(blockers: string[], message: string): void {
  if (!blockers.includes(message)) blockers.push(message);
}
