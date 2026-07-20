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

  it('matches one renamed row by stable position and unchanged non-key content', () => {
    const remote = table([
      row('scalar', 'Scalar', 'BOOL'),
      row('whole object', 'Object indexing', 'JSON'),
      row('array', 'Array indexing', 'ARRAY')
    ]);
    const local = table([
      row('scalar', 'Scalar', 'BOOL'),
      row('whole object (deprecated)', 'Compatibility only', 'JSON'),
      row('array', 'Array indexing', 'ARRAY')
    ]);

    expect(diffCorrespondingTable(remote, local, { allowSingleRowRename: true })).toEqual({
      kind: 'table-diff',
      additions: [],
      updates: [{
        key: 'whole object (deprecated)',
        changedCellIndexes: [0, 1]
      }],
      blockers: []
    });
  });

  it('does not infer a row rename from one shared generic non-key cell', () => {
    const remote = table([row('whole object', 'Object indexing', 'JSON')]);
    const local = table([row('replacement', 'Compatibility only', 'JSON')]);

    const diff = diffCorrespondingTable(remote, local);

    expect(diff.blockers).toContain('source table deletes remote row: whole object');
    expect(diff.additions).toEqual([{ key: 'replacement', index: 0 }]);
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

  it('reports an explicitly allowed same-width header update', () => {
    const remote = table([row('a', 'A')]);
    const local = {
      ...table([row('a', 'A')]),
      headers: [cell('Parameter'), cell('Description (deprecated)'), cell('Default')]
    };

    expect(diffCorrespondingTable(remote, local, { allowHeaderChanges: true })).toMatchObject({
      headerChanged: true,
      blockers: []
    });
  });

  it('ignores Feishu table-header presentation and trailing empty paragraphs', () => {
    const remote = table([row('ef', 'Old')]);
    remote.headers = remote.headers.map((header) => ({
      blocks: [
        ...header.blocks,
        { kind: 'paragraph', inlines: [] }
      ]
    }));
    const local = table([row('ef', 'Old')]);
    local.headers = local.headers.map((header) => ({
      blocks: header.blocks.map((block) => block.kind === 'paragraph'
        ? {
            ...block,
            inlines: block.inlines.map((inline) => inline.kind === 'text'
              ? { ...inline, marks: { ...inline.marks, bold: true as const } }
              : inline)
          }
        : block)
    }));

    expect(diffCorrespondingTable(remote, local).blockers).not.toContain('table headers differ');
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
