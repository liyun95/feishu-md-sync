import { describe, expect, it } from 'vitest';
import { planScopedPatch } from '../src/publish/scoped-patch-plan.js';
import { localSemanticDocument } from '../src/semantic/local-document.js';
import { remoteSemanticDocument } from '../src/semantic/remote-document.js';
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

  it('uses L0 to R0 correspondence to plan an expected table header change', () => {
    const localBaseTable = table([row('json', 'Whole object')], false);
    const localCurrentTable = {
      ...table([row('json', 'Whole object')], false),
      headers: [cell('Parameter'), cell('Description (deprecated)')]
    };
    const remoteBaseTable = table([row('json', 'Whole object')], false);
    const remoteCurrentTable = table([row('json', 'Whole object')], true);

    const plan = planScopedPatch({
      parentBlockId: 'doc',
      localBase: document(localBaseTable),
      localCurrent: document(localCurrentTable),
      remoteBase: document(remoteBaseTable),
      remoteCurrent: document(remoteCurrentTable),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'table-replace',
      remoteBlockId: 'table1',
      diff: expect.objectContaining({ headerChanged: true })
    }));
  });

  it('allows a single local row rename only through tracked L0/R0 correspondence', () => {
    const localBaseTable = table([row('whole object', 'Object indexing', 'JSON')], false);
    const localCurrentTable = table([
      row('whole object (deprecated)', 'Compatibility only', 'JSON')
    ], false);
    const remoteTable = table([row('whole object', 'Object indexing', 'JSON')], true);

    const plan = planScopedPatch({
      parentBlockId: 'doc',
      localBase: document(localBaseTable),
      localCurrent: document(localCurrentTable),
      remoteBase: document(remoteTable),
      remoteCurrent: document(remoteTable),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'table-replace',
      remoteBlockId: 'table1',
      diff: expect.objectContaining({
        updates: [{ key: 'whole object (deprecated)', changedCellIndexes: [0, 1] }],
        blockers: []
      })
    }));
  });

  it('preserves equivalent remote table-cell authoring markup during replacement', () => {
    const localBaseTable = table([
      row('stable', 'Milvus chooses the layout.'),
      row('changed', 'Old')
    ], false);
    const localCurrentTable = table([
      row('stable', 'Milvus chooses the layout.'),
      row('changed', 'New')
    ], false);
    const remoteTable = table([
      row('stable', '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> chooses the layout.'),
      row('changed', 'Old')
    ], true);

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(localBaseTable),
      localCurrent: document(localCurrentTable),
      remoteBase: document(remoteTable),
      remoteCurrent: document(remoteTable),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'table-replace',
      desiredTable: expect.objectContaining({
        rows: expect.arrayContaining([
          expect.objectContaining({
            key: 'stable',
            cells: expect.arrayContaining([
              expect.objectContaining({
                blocks: [expect.objectContaining({
                  inlines: [expect.objectContaining({ value: expect.stringContaining('<include target="milvus">') })]
                })]
              })
            ])
          })
        ])
      })
    }));
  });

  it('applies only the local table delta while preserving historical R0 cells and rows', () => {
    const localBaseTable = table([
      row('stable', 'Local baseline wording'),
      row('changed', 'Old')
    ], false);
    const localCurrentTable = table([
      row('stable', 'Local baseline wording'),
      row('changed', 'New')
    ], false);
    const remoteTable = table([
      row('stable', 'Remote historical wording'),
      row('changed', 'Old'),
      row('remote-only', 'Preserve me')
    ], true);

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(localBaseTable),
      localCurrent: document(localCurrentTable),
      remoteBase: document({ ...remoteTable, remoteBlockId: undefined }),
      remoteCurrent: document(remoteTable),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'table-replace',
      desiredTable: expect.objectContaining({
        rows: [
          expect.objectContaining({ key: 'stable', cells: expect.arrayContaining([
            expect.objectContaining({ blocks: [expect.objectContaining({
              inlines: [expect.objectContaining({ value: 'Remote historical wording' })]
            })] })
          ]) }),
          expect.objectContaining({ key: 'changed', cells: expect.arrayContaining([
            expect.objectContaining({ blocks: [expect.objectContaining({
              inlines: [expect.objectContaining({ value: 'New' })]
            })] })
          ]) }),
          expect.objectContaining({ key: 'remote-only' })
        ]
      }),
      diff: expect.objectContaining({
        updates: [{ key: 'changed', changedCellIndexes: [1] }],
        blockers: []
      })
    }));
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

  it('preserves remote-only baseline text when L0 and R0 intentionally diverge', () => {
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text('Local baseline.', 0)),
      localCurrent: document(text('Local baseline.', 0)),
      remoteBase: document(text('Local baseline.', 0), text('Remote-only history.', 1)),
      remoteCurrent: document(
        text('Local baseline.', 0, 'p1'),
        text('Remote-only history.', 1, 'p2')
      ),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('blocks deleting tracked text that changed remotely after R0', () => {
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text('Keep.', 0), text('Delete locally.', 1)),
      localCurrent: document(text('Keep.', 0)),
      remoteBase: document(text('Keep.', 0, 'p1'), text('Delete locally.', 1, 'p2')),
      remoteCurrent: document(text('Keep.', 0, 'p1'), text('Teammate edited this.', 1, 'p2')),
      tracked: true
    });

    expect(plan.operations).not.toContainEqual(expect.objectContaining({ kind: 'delete' }));
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'remote-scope-conflict',
      locator: { sectionPath: [], kind: 'text', ordinal: 1 }
    }));
  });

  it('blocks a changed L0 text scope that has no R0 correspondence', () => {
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text('Old local-only text.', 0)),
      localCurrent: document(text('New local-only text.', 0)),
      remoteBase: document(),
      remoteCurrent: document(),
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'unsupported-local-change',
      message: expect.stringContaining('tracked text correspondence is missing')
    }));
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

  it('fails closed when a recorded table loss has no unique stable sequence anchor', () => {
    const localBase = document(
      sectionText('A.', ['Index params'], 0),
      table([row('ef', 'Accuracy trade-off.')], false),
      sectionText('B.', ['Index params'], 1)
    );
    const localCurrent = document(...localBase.nodes);
    const remoteBase = document(
      sectionText('B.', ['Index params'], 0),
      sectionText('B.', ['Index params'], 1),
      sectionText('B.', ['Index params'], 2)
    );
    const remoteCurrent = document(
      sectionText('B.', ['Index params'], 0, 'b0'),
      sectionText('B.', ['Index params'], 1, 'b1'),
      sectionText('B.', ['Index params'], 2, 'b2')
    );

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase,
      localCurrent,
      remoteBase,
      remoteCurrent,
      tracked: true
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-ambiguous',
      message: expect.stringContaining('baseline divergence is ambiguous')
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

  it('plans scattered tracked text updates with one inserted block', () => {
    const localBase = document(
      text('Old intro.', 0),
      text('Old combined guidance.', 1),
      text('Stable ending.', 2)
    );
    const localCurrent = document(
      text('New intro.', 0),
      text('Array guidance.', 1),
      text('Whole-object compatibility guidance.', 2),
      text('Stable ending.', 3)
    );
    const remoteBase = document(
      text('Old intro.', 0, 'p1'),
      text('Old combined guidance.', 1, 'p2'),
      text('Stable ending.', 2, 'p3')
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
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'update', remoteBlockId: 'p1', desiredMarkdown: 'New intro.' }),
      expect.objectContaining({ kind: 'update', remoteBlockId: 'p2', desiredMarkdown: 'Array guidance.' }),
      expect.objectContaining({
        kind: 'create',
        insertAfterBlockId: 'p2',
        desiredMarkdown: 'Whole-object compatibility guidance.'
      })
    ]);
  });

  it('blocks tracked insertion correspondence when repeated text identities are ambiguous', () => {
    const localBase = document(
      text('Intro.', 0),
      text('Repeated.', 1),
      text('Repeated.', 2)
    );
    const localCurrent = document(
      text('Intro.', 0),
      text('Inserted.', 1),
      text('Repeated.', 2),
      text('Repeated.', 3)
    );
    const remoteBase = remoteize(localBase);

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase,
      localCurrent,
      remoteBase,
      remoteCurrent: remoteBase,
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'unsupported-local-change',
      message: expect.stringContaining('tracked correspondence is ambiguous for repeated blocks')
    }));
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

  it('plans a parent-aware nested list repair instead of preserving flat root siblings', () => {
    const localCurrent = localSemanticDocument(`# Before you start

- **Parent**

    Child paragraph.

    - Nested bullet.
    1. Nested ordered.
`);
    const remoteCurrent = remoteize(localSemanticDocument(`# Before you start

- **Parent**

Child paragraph.

- Nested bullet.

1. Nested ordered.
`));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent,
      remoteCurrent,
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'create',
        parentBlockId: 'page',
        insertAfterBlockId: 'block-0',
        desiredMarkdown: expect.stringContaining('    Child paragraph.'),
        desiredBlocks: [expect.objectContaining({ blockType: 12 })]
      }),
      expect.objectContaining({
        kind: 'delete',
        parentBlockId: 'page',
        blockIds: ['block-1', 'block-2', 'block-3', 'block-4']
      })
    ]);
  });

  it('updates a nested child paragraph through its stable parent and block IDs', () => {
    const baseline = `- **Parent**

    Child paragraph.

    - Nested bullet.
`;
    const desired = `- **Parent**

    Updated child paragraph.

    - Nested bullet.
`;
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: localSemanticDocument(baseline),
      localCurrent: localSemanticDocument(desired),
      remoteBase: localSemanticDocument(baseline),
      remoteCurrent: nestedRemoteDocument('Child paragraph.'),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([expect.objectContaining({
      kind: 'update',
      parentBlockId: 'parent',
      remoteBlockId: 'child',
      locator: { sectionPath: [], kind: 'text', ordinal: 0, textPath: [0] },
      desiredMarkdown: 'Updated child paragraph.'
    })]);
  });

  it('deletes a nested list child through its stable parent ID', () => {
    const baseline = `- **Parent**

    Child paragraph.

    - Nested bullet.
`;
    const desired = `- **Parent**

    Child paragraph.
`;
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: localSemanticDocument(baseline),
      localCurrent: localSemanticDocument(desired),
      remoteBase: localSemanticDocument(baseline),
      remoteCurrent: nestedRemoteDocument('Child paragraph.'),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(plan.operations).toEqual([expect.objectContaining({
      kind: 'delete',
      parentBlockId: 'parent',
      blockIds: ['nested'],
      locator: { sectionPath: [], kind: 'text', ordinal: 0, textPath: [1] }
    })]);
  });

  it('blocks recorded hierarchy repair after local or remote drift', () => {
    const baseline = localSemanticDocument(`- **Parent**

    Child paragraph.

    - Nested bullet.
`);
    const changedLocal = localSemanticDocument(`- **Parent**

    Locally changed paragraph.

    - Nested bullet.
`);
    const flatBaseline = remoteize(localSemanticDocument(`- **Parent**

Child paragraph.

- Nested bullet.
`));
    const flatRemoteDrift = remoteize(localSemanticDocument(`- **Parent**

Teammate changed paragraph.

- Nested bullet.
`));

    const localDrift = planScopedPatch({
      parentBlockId: 'page',
      localBase: baseline,
      localCurrent: changedLocal,
      remoteBase: flatBaseline,
      remoteCurrent: flatBaseline,
      tracked: true
    });
    const remoteDrift = planScopedPatch({
      parentBlockId: 'page',
      localBase: baseline,
      localCurrent: baseline,
      remoteBase: flatBaseline,
      remoteCurrent: flatRemoteDrift,
      tracked: true
    });

    expect(localDrift.blockers).toContainEqual(expect.objectContaining({ code: 'round-trip-loss-ambiguous' }));
    expect(remoteDrift.blockers).toContainEqual(expect.objectContaining({ code: 'round-trip-loss-ambiguous' }));
    expect(localDrift.safeToWrite).toBe(false);
    expect(remoteDrift.safeToWrite).toBe(false);
  });

  it('repairs consecutive recorded hierarchy groups after consuming each flat descendant sequence', () => {
    const nested = localSemanticDocument(`# Before you start

Intro.

- **First requirement**

    First detail.

    Second detail.

- **Second requirement**

    Second intro.

    - Nested one.
    - Nested two.
    1. Nested ordered.

    Second follow-up.

    Second conclusion.

- **Third requirement**

    Third detail.
`);
    const flat = remoteize(localSemanticDocument(`# Before you start

Intro.

- **First requirement**

First detail.

Second detail.

- **Second requirement**

Second intro.

- Nested one.

- Nested two.

1. Nested ordered.

Second follow-up.

Second conclusion.

- **Third requirement**

Third detail.
`));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: nested,
      localCurrent: nested,
      remoteBase: flat,
      remoteCurrent: flat,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.roundTripLosses).toEqual([
      expect.objectContaining({
        action: 'repair-text-hierarchy',
        locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 2 }
      }),
      expect.objectContaining({
        action: 'repair-text-hierarchy',
        locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 3 }
      }),
      expect.objectContaining({
        action: 'repair-text-hierarchy',
        locator: { sectionPath: ['Before you start'], kind: 'text', ordinal: 4 }
      })
    ]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'create',
        parentBlockId: 'page',
        insertAfterBlockId: 'block-1',
        desiredBlocks: [
          expect.objectContaining({ markdown: expect.stringContaining('First detail.') }),
          expect.objectContaining({ markdown: expect.stringContaining('Nested ordered.') }),
          expect.objectContaining({ markdown: expect.stringContaining('Third detail.') })
        ]
      }),
      expect.objectContaining({
        kind: 'delete',
        parentBlockId: 'page',
        blockIds: Array.from({ length: 12 }, (_, index) => `block-${index + 2}`)
      })
    ]);
  });

  it('blocks consecutive recorded hierarchy repair when a consumed descendant drifts', () => {
    const nested = localSemanticDocument(`- **First**

    First detail.

- **Second**

    Second detail.

    - Nested requirement.

- **Third**

    Third detail.
`);
    const flatBaseline = remoteize(localSemanticDocument(`- **First**

First detail.

- **Second**

Second detail.

- Nested requirement.

- **Third**

Third detail.
`));
    const flatDrift = remoteize(localSemanticDocument(`- **First**

First detail.

- **Second**

Teammate changed detail.

- Nested requirement.

- **Third**

Third detail.
`));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: nested,
      localCurrent: nested,
      remoteBase: flatBaseline,
      remoteCurrent: flatDrift,
      tracked: true
    });

    expect(plan.safeToWrite).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'round-trip-loss-ambiguous'
    }));
    expect(plan.roundTripLosses).not.toContainEqual(expect.objectContaining({
      action: 'repair-text-hierarchy'
    }));
  });

  it('recovers the observed malformed Markdown tree create before the unchanged flat baseline', () => {
    const nested = localSemanticDocument(`# Before you start

Intro.

- **First requirement**

    First detail.

    Second detail.

- **Second requirement**

    Second intro.

    - Nested one.
    - Nested two.
    - Nested three.

    Second follow-up.

    Second conclusion.

- **Third requirement**

    Third detail.

# After
`);
    const flat = remoteize(localSemanticDocument(`# Before you start

Intro.

- **First requirement**

First detail.

Second detail.

- **Second requirement**

Second intro.

- Nested one.

- Nested two.

- Nested three.

Second follow-up.

Second conclusion.

- **Third requirement**

Third detail.

# After
`));
    const malformed = remoteizeWithChildIds(localSemanticDocument(`# Before you start

Intro.

- **First requirement**First detail.Second detail.

- **Second requirement**Second intro.

    - Nested one.

    - Nested two.

    - Nested three.

- **Third requirement**Third detail.

- **First requirement**

First detail.

Second detail.

- **Second requirement**

Second intro.

- Nested one.

- Nested two.

- Nested three.

Second follow-up.

Second conclusion.

- **Third requirement**

Third detail.

# After
`));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: nested,
      localCurrent: nested,
      remoteBase: flat,
      remoteCurrent: malformed,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.roundTripLosses.filter((loss) => loss.action === 'repair-text-hierarchy')).toHaveLength(3);
    expect(plan.warnings).toContain('recovering exact malformed scoped create at ["Before you start"]');
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'create',
        insertAfterBlockId: 'tree-2',
        desiredBlocks: expect.arrayContaining([
          expect.objectContaining({ markdown: expect.stringContaining('Second conclusion.') })
        ])
      }),
      expect.objectContaining({
        kind: 'delete',
        recovery: expect.objectContaining({
          expectedDescendantBlockIds: ['tree-5', 'tree-6', 'tree-7']
        })
      })
    ]);

    const drifted = {
      nodes: malformed.nodes.map((node) => {
        if (node.kind !== 'text' || !node.markdown.includes('Second requirement')) return node;
        return {
          ...node,
          markdown: node.markdown.replace('Nested two.', 'Teammate changed nested two.'),
          children: node.children?.map((child) => child.markdown.includes('Nested two.')
            ? { ...child, markdown: child.markdown.replace('Nested two.', 'Teammate changed nested two.') }
            : child)
        };
      })
    };
    const driftedPlan = planScopedPatch({
      parentBlockId: 'page',
      localBase: nested,
      localCurrent: nested,
      remoteBase: flat,
      remoteCurrent: drifted,
      tracked: true
    });
    expect(driftedPlan.safeToWrite).toBe(false);
    expect(driftedPlan.warnings).not.toContain('recovering exact malformed scoped create at ["Before you start"]');
    expect(driftedPlan.blockers).toContainEqual(expect.objectContaining({ code: 'round-trip-loss-ambiguous' }));
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

  it('leaves a tracked Code-only deletion to the Code planner', () => {
    const localBase = document(
      heading('Build'),
      code('echo old', 'bash', undefined, ['Build'])
    );
    const localCurrent = document(heading('Build'));
    const remoteBase = document(
      heading('Build', 'heading-1'),
      code('echo old', 'bash', 'code-1', ['Build'])
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
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'code-delete', remoteBlockId: 'code-1' })
    ]);
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

  it('does not update text for an NBSP-only representation difference', () => {
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent: document(text('Provider\u00a0name', 0)),
      remoteCurrent: document(text('Provider name', 0, 'p1')),
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('adopts Milvus-visible text from tracked dual-product include markup', () => {
    const remoteMarkdown = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text(remoteMarkdown, 0)),
      localCurrent: document(text('Milvus stores vectors.', 0)),
      remoteBase: document(text(remoteMarkdown, 0, 'p1')),
      remoteCurrent: document(text(remoteMarkdown, 0, 'p1')),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('preserves tracked dual-product include markup in changed text', () => {
    const remoteMarkdown = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text(remoteMarkdown, 0)),
      localCurrent: document(text('Milvus stores vector data.', 0)),
      remoteBase: document(text(remoteMarkdown, 0, 'p1')),
      remoteCurrent: document(text(remoteMarkdown, 0, 'p1')),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        desiredMarkdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.'
      })
    ]);
  });

  it('adopts tracked Feishu block anchors and split link punctuation', () => {
    const remoteMarkdown = 'See [threshold](https://example.feishu.cn/wiki/doc#block)[?](https://example.feishu.cn/wiki/doc#block)';
    const localMarkdown = 'See [threshold?](https://example.feishu.cn/wiki/doc)';
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text(remoteMarkdown, 0)),
      localCurrent: document(text(localMarkdown, 0)),
      remoteBase: document(text(remoteMarkdown, 0, 'p1')),
      remoteCurrent: document(text(remoteMarkdown, 0, 'p1')),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
  });

  it('preserves a tracked Feishu block anchor in changed link text', () => {
    const remoteMarkdown = 'Old guidance; see [JSON Shredding](https://example.feishu.cn/wiki/doc#block).';
    const localMarkdown = 'New guidance; see [JSON Shredding](https://example.feishu.cn/wiki/doc).';
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase: document(text(remoteMarkdown, 0)),
      localCurrent: document(text(localMarkdown, 0)),
      remoteBase: document(text(remoteMarkdown, 0, 'p1')),
      remoteCurrent: document(text(remoteMarkdown, 0, 'p1')),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        desiredMarkdown: 'New guidance; see [JSON Shredding](https://example.feishu.cn/wiki/doc#block).'
      })
    ]);
  });

  it('preserves standalone tracked include boundary blocks outside ordinary text planning', () => {
    const localBase = document(
      text('<include target="milvus">', 0),
      text('Stable.', 1),
      text('</include>', 2)
    );
    const remoteBase = document(
      text('<include target="milvus">', 0, 'open'),
      text('Stable.', 1, 'p1'),
      text('</include>', 2, 'close')
    );
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localBase,
      localCurrent: document(text('Stable.', 0)),
      remoteBase,
      remoteCurrent: remoteBase,
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([]);
    expect(plan.warnings).toContain('preserving remote standalone include boundary blocks');
  });

  it('does not misattribute a post-replacement update to an unchanged later section', () => {
    const localBase = document(
      sectionText('## Before you start', ['Before you start'], 0, undefined, 4),
      sectionText('- Old requirement one.', ['Before you start'], 1, undefined, 12),
      sectionText('- Old requirement two.', ['Before you start'], 2, undefined, 12),
      sectionText('## Define schema fields', ['Define schema fields'], 0, undefined, 4),
      sectionText('- A primary field that uniquely identifies each entity.', ['Define schema fields'], 1, undefined, 12),
      sectionText('## Finish', ['Finish'], 0, undefined, 4),
      sectionText('Old finish text.', ['Finish'], 1)
    );
    const localCurrent = document(
      sectionText('## Before you start', ['Before you start'], 0, undefined, 4),
      sectionText('- **Requirement one**', ['Before you start'], 1, undefined, 12),
      sectionText('Requirement one details.', ['Before you start'], 2),
      sectionText('- **Requirement two**', ['Before you start'], 3, undefined, 12),
      sectionText('Requirement two details.', ['Before you start'], 4),
      sectionText('## Define schema fields', ['Define schema fields'], 0, undefined, 4),
      sectionText('- A primary field that uniquely identifies each entity.', ['Define schema fields'], 1, undefined, 12),
      sectionText('## Finish', ['Finish'], 0, undefined, 4),
      sectionText('New finish text.', ['Finish'], 1)
    );
    const remoteBase = document(
      sectionText('## Before you start', ['Before you start'], 0, 'before', 4),
      sectionText('- Old requirement one.', ['Before you start'], 1, 'old-1', 12),
      sectionText('- Old requirement two.', ['Before you start'], 2, 'old-2', 12),
      sectionText('## Define schema fields', ['Define schema fields'], 0, 'define', 4),
      sectionText('- A primary field that uniquely identifies each entity.', ['Define schema fields'], 1, 'primary', 12),
      sectionText('## Finish', ['Finish'], 0, 'finish', 4),
      sectionText('Old finish text.', ['Finish'], 1, 'finish-text')
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
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'update',
      remoteBlockId: 'finish-text',
      locator: { sectionPath: ['Finish'], kind: 'text', ordinal: 1 },
      desiredMarkdown: 'New finish text.'
    }));
    expect(plan.operations).not.toContainEqual(expect.objectContaining({
      kind: 'update',
      locator: { sectionPath: ['Define schema fields'], kind: 'text', ordinal: 1 }
    }));
  });

  it('plans Procedures token creation without ordinary text operations', () => {
    const localCurrent = localSemanticDocument(
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.'
    );
    const remoteCurrent = remoteize(localSemanticDocument(
      'Intro.\n\n1. Step.\n\nAfter.'
    ));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent,
      remoteCurrent,
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'authoring-token-create', token: '<Procedures>' }),
      expect.objectContaining({ kind: 'authoring-token-create', token: '</Procedures>' })
    ]);
  });

  it('plans a Procedures boundary move without text updates', () => {
    const localCurrent = localSemanticDocument(
      'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>\n\nAfter.'
    );
    const remoteCurrent = remoteize(localSemanticDocument(
      '<Procedures>\n\nIntro.\n\n1. Step.\n\n</Procedures>\n\nAfter.'
    ));

    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent,
      remoteCurrent,
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'authoring-token-move', token: '<Procedures>' })
    ]);
  });

  it('blocks a Procedures move when the adapter cannot move blocks', () => {
    const plan = planScopedPatch({
      parentBlockId: 'page',
      localCurrent: localSemanticDocument(
        'Intro.\n\n<Procedures>\n\n1. Step.\n\n</Procedures>'
      ),
      remoteCurrent: remoteize(localSemanticDocument(
        '<Procedures>\n\nIntro.\n\n1. Step.\n\n</Procedures>'
      )),
      tracked: false,
      supportsBlockMove: false
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'procedures-move-unsupported'
    }));
  });
});

