import { describe, expect, it } from 'vitest';
import { buildPublishPlan } from '../src/publish/publish-plan.js';
import { hashText } from '../src/receipts/publish-receipt.js';

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
});
