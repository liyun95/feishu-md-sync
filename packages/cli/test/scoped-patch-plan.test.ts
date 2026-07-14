import { describe, expect, it } from 'vitest';
import { planScopedPatch } from '../src/publish/scoped-patch-plan.js';
import type {
  SemanticAssetNode,
  SemanticCell,
  SemanticCodeBlock,
  SemanticDocument,
  SemanticTable,
  SemanticTextBlock
} from '../src/semantic/types.js';

describe('scoped patch plan', () => {
  it('combines a text update and table replacement', () => {
    const localBase = document(text('Old paragraph.', 0), table([row('ef', 'Old')], false));
    const localCurrent = document(text('New paragraph.', 0), table([
      row('ef', 'Old'),
      row('num_random_samplings', 'New')
    ], false));
    const remoteBase = document(text('Old paragraph.', 0, 'p1'), table([row('ef', 'Old')], true));
    const remoteCurrent = document(text('Old paragraph.', 0, 'p1'), table([row('ef', 'Old')], true));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase,
      localCurrent,
      remoteBase,
      remoteCurrent,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['update', 'table-replace']);
    expect(plan.operations[1]).toMatchObject({
      kind: 'table-replace',
      remoteBlockId: 'table1',
      diff: { additions: [{ key: 'num_random_samplings', index: 1 }] }
    });
  });

  it('warns about unrelated remote changes without blocking local table work', () => {
    const localBase = document(text('Stable paragraph.', 0), text('Other paragraph.', 1), table([row('ef', 'Old')], false));
    const localCurrent = document(text('Stable paragraph.', 0), text('Other paragraph.', 1), table([row('ef', 'New')], false));
    const remoteBase = document(text('Stable paragraph.', 0, 'p1'), text('Other paragraph.', 1, 'p2'), table([row('ef', 'Old')], true));
    const remoteCurrent = document(text('Stable paragraph.', 0, 'p1'), text('Teammate paragraph.', 1, 'p2'), table([row('ef', 'Old')], true));

    const plan = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent, remoteBase, remoteCurrent, tracked: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toContain('remote changed outside managed scopes');
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['table-replace']);
  });

  it('blocks overlapping table changes and unsupported local tables', () => {
    const localBase = document(table([row('ef', 'Old')], false));
    const localCurrent = document(table([row('ef', 'Local')], false));
    const remoteBase = document(table([row('ef', 'Old')], true));
    const remoteCurrent = document(table([row('ef', 'Remote')], true));

    const conflict = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent, remoteBase, remoteCurrent, tracked: true });
    expect(conflict.blockers).toContainEqual(expect.objectContaining({ code: 'remote-scope-conflict' }));

    const unsupportedCurrent = document({ ...table([row('ef', 'Local')], false), unsupported: ['nested lists are unsupported'] });
    const unsupported = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent: unsupportedCurrent, remoteBase, remoteCurrent: remoteBase, tracked: true });
    expect(unsupported.blockers).toContainEqual(expect.objectContaining({ code: 'unsupported-local-change' }));
    expect(unsupported.safeToWrite).toBe(false);
  });

  it('treats an already-applied desired scope as converged for reruns', () => {
    const localBase = document(table([row('ef', 'Old')], false));
    const localCurrent = document(table([row('ef', 'New')], false));
    const remoteBase = document(table([row('ef', 'Old')], true));
    const remoteCurrent = document(table([row('ef', 'New')], true));

    const plan = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent, remoteBase, remoteCurrent, tracked: true });
    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('blocks whole-table deletion instead of emitting a generic block delete', () => {
    const localBase = document(text('Keep.', 0), table([row('ef', 'Old')], false));
    const localCurrent = document(text('Keep.', 0));
    const remoteBase = document(text('Keep.', 0, 'p1'), table([row('ef', 'Old')], true));
    const remoteCurrent = document(text('Keep.', 0, 'p1'), table([row('ef', 'Old')], true));

    const plan = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent, remoteBase, remoteCurrent, tracked: true });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'unsupported-local-change',
      message: expect.stringContaining('source table deletion is unsupported')
    }));
  });

  it('leaves resource asset slots to the Whiteboard planner', () => {
    const local = document(asset('image'));
    const remote = document(asset('whiteboard', 'wb1', 'wb_token'));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: local,
      localCurrent: local,
      remoteBase: remote,
      remoteCurrent: remote,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('combines ordinary text and first-class Code block updates', () => {
    const localBase = document(text('Old.', 0), code('print(1)\n', 'python'));
    const localCurrent = document(text('New.', 0), code('print(2)\n', 'python'));
    const remoteBase = document(text('Old.', 0), code('print(1)\n', 'python'));
    const remoteCurrent = document(text('Old.', 0, 'p1'), code('print(1)\n', 'python', 'code1'));

    const plan = planScopedPatch({ parentBlockId: 'page', localBase, localCurrent, remoteBase, remoteCurrent, tracked: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['update', 'code-update']);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('anchors text created after a Code block to that Code block', () => {
    const localCurrent = document(
      text('Before.', 0),
      code('print(1)', 'python'),
      text('After.', 1)
    );
    const remoteCurrent = document(
      text('Before.', 0, 'p1'),
      code('print(1)', 'python', 'code1')
    );

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent,
      remoteCurrent,
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'create',
      insertAfterBlockId: 'code1',
      desiredMarkdown: 'After.'
    }));
  });

  it('leaves unchanged headings to the Code reconciler when Code blocks cross them', () => {
    const localBase = document(
      heading('Build', 'h1'),
      code('echo old', 'bash', undefined, ['Build']),
      heading('Search', 'h2'),
      code('print("local")', 'python', undefined, ['Search'])
    );
    const localCurrent = document(
      heading('Build', 'h1'),
      heading('Search', 'h2'),
      code('print("local")', 'python', undefined, ['Search']),
      code('echo rewritten', 'bash', undefined, ['Search'], 1)
    );
    const remoteBase = document(
      heading('Build', 'h1'),
      code('echo old', 'bash', 'code1', ['Build']),
      heading('Search', 'h2'),
      code('print("local")', 'python', 'code2', ['Search'])
    );

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase,
      localCurrent,
      remoteBase,
      remoteCurrent: remoteBase,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: 'code-section-reconcile' }));
    expect(plan.operations.some((operation) => operation.kind === 'update' || operation.kind === 'create' || operation.kind === 'delete')).toBe(false);
  });

  it('fails closed for an untracked indented fenced Code scope', () => {
    const localCurrent = document({
      kind: 'opaque',
      locator: { sectionPath: [], kind: 'opaque', ordinal: 0 },
      description: 'unsupported indented fenced Code block',
      fingerprint: 'opaque-code'
    });

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent,
      remoteCurrent: document(),
      tracked: false
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'unsupported-local-change',
      message: expect.stringContaining('unsupported indented fenced Code block')
    }));
  });
});

