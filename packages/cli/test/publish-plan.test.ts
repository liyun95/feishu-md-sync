import { describe, expect, it } from 'vitest';
import { buildPublishPlan } from '../src/publish/publish-plan.js';
import { hashText } from '../src/receipts/publish-receipt.js';
import type { WhiteboardPlan } from '../src/whiteboards/whiteboard-plan.js';

describe('publish plan', () => {
  it('plans no-op when desired draft matches remote content', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vectors.',
      publishDraft: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      remoteMarkdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      receipt: undefined,
      transformWarnings: []
    });

    expect(plan.strategy).toBe('no-op');
    expect(plan.safeToWrite).toBe(true);
    expect(plan.remoteChanged).toBe(false);
  });

  it('blocks auto planning instead of falling back to document replace', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vectors.',
      publishDraft: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      remoteMarkdown: 'Old content.',
      receipt: undefined,
      transformWarnings: []
    });

    expect(plan.strategy).toBe('blocked');
    expect(plan.safeToWrite).toBe(false);
    expect(plan.risks).toContain('untracked remote: no publish receipt exists for this target');
    expect(plan.risks).toContain('scoped publish is blocked; auto will not fall back to document replacement');
  });

  it('plans document replacement only when explicitly forced', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: 'Local.',
      publishDraft: 'Local.',
      remoteMarkdown: 'Remote.',
      receipt: undefined,
      transformWarnings: [],
      forceDocumentReplace: true
    });

    expect(plan.strategy).toBe('document-replace');
    expect(plan.risks).toContain('document replace can affect comments, anchors, block identity, and collaboration context');
  });

  it('detects remote changes relative to the previous receipt', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'New Milvus text.',
      publishDraft: 'New draft.',
      remoteMarkdown: 'Remote teammate edit.',
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: 'old-remote',
        updatedAt: '2026-07-09T00:00:00.000Z'
      },
      transformWarnings: ['Heading contains Milvus product wording and was not rewritten: # Milvus']
    });

    expect(plan.remoteChanged).toBe(true);
    expect(plan.warnings).toContain('Heading contains Milvus product wording and was not rewritten: # Milvus');
    expect(plan.risks).toContain('remote changed since last publish receipt');
  });

  it('selects block-patch when a safe block patch plan is available', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vector data.',
      publishDraft: 'Zilliz Cloud stores vector data.',
      remoteMarkdown: 'Zilliz Cloud stores vectors.',
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: hashText('Zilliz Cloud stores vectors.'),
        updatedAt: '2026-07-09T00:00:00.000Z'
      },
      transformWarnings: [],
      blockPatch: {
        kind: 'publish-block-patch-plan',
        safeToWrite: true,
        requiresCollaborationRiskConfirmation: false,
        operations: [{
          kind: 'create',
          parentBlockId: 'page',
          insertAfterBlockId: 'p1',
          index: 1,
          path: [1],
          blocks: [{ block_type: 2, text: { elements: [] } }]
        }],
        warnings: []
      }
    });

    expect(plan.strategy).toBe('block-patch');
    expect(plan.safeToWrite).toBe(true);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(false);
    expect(plan.requiresUntrackedRemoteConfirmation).toBe(false);
    expect(plan.blockPatch?.operations).toHaveLength(1);
  });

  it('plans no-op when block-patch has no operations even if raw markdown hashes differ', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: '# lark-cli-test\n\nMilvus stores vector data.',
      publishDraft: '# lark-cli-test\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.',
      remoteMarkdown: '# lark-cli-test\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n',
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: hashText('# lark-cli-test\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n'),
        updatedAt: '2026-07-09T00:00:00.000Z'
      },
      transformWarnings: [],
      blockPatch: {
        kind: 'publish-block-patch-plan',
        safeToWrite: true,
        requiresCollaborationRiskConfirmation: false,
        operations: [],
        warnings: []
      }
    });

    expect(plan.strategy).toBe('no-op');
    expect(plan.safeToWrite).toBe(true);
    expect(plan.blockPatch?.operations).toEqual([]);
  });

  it('requires collaboration-risk confirmation for replacing existing blocks', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vector data.',
      publishDraft: 'Zilliz Cloud stores vector data.',
      remoteMarkdown: 'Zilliz Cloud stores vectors.',
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: hashText('Zilliz Cloud stores vectors.'),
        updatedAt: '2026-07-09T00:00:00.000Z'
      },
      transformWarnings: [],
      blockPatch: {
        kind: 'publish-block-patch-plan',
        safeToWrite: true,
        requiresCollaborationRiskConfirmation: true,
        operations: [{
          kind: 'update',
          remoteBlockId: 'blk1',
          path: [0],
          blockType: 2
        }],
        warnings: []
      }
    });

    expect(plan.strategy).toBe('block-patch');
    expect(plan.safeToWrite).toBe(false);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
    expect(plan.risks).toContain('changed blocks may lose comments, anchors, or block identity when replaced');
  });

  it('requires untracked remote confirmation before adopting an existing document', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vector data.',
      publishDraft: 'Zilliz Cloud stores vector data.',
      remoteMarkdown: 'Zilliz Cloud stores vectors.',
      receipt: undefined,
      transformWarnings: [],
      blockPatch: {
        kind: 'publish-block-patch-plan',
        safeToWrite: true,
        requiresCollaborationRiskConfirmation: false,
        operations: [{
          kind: 'create',
          parentBlockId: 'page',
          insertAfterBlockId: 'p1',
          index: 1,
          path: [1],
          blocks: [{ block_type: 2, text: { elements: [] } }]
        }],
        warnings: []
      }
    });

    expect(plan.strategy).toBe('block-patch');
    expect(plan.safeToWrite).toBe(false);
    expect(plan.requiresUntrackedRemoteConfirmation).toBe(true);
    expect(plan.risks).toContain('untracked remote block-patch requires explicit confirmation');
  });

  it('selects block-patch when only a Whiteboard operation is planned', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: '![CAGRA](./assets/cagra.png)',
      publishDraft: '![CAGRA](./assets/cagra.png)',
      remoteMarkdown: '![CAGRA](remote-image)',
      receipt: trackedReceipt(),
      transformWarnings: [],
      scopedPatch: emptyScopedPatch(),
      whiteboards: whiteboardPlan({ operations: [{
        kind: 'whiteboard-update',
        assetKey: 'assets/cagra.png',
        locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
        placementFingerprint: 'placement',
        blockId: 'wb_block',
        whiteboardToken: 'wb_token',
        svgPath: '/tmp/cagra.svg',
        svgHash: 'svg-new',
        reason: 'local-changed'
      }] })
    });

    expect(plan.strategy).toBe('block-patch');
    expect(plan.whiteboards?.operations).toHaveLength(1);
    expect(plan.requiresCollaborationRiskConfirmation).toBe(true);
  });

  it('blocks the entire publish when Whiteboard planning has a blocker', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: 'Local.',
      publishDraft: 'Local.',
      remoteMarkdown: 'Remote.',
      receipt: trackedReceipt(),
      transformWarnings: [],
      scopedPatch: emptyScopedPatch(),
      whiteboards: whiteboardPlan({
        blockers: [{ code: 'whiteboard-conflict', assetKey: 'assets/cagra.png', message: 'remote Whiteboard changed' }]
      })
    });

    expect(plan.strategy).toBe('blocked');
    expect(plan.risks).toContain('remote Whiteboard changed');
  });

  it('requires untracked confirmation for a new Whiteboard in a tracked document', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: 'Local.',
      publishDraft: 'Local.',
      remoteMarkdown: 'Remote.',
      receipt: trackedReceipt(),
      transformWarnings: [],
      scopedPatch: emptyScopedPatch(),
      whiteboards: whiteboardPlan({
        operations: [{
          kind: 'whiteboard-create',
          assetKey: 'assets/cagra.png',
          locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
          placementFingerprint: 'placement',
          remoteImageBlockId: 'image_block',
          svgPath: '/tmp/cagra.svg',
          svgHash: 'svg-new'
        }],
        requiresUntrackedRemoteConfirmation: true
      })
    });

    expect(plan.strategy).toBe('block-patch');
    expect(plan.requiresUntrackedRemoteConfirmation).toBe(true);
  });

  it('blocks publishing when the Zdoc round-trip report is unsafe', () => {
    const zdocRoundTrip = {
      safeToPublish: false,
      items: [{
        code: 'supademo-missing' as const,
        severity: 'blocker' as const,
        component: 'Supademo',
        message: 'no ISV correspondence'
      }]
    };
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: '<Supademo id="demo" />',
      publishDraft: '<readonly-block type="isv"></readonly-block>',
      remoteMarkdown: '<readonly-block type="isv"></readonly-block>',
      receipt: undefined,
      transformWarnings: [],
      zdocRoundTrip
    });

    expect(plan.strategy).toBe('blocked');
    expect(plan.safeToWrite).toBe(false);
    expect(plan.zdocRoundTrip).toEqual(zdocRoundTrip);
    expect(plan.risks).toContain('no ISV correspondence');
  });

  it('blocks document replacement when a protected Supademo exists', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      localSource: '<Supademo id="demo" />',
      publishDraft: '<readonly-block type="isv"></readonly-block>',
      remoteMarkdown: '<readonly-block type="isv"></readonly-block>',
      receipt: undefined,
      transformWarnings: [],
      forceDocumentReplace: true,
      zdocRoundTrip: {
        safeToPublish: true,
        items: [{
          code: 'supademo-adopt',
          severity: 'info',
          component: 'Supademo',
          message: 'adopt existing ISV block',
          remoteBlockId: 'isv1'
        }]
      }
    });

    expect(plan.strategy).toBe('blocked');
    expect(plan.risks).toContain(
      'document replacement cannot preserve protected Supademo block identity'
    );
  });
});

