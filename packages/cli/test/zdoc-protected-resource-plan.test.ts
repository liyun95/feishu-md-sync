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

  it('blocks a tracked Supademo whose local showcase mode changed', () => {
    const plan = planProtectedResources({
      local: document(resource('demo', undefined, true), false),
      remote: document(resource('demo', 'isv1', false), true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        isShowcase: false,
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-changed' }));
    expect(plan.items).not.toContainEqual(expect.objectContaining({ code: 'supademo-protected' }));
  });

  it('blocks untracked adoption when showcase identity does not match', () => {
    const plan = planProtectedResources({
      local: document(resource('demo', undefined, true), false),
      remote: document(resource('demo', 'isv1', false), true),
      receiptEntries: []
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-missing' }));
    expect(plan.entries).toEqual([]);
  });

  it('blocks remote showcase drift from a tracked receipt', () => {
    const plan = planProtectedResources({
      local: document(resource('demo', undefined, false), false),
      remote: document(resource('demo', 'isv1', true), true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        isShowcase: false,
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-changed' }));
  });

  it('upgrades a verified historical receipt entry with showcase identity', () => {
    const plan = planProtectedResources({
      local: document(resource('demo', undefined, true), false),
      remote: document(resource('demo', 'isv1', true), true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.entries).toEqual([expect.objectContaining({
      componentId: 'demo',
      isShowcase: true,
      blockId: 'isv1'
    })]);
  });

  it('blocks a tracked Supademo moved to a different local section', () => {
    const localResource = resource('demo', undefined, false);
    localResource.locator = {
      sectionPath: ['Moved'],
      kind: 'protected-resource',
      ordinal: 0
    };
    const plan = planProtectedResources({
      local: document(localResource, false),
      remote: document(resource('demo', 'isv1', false), true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        isShowcase: false,
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-changed' }));
  });

  it('blocks duplicate tracked receipt mappings for one Supademo', () => {
    const plan = planProtectedResources({
      local: document(resource('demo', undefined, false), false),
      remote: document(resource('demo', 'isv1', false), true),
      receiptEntries: [
        {
          kind: 'supademo',
          componentId: 'demo',
          isShowcase: false,
          blockId: 'isv1',
          remoteShape: 'add-ons:supademo',
          sectionPath: ['Demo'],
          ordinal: 0
        },
        {
          kind: 'supademo',
          componentId: 'demo',
          isShowcase: false,
          blockId: 'isv2',
          remoteShape: 'add-ons:supademo',
          sectionPath: ['Demo'],
          ordinal: 0
        }
      ]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-ambiguous' }));
    expect(plan.items).not.toContainEqual(expect.objectContaining({ code: 'supademo-protected' }));
  });

  it('blocks duplicate local Supademo identities against one tracked mapping', () => {
    const duplicate = resource('demo', undefined, false);
    duplicate.locator = {
      sectionPath: ['Demo'],
      kind: 'protected-resource',
      ordinal: 1
    };
    const local = document(resource('demo', undefined, false), false);
    local.nodes.splice(2, 0, duplicate);
    const plan = planProtectedResources({
      local,
      remote: document(resource('demo', 'isv1', false), true),
      receiptEntries: [{
        kind: 'supademo',
        componentId: 'demo',
        isShowcase: false,
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0
      }]
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: 'supademo-ambiguous' }));
    expect(plan.items).not.toContainEqual(expect.objectContaining({ code: 'supademo-protected' }));
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

function resource(
  componentId: string,
  remoteBlockId?: string,
  isShowcase = false
): SemanticProtectedResource {
  return {
    kind: 'protected-resource',
    locator: { sectionPath: ['Demo'], kind: 'protected-resource', ordinal: 0 },
    resourceKind: 'supademo',
    componentId,
    isShowcase,
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