function document(...nodes: SemanticDocument['nodes']): SemanticDocument {
  return { nodes };
}

function text(markdown: string, ordinal: number, remoteBlockId?: string): SemanticTextBlock {
  return {
    kind: 'text',
    locator: { sectionPath: [], kind: 'text', ordinal },
    blockType: 2,
    markdown,
    remoteBlockId
  };
}

function code(
  content: string,
  language: string,
  remoteBlockId?: string,
  sectionPath: string[] = [],
  ordinal = 0
): SemanticCodeBlock {
  return {
    kind: 'code',
    locator: { sectionPath, kind: 'code', ordinal },
    content,
    sourceLanguage: language,
    resolvedLanguage: language,
    remoteBlockId,
    issues: []
  };
}

function heading(title: string, remoteBlockId?: string): SemanticTextBlock {
  return {
    kind: 'text',
    locator: { sectionPath: [title], kind: 'text', ordinal: 0 },
    blockType: 3,
    markdown: `# ${title}`,
    remoteBlockId
  };
}

function asset(
  representation: SemanticAssetNode['representation'],
  remoteBlockId?: string,
  remoteToken?: string
): SemanticAssetNode {
  return {
    kind: 'asset',
    locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
    representation,
    source: representation === 'image' ? './diagram.png' : undefined,
    remoteBlockId,
    remoteToken
  };
}

function table(rows: SemanticTable['rows'], remote: boolean): SemanticTable {
  return {
    kind: 'table',
    locator: { sectionPath: ['Index params'], kind: 'table', ordinal: 0 },
    headers: [cell('Parameter'), cell('Description')],
    rows,
    remoteBlockId: remote ? 'table1' : undefined,
    unsupported: []
  };
}

function row(key: string, description: string): SemanticTable['rows'][number] {
  return { key, cells: [cell(key), cell(description)] };
}

function cell(value: string): SemanticCell {
  return { blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value }] }] };
}
