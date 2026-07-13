import { cellPlainText, normalizeHeading, semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type { SemanticDocument, SemanticTable } from '../semantic/types.js';

export type TableRowAddition = { key: string; index: number };
export type TableRowUpdate = { key: string; changedCellIndexes: number[] };
export type TableDiff = {
  kind: 'table-diff';
  additions: TableRowAddition[];
  updates: TableRowUpdate[];
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

export function diffCorrespondingTable(remote: SemanticTable, source: SemanticTable): TableDiff {
  const blockers: string[] = [];
  for (const reason of source.unsupported) addBlocker(blockers, `source table has unsupported content: ${reason}`);
  for (const reason of remote.unsupported) addBlocker(blockers, `remote table has unsupported content: ${reason}`);

  if (remote.headers.length !== source.headers.length || !cellsEquivalent(remote.headers, source.headers)) {
    addBlocker(blockers, 'table headers differ');
  }

  validateKeys(source, 'source', blockers);
  validateKeys(remote, 'remote', blockers);

  const sourceByKey = new Map(source.rows.map((row) => [row.key, row]));
  const remoteByKey = new Map(remote.rows.map((row) => [row.key, row]));
  for (const row of remote.rows) {
    if (!sourceByKey.has(row.key)) addBlocker(blockers, `source table deletes remote row: ${row.key}`);
  }

  const existingSourceOrder = source.rows.filter((row) => remoteByKey.has(row.key)).map((row) => row.key);
  const remoteOrder = remote.rows.map((row) => row.key);
  if (existingSourceOrder.length === remoteOrder.length && existingSourceOrder.some((key, index) => key !== remoteOrder[index])) {
    addBlocker(blockers, 'source table reorders existing rows');
  }

  const additions = source.rows.flatMap((row, index) => {
    return remoteByKey.has(row.key) ? [] : [{ key: row.key, index }];
  });
  const updates = source.rows.flatMap((sourceRow) => {
    const remoteRow = remoteByKey.get(sourceRow.key);
    if (!remoteRow) return [];
    const max = Math.max(sourceRow.cells.length, remoteRow.cells.length);
    const changedCellIndexes = Array.from({ length: max }, (_, index) => index).filter((index) => {
      const sourceCell = sourceRow.cells[index];
      const remoteCell = remoteRow.cells[index];
      if (!sourceCell || !remoteCell) return true;
      return semanticHash(stripExecutionMetadata(sourceCell)) !== semanticHash(stripExecutionMetadata(remoteCell));
    });
    return changedCellIndexes.length > 0 ? [{ key: sourceRow.key, changedCellIndexes }] : [];
  });

  return { kind: 'table-diff', additions, updates, blockers };
}

function cellsEquivalent(left: SemanticTable['headers'], right: SemanticTable['headers']): boolean {
  if (left.length !== right.length) return false;
  return left.every((cell, index) => {
    return semanticHash(stripExecutionMetadata(cell)) === semanticHash(stripExecutionMetadata(right[index]));
  });
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
