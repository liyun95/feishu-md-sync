import { describe, expect, it } from 'vitest';
import { planCalloutChanges } from '../src/publish/callout-plan.js';
import type { CalloutType, SemanticCallout, SemanticDocument } from '../src/semantic/types.js';

describe('Callout publish planning', () => {
  it('updates one child while preserving a disjoint remote child change', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Local base A', 'Shared B'])),
      localCurrent: document(note(['Local current A', 'Shared B'])),
      remoteBase: document(note(['Local base A', 'Shared B'], { remote: true })),
      remoteCurrent: document(note(['Local base A', 'Remote current B'], { remote: true })),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'callout-child-update', childOrdinal: 0, remoteBlockId: 'child0' })
    ]);
  });

  it('blocks overlapping changes to the same child', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Base'])),
      localCurrent: document(note(['Local'])),
      remoteBase: document(note(['Base'], { remote: true })),
      remoteCurrent: document(note(['Remote'], { remote: true })),
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'remote-callout-conflict' }));
  });

  it('ignores remote-managed shell and title changes', () => {
    const base = note(['Body'], { remote: true });
    const current = note(['Body'], { remote: true });
    current.title = { markdown: 'Custom title', remoteBlockId: 'title' };
    current.shell = { emojiId: '✅', backgroundColor: 4, borderColor: 4 };
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'])),
      localCurrent: document(note(['Body'])),
      remoteBase: document(base),
      remoteCurrent: document(current),
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.remoteChanged).toEqual([]);
  });

  it('blocks note-to-warning type changes', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'])),
      localCurrent: document(note(['Body'], { type: 'warning' })),
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: document(note(['Body'], { remote: true })),
      tracked: true
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'callout-type-change' }));
  });

  it('creates a new local Callout at a stable anchor', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localCurrent: document(note(['New body'])),
      remoteCurrent: { nodes: [] },
      tracked: false
    });

    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'callout-create',
      parentBlockId: 'page',
      insertAfterBlockId: 'page'
    }));
  });

  it('deletes a tracked Callout only when the remote body is unchanged', () => {
    const clean = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'])),
      localCurrent: { nodes: [] },
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: document(note(['Body'], { remote: true })),
      tracked: true
    });
    const conflict = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'])),
      localCurrent: { nodes: [] },
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: document(note(['Remote edit'], { remote: true })),
      tracked: true
    });

    expect(clean.operations).toContainEqual(expect.objectContaining({
      kind: 'callout-delete',
      blockIds: ['callout']
    }));
    expect(clean.requiresCollaborationRiskConfirmation).toBe(true);
    expect(conflict.blockers).toContainEqual(expect.objectContaining({ code: 'remote-callout-conflict' }));
  });

  it('deletes the first tracked Callout without treating the next Callout as a type change', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(
        note(['Note body']),
        note(['Warning body'], { type: 'warning', ordinal: 1 })
      ),
      localCurrent: document(
        note(['Warning body'], { type: 'warning' })
      ),
      remoteBase: document(
        note(['Note body'], { remote: true, remoteId: 'note-callout' }),
        note(['Warning remote body'], { remote: true, type: 'warning', ordinal: 1, remoteId: 'warning-callout' })
      ),
      remoteCurrent: document(
        note(['Note body'], { remote: true, remoteId: 'note-callout' }),
        note(['Warning remote body'], { remote: true, type: 'warning', ordinal: 1, remoteId: 'warning-callout' })
      ),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([expect.objectContaining({
      kind: 'callout-delete',
      blockIds: ['note-callout']
    })]);
  });

  it('treats local and remote deletion as a no-op', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'])),
      localCurrent: { nodes: [] },
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: { nodes: [] },
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it('adopts exactly corresponding untracked Callouts with both confirmations', () => {
    const local = documentWithNeighbors(note(['Local body']));
    const remote = documentWithNeighbors(note(['Remote body'], { remote: true }));
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localCurrent: local,
      remoteCurrent: remote,
      tracked: false
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: 'callout-child-update' }));
    expect(plan.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('fails closed when untracked adjacency does not match', () => {
    const local = documentWithNeighbors(note(['Local body']));
    const remote = documentWithNeighbors(note(['Remote body'], { remote: true }), 'Different previous');
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localCurrent: local,
      remoteCurrent: remote,
      tracked: false
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'callout-correspondence-ambiguous' }));
  });

  it('requires an exact managed title when adopting an untracked Callout', () => {
    const matching = planCalloutChanges({
      parentBlockId: 'page',
      localCurrent: documentWithNeighbors(note(['Body'], { managedTitle: 'Billing' })),
      remoteCurrent: documentWithNeighbors(note(['Body'], { remote: true, title: 'Billing' })),
      tracked: false
    });
    const mismatched = planCalloutChanges({
      parentBlockId: 'page',
      localCurrent: documentWithNeighbors(note(['Body'], { managedTitle: 'Billing' })),
      remoteCurrent: documentWithNeighbors(note(['Body'], { remote: true, title: 'Notes' })),
      tracked: false
    });

    expect(matching.blockers).toEqual([]);
    expect(matching.operations).toEqual([]);
    expect(matching.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(mismatched.blockers).toContainEqual(expect.objectContaining({
      code: 'callout-correspondence-ambiguous'
    }));
  });

  it('plans a tracked managed-title update', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'], { managedTitle: 'Billing' })),
      localCurrent: document(note(['Body'], { managedTitle: 'Costs' })),
      remoteBase: document(note(['Body'], { remote: true, title: 'Billing' })),
      remoteCurrent: document(note(['Body'], { remote: true, title: 'Billing' })),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([expect.objectContaining({
      kind: 'callout-title-update',
      calloutBlockId: 'callout',
      remoteBlockId: 'title',
      desiredMarkdown: 'Costs'
    })]);
  });

  it('blocks conflicting local and remote managed-title changes', () => {
    const plan = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(note(['Body'], { managedTitle: 'Billing' })),
      localCurrent: document(note(['Body'], { managedTitle: 'Costs' })),
      remoteBase: document(note(['Body'], { remote: true, title: 'Billing' })),
      remoteCurrent: document(note(['Body'], { remote: true, title: 'Remote billing' })),
      tracked: true
    });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'remote-callout-conflict'
    }));
  });

  it('blocks changed unsupported Callouts but preserves unchanged ones', () => {
    const base = note(['Body']);
    const changed = note(['Body changed']);
    changed.unsupported = ['fenced code blocks are unsupported'];
    const unchanged = note(['Body']);
    unchanged.unsupported = ['fenced code blocks are unsupported'];

    const blocked = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(base),
      localCurrent: document(changed),
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: document(note(['Body'], { remote: true })),
      tracked: true
    });
    const preserved = planCalloutChanges({
      parentBlockId: 'page',
      localBase: document(unchanged),
      localCurrent: document(unchanged),
      remoteBase: document(note(['Body'], { remote: true })),
      remoteCurrent: document(note(['Body'], { remote: true })),
      tracked: true
    });

    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'unsupported-callout-change' }));
    expect(preserved.blockers).toEqual([]);
  });
});