function remoteize(document: SemanticDocument): SemanticDocument {
  return {
    nodes: document.nodes.map((node, index) => ({
      ...node,
      remoteBlockId: `block-${index}`
    }))
  };
}

function remoteizeWithChildIds(document: SemanticDocument): SemanticDocument {
  let id = 0;
  const withChildren = (children: SemanticTextBlock['children']): SemanticTextBlock['children'] => {
    return children?.map((child) => ({
      ...child,
      remoteBlockId: `tree-${id += 1}`,
      ...(child.children ? { children: withChildren(child.children) } : {})
    }));
  };
  return {
    nodes: document.nodes.map((node) => {
      const remoteBlockId = `tree-${id += 1}`;
      return node.kind === 'text'
        ? {
            ...node,
            remoteBlockId,
            ...(node.children ? { children: withChildren(node.children) } : {})
          }
        : { ...node, remoteBlockId };
    })
  };
}

function document(...nodes: SemanticDocument['nodes']): SemanticDocument {
  return { nodes };
}

function nestedRemoteDocument(childText: string): SemanticDocument {
  return remoteSemanticDocument([
    { block_id: 'page', block_type: 1, children: ['parent'] },
    {
      block_id: 'parent',
      block_type: 12,
      children: ['child', 'nested'],
      bullet: { elements: [{ text_run: { content: 'Parent', text_element_style: { bold: true } } }] }
    },
    {
      block_id: 'child',
      block_type: 2,
      text: { elements: [{ text_run: { content: childText, text_element_style: {} } }] }
    },
    {
      block_id: 'nested',
      block_type: 12,
      bullet: { elements: [{ text_run: { content: 'Nested bullet.', text_element_style: {} } }] }
    }
  ], 'page');
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

function sectionText(
  markdown: string,
  sectionPath: string[],
  ordinal: number,
  remoteBlockId?: string,
  blockType = 2
): SemanticTextBlock {
  return {
    kind: 'text',
    locator: { sectionPath, kind: 'text', ordinal },
    blockType,
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
  const width = Math.max(2, ...rows.map((tableRow) => tableRow.cells.length));
  return {
    kind: 'table',
    locator: { sectionPath: ['Index params'], kind: 'table', ordinal: 0 },
    headers: [cell('Parameter'), cell('Description'), cell('Type')].slice(0, width),
    rows,
    remoteBlockId: remote ? 'table1' : undefined,
    unsupported: []
  };
}

function row(key: string, description: string, type?: string): SemanticTable['rows'][number] {
  return {
    key,
    cells: [cell(key), cell(description), ...(type ? [cell(type)] : [])]
  };
}

function cell(value: string): SemanticCell {
  return { blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', value }] }] };
}
