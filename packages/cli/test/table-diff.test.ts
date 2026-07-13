import { describe, expect, it } from 'vitest';
import { diffCorrespondingTable, findCorrespondingRemoteTable, tableIdentity } from '../src/publish/table-diff.js';
import type { SemanticCell, SemanticDocument, SemanticTable } from '../src/semantic/types.js';

describe('table correspondence and diff', () => {
  it('detects row additions', () => {
    const remote = table([
      row('itopk_size', 'Old'),
      row('search_width', 'Old')
    ]);
    const local = table([
      row('itopk_size', 'Old'),
      row('search_width', 'Old'),
      row('num_random_samplings', 'New')
    ]);

    expect(diffCorrespondingTable(remote, local)).toEqual({
      kind: 'table-diff',
      additions: [{ key: 'num_random_samplings', index: 2 }],
      updates: [],
      blockers: []
    });
  });

  it('detects changed cells in existing rows', () => {
    const remote = table([row('ef', 'Old', '0')]);
    const local = table([row('ef', 'New', '0')]);

    expect(diffCorrespondingTable(remote, local).updates).toEqual([{
      key: 'ef',
      changedCellIndexes: [1]
    }]);
  });

  it('blocks deletion, reorder, unsupported content, and header changes', () => {
    const remote = table([row('a', 'A'), row('b', 'B')]);
    const deleted = table([row('a', 'A')]);
    const reordered = table([row('b', 'B'), row('a', 'A')]);
    const unsupported = table([row('a', 'A'), row('b', 'B')], ['nested lists are unsupported']);
    const changedHeader = { ...table([row('a', 'A'), row('b', 'B')]), headers: [cell('Name'), cell('Description')] };

    expect(diffCorrespondingTable(remote, deleted).blockers).toContain('source table deletes remote row: b');
    expect(diffCorrespondingTable(remote, reordered).blockers).toContain('source table reorders existing rows');
    expect(diffCorrespondingTable(remote, unsupported).blockers).toContain('source table has unsupported content: nested lists are unsupported');
    expect(diffCorrespondingTable(remote, changedHeader).blockers).toContain('table headers differ');
  });

  it('matches one remote table and reports ambiguity', () => {
    const source = table([row('ef', 'Value')]);
    const one: SemanticDocument = { nodes: [{ ...source, remoteBlockId: 'table1' }] };
    const two: SemanticDocument = { nodes: [
      { ...source, remoteBlockId: 'table1' },
      { ...source, remoteBlockId: 'table2' }
    ] };

    expect(findCorrespondingRemoteTable(source, one).table?.remoteBlockId).toBe('table1');
    expect(findCorrespondingRemoteTable(source, two).blocker).toBe(`table correspondence ambiguous: ${tableIdentity(source)}`);
  });
});

function table(rows: SemanticTable['rows'], unsupported: string[] = []): SemanticTable {
  return {
    kind: 'table',
    locator: {
      sectionPath: ['Index params', 'Index-specific search params'],
      kind: 'table',
      ordinal: 0
    },
    headers: [cell('Parameter'), cell('Description'), cell('Default')],
    rows,
    unsupported
  };
}

function row(key: string, description: string, defaultValue = 'Empty'): SemanticTable['rows'][number] {
  return { key, cells: [cell(key), cell(description), cell(defaultValue)] };
}

function cell(value: string): SemanticCell {
  return { blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value }] }] };
}