function note(
  bodies: string[],
  options: {
    remote?: boolean;
    type?: CalloutType;
    ordinal?: number;
    remoteId?: string;
    managedTitle?: string;
    title?: string;
  } = {}
): SemanticCallout {
  const type = options.type ?? 'note';
  const remoteId = options.remoteId ?? 'callout';
  const childPrefix = options.remoteId ? `${remoteId}-child` : 'child';
  return {
    kind: 'callout',
    locator: { sectionPath: ['Build index'], kind: 'callout', ordinal: options.ordinal ?? 0 },
    calloutType: type,
    titleManaged: options.managedTitle ? true : undefined,
    title: options.remote || options.managedTitle ? {
      markdown: options.title ?? options.managedTitle ?? (type === 'note' ? 'Notes' : 'Warning'),
      ...(options.remote ? {
        remoteBlockId: options.remoteId ? `${remoteId}-title` : 'title'
      } : {})
    } : undefined,
    children: bodies.map((markdown, ordinal) => ({
      ordinal,
      blockType: 2,
      markdown,
      ...(options.remote ? { remoteBlockId: `${childPrefix}${ordinal}` } : {})
    })),
    ...(options.remote ? { remoteBlockId: remoteId, shell: { emojiId: type === 'note' ? '📘' : '❗' } } : {}),
    unsupported: []
  };
}

function document(...callouts: SemanticCallout[]): SemanticDocument {
  return { nodes: callouts };
}

function documentWithNeighbors(callout: SemanticCallout, previous = 'Previous text'): SemanticDocument {
  return {
    nodes: [
      text(previous, 0, 'previous'),
      callout,
      text('Next text', 1, 'next')
    ]
  };
}

function text(markdown: string, ordinal: number, remoteBlockId: string) {
  return {
    kind: 'text' as const,
    locator: { sectionPath: ['Build index'], kind: 'text' as const, ordinal },
    blockType: 2,
    markdown,
    remoteBlockId
  };
}
