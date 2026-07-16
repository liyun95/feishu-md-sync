import { describe, expect, it } from 'vitest';
import { planProtectedResources } from '../src/zdoc/protected-resource-plan.js';
import type { SemanticDocument, SemanticProtectedResource } from '../src/semantic/types.js';

describe('Zdoc protected Supademo planning', () => {
  it('adopts one exact resource with matching section and neighbours', () => {
    const plan = planProtectedResources({
      local: document(resource('demo'), false),
      remote: document(resource('demo', 'isv1'), true),
      receiptEntries: []
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.items).toContainEqual(expect.objectContaining({
      code: 'supademo-adopt',
      remoteBlockId: 'isv1'
    }));
    expect(plan.entries).toEqual([expect.objectContaining({
      componentId: 'demo',
      blockId: 'isv1',
      remoteShape: 'add-ons:supademo'
    })]);
  });

  it('blocks ambiguous and missing resource correspondence', () => {
    const local = document(resource('demo'), false);
    const candidate = resource('demo', 'isv1');
    const ambiguousRemote = document(candidate, true);
    ambiguousRemote.nodes.splice(2, 0, { ...candidate, remoteBlockId: 'isv2' });

    expect(planProtectedResources({
      local,
      remote: ambiguousRemote,
      receiptEntries: []
    }).blockers).toContainEqual(expect.objectContaining({ code: 'supademo-ambiguous' }));
    expect(planProtectedResources({
      local,
      remote: { nodes: [] },
      receiptEntries: []
    }).blockers).toContainEqual(expect.objectContaining({ code: 'supademo-missing' }));
  });

  it('blocks a tracked resource whose shape changed', () => {
    const plan = planProtectedResources({
      local: document(resource('demo'), false),
      remote: document({ ...resource('demo', 'isv1'), remoteShape: 'other' }, true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-changed' }));
  });

  it('blocks removing a tracked Supademo and retains its protected mapping', () => {
    const receipt = {
      kind: 'supademo' as const,
      componentId: 'demo',
      blockId: 'isv1',
      remoteShape: 'add-ons:supademo',
      sectionPath: ['Demo'],
      ordinal: 0
    };

    const plan = planProtectedResources({
      local: { nodes: [text('After.', 0)] },
      remote: document(resource('demo', 'isv1'), true),
      receiptEntries: [receipt]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'supademo-removed'
    }));
    expect(plan.entries).toEqual([receipt]);
  });
});

function document(resourceNode: SemanticProtectedResource, remote: boolean): SemanticDocument {
  return {
    nodes: [
      text('Before.', 0, remote ? 'before' : undefined),
      resourceNode,
      text('After.', 1, remote ? 'after' : undefined)
    ]
  };
}

function resource(componentId: string, remoteBlockId?: string): SemanticProtectedResource {
  return {
    kind: 'protected-resource',
    locator: { sectionPath: ['Demo'], kind: 'protected-resource', ordinal: 0 },
    resourceKind: 'supademo',
    componentId,
    remoteBlockId,
    ...(remoteBlockId ? { remoteShape: 'add-ons:supademo' } : {})
  };
}

function text(markdown: string, ordinal: number, remoteBlockId?: string) {
  return {
    kind: 'text' as const,
    locator: { sectionPath: ['Demo'], kind: 'text' as const, ordinal },
    blockType: 2,
    markdown,
    remoteBlockId
  };
}