function trackedReceipt() {
  return {
    version: 1 as const,
    target: { kind: 'docx' as const, token: 'doc_token' },
    profile: 'none' as const,
    localSourceHash: 'old-source',
    publishDraftHash: 'old-draft',
    remoteSnapshotHash: hashText('Remote.'),
    updatedAt: '2026-07-13T00:00:00.000Z'
  };
}

function emptyScopedPatch() {
  return {
    kind: 'scoped-patch-plan' as const,
    safeToWrite: true,
    operations: [],
    blockers: [],
    warnings: [],
    requiresCollaborationRiskConfirmation: false,
    scopeSummary: {
      localChanged: [],
      remoteChanged: [],
      overlappingConflicts: [],
      unrelatedRemoteChanges: []
    }
  };
}

function whiteboardPlan(input: Partial<WhiteboardPlan>): WhiteboardPlan {
  const operations = input.operations ?? [];
  const blockers = input.blockers ?? [];
  return {
    kind: 'whiteboard-plan',
    safeToWrite: blockers.length === 0,
    assets: input.assets ?? [],
    operations,
    blockers,
    warnings: input.warnings ?? [],
    requiresCollaborationRiskConfirmation: input.requiresCollaborationRiskConfirmation ?? operations.length > 0,
    requiresUntrackedRemoteConfirmation: input.requiresUntrackedRemoteConfirmation ?? false
  };
}
