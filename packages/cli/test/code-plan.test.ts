import { describe, expect, it } from 'vitest';
import { planCodeBlockChanges } from '../src/code-blocks/code-plan.js';
import type { SemanticCodeBlock, SemanticDocument, SemanticLocator, SemanticTextBlock } from '../src/semantic/types.js';

describe('Code block planning', () => {
  it('updates locally changed content while preserving the remote caption', () => {
    const base = document(code('Build', 0, 'print(1)\n', 'python'));
    const local = document(code('Build', 0, 'print(2)\n', 'python'));
    const remote = document(code('Build', 0, 'print(1)\n', 'python', { caption: 'Example', remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true }))
      .toMatchObject({
        blockers: [],
        operations: [{
          kind: 'code-update',
          desiredCode: { content: 'print(2)\n', resolvedLanguage: 'python', caption: 'Example' }
        }]
      });
  });

  it('merges disjoint local content and remote language changes', () => {
    const base = document(code('Build', 0, 'print(1)\n', 'python'));
    const local = document(code('Build', 0, 'print(2)\n', 'python'));
    const remote = document(code('Build', 0, 'print(1)\n', 'go', { remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true }))
      .toMatchObject({
        blockers: [],
        operations: [{
          kind: 'code-update',
          desiredCode: { content: 'print(2)\n', resolvedLanguage: 'go' }
        }]
      });
  });

  it('blocks different changes to the same managed field', () => {
    const base = document(code('Build', 0, 'print(1)\n', 'python'));
    const local = document(code('Build', 0, 'print(2)\n', 'python'));
    const remote = document(code('Build', 0, 'print(3)\n', 'python', { remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true }).blockers)
      .toContainEqual(expect.objectContaining({ code: 'remote-code-conflict', field: 'content' }));
  });

  it('plans identity-preserving movement within and across sections', () => {
    const base = document(
      code('Build', 0, 'a\n', 'python'),
      code('Search', 0, 'b\n', 'bash')
    );
    const local = document(
      code('Build', 0, 'b\n', 'bash'),
      code('Search', 0, 'a\n', 'python')
    );
    const remote = document(
      code('Build', 0, 'a\n', 'python', { remoteBlockId: 'r1' }),
      code('Search', 0, 'b\n', 'bash', { remoteBlockId: 'r2' })
    );

    const plan = planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations.filter((operation) => operation.kind === 'code-move')).toHaveLength(2);
  });

  it('carries Code predecessor identity for same-section reorder anchors', () => {
    const a = code('Build', 0, 'a\n', 'python');
    const b = code('Build', 1, 'b\n', 'bash');
    const localA = code('Build', 1, 'a\n', 'python');
    const localB = code('Build', 0, 'b\n', 'bash');
    const remoteA = code('Build', 0, 'a\n', 'python', { remoteBlockId: 'r1' });
    const remoteB = code('Build', 1, 'b\n', 'bash', { remoteBlockId: 'r2' });

    const moves = planCodeBlockChanges({
      localBase: document(a, b),
      localCurrent: document(localB, localA),
      remoteBase: document(a, b),
      remoteCurrent: document(remoteA, remoteB),
      tracked: true
    }).operations.filter((operation) => operation.kind === 'code-move');

    expect(moves.find((operation) => operation.locator.ordinal === 1)).toMatchObject({
      afterCodeFingerprint: expect.any(String)
    });
  });

  it('detects movement of the only Code block across prose in the same section', () => {
    const baseCode = code('Build', 0, 'a\n', 'python');
    const remoteCode = code('Build', 0, 'a\n', 'python', { remoteBlockId: 'r1' });
    const paragraph = text('Build', 0, 'Paragraph.', 'p1');

    const plan = planCodeBlockChanges({
      localBase: document(baseCode, paragraph),
      localCurrent: document(paragraph, baseCode),
      remoteBase: document(baseCode, paragraph),
      remoteCurrent: document(remoteCode, paragraph),
      tracked: true
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'code-move',
      afterLocator: paragraph.locator
    }));
  });

  it('plans create and delete without whole-document replacement', () => {
    const base = document(code('Build', 0, 'old\n', 'python'));
    const local = document(code('Build', 0, 'new\n', 'go'), code('Build', 1, 'extra\n', 'bash'));
    const remote = document(code('Build', 0, 'old\n', 'python', { remoteBlockId: 'r1' }));

    const plan = planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations.map((operation) => operation.kind)).toEqual(['code-update', 'code-create']);

    const deletion = planCodeBlockChanges({
      localBase: base,
      localCurrent: document(),
      remoteBase: base,
      remoteCurrent: remote,
      tracked: true
    });
    expect(deletion.operations).toContainEqual(expect.objectContaining({ kind: 'code-delete' }));
  });

  it('preserves identity when adopting an untracked reordered Code sequence', () => {
    const local = document(
      code('Build', 0, 'b\n', 'bash'),
      code('Build', 1, 'a\n', 'python')
    );
    const remote = document(
      code('Build', 0, 'a\n', 'python', { remoteBlockId: 'r1', caption: 'A caption' }),
      code('Build', 1, 'b\n', 'bash', { remoteBlockId: 'r2', caption: 'B caption' })
    );

    const plan = planCodeBlockChanges({ localCurrent: local, remoteCurrent: remote, tracked: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toHaveLength(2);
    expect(plan.operations.every((operation) => operation.kind === 'code-move')).toBe(true);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'code-move',
      remoteBlockId: 'r2',
      desiredCode: expect.objectContaining({ caption: 'B caption' })
    }));
  });

  it('reserves an exact untracked match before pairing a reordered edited block', () => {
    const local = document(
      code('Build', 0, 'b edited\n', 'bash'),
      code('Build', 1, 'a\n', 'python')
    );
    const remote = document(
      code('Build', 0, 'a\n', 'python', { remoteBlockId: 'r1', caption: 'A caption' }),
      code('Build', 1, 'b\n', 'bash', { remoteBlockId: 'r2', caption: 'B caption' })
    );

    const plan = planCodeBlockChanges({ localCurrent: local, remoteCurrent: remote, tracked: false });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({
      kind: 'code-update',
      remoteBlockId: 'r2',
      desiredCode: expect.objectContaining({ content: 'b edited\n', caption: 'B caption' })
    }));
    expect(plan.operations).not.toContainEqual(expect.objectContaining({
      kind: 'code-update',
      remoteBlockId: 'r1'
    }));
  });

  it('uses section reconcile for a moved and rewritten block', () => {
    const base = document(code('Build', 0, 'old\n', 'python'));
    const local = document(code('Search', 0, 'new\n', 'go'));
    const remote = document(code('Build', 0, 'old\n', 'python', { remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true }).operations)
      .toContainEqual(expect.objectContaining({ kind: 'code-section-reconcile' }));
  });

  it('blocks reconcile when a participating remote Code scope drifted', () => {
    const base = document(code('Build', 0, 'old\n', 'python'));
    const local = document(code('Search', 0, 'new\n', 'go'));
    const remote = document(code('Build', 0, 'remote edit\n', 'python', { remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase: base, remoteCurrent: remote, tracked: true }).blockers)
      .toContainEqual(expect.objectContaining({ code: 'remote-code-scope-changed' }));
  });

  it('blocks reconcile when an unmatched old block has a caption', () => {
    const base = document(code('Build', 0, 'old\n', 'python'));
    const local = document(code('Search', 0, 'new\n', 'go'));
    const remoteBase = document(code('Build', 0, 'old\n', 'python', { caption: 'Keep me' }));
    const remote = document(code('Build', 0, 'old\n', 'python', { caption: 'Keep me', remoteBlockId: 'r1' }));

    expect(planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase, remoteCurrent: remote, tracked: true }).blockers)
      .toContainEqual(expect.objectContaining({ code: 'caption-correspondence-ambiguous' }));
  });

  it('preserves a safely matched captioned block while reconciling another block', () => {
    const base = document(
      code('Build', 0, 'rewrite me\n', 'python'),
      code('Search', 0, 'keep me\n', 'bash')
    );
    const local = document(
      code('Search', 0, 'keep me\n', 'bash'),
      code('Search', 1, 'rewritten\n', 'go')
    );
    const remoteBase = document(
      code('Build', 0, 'rewrite me\n', 'python'),
      code('Search', 0, 'keep me\n', 'bash', { caption: 'Keep caption' })
    );
    const remote = document(
      code('Build', 0, 'rewrite me\n', 'python', { remoteBlockId: 'r1' }),
      code('Search', 0, 'keep me\n', 'bash', { caption: 'Keep caption', remoteBlockId: 'r2' })
    );

    const plan = planCodeBlockChanges({ localBase: base, localCurrent: local, remoteBase, remoteCurrent: remote, tracked: true });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toContainEqual(expect.objectContaining({ kind: 'code-section-reconcile' }));
  });

  it('turns local parsing issues into first-class blockers', () => {
    const broken = code('Build', 0, 'x\n', 'milvusql');
    broken.issues = [{ code: 'unsupported-code-language', message: 'unsupported Code block language: milvusql' }];

    expect(planCodeBlockChanges({ localCurrent: document(broken), remoteCurrent: document(), tracked: false }).blockers)
      .toContainEqual(expect.objectContaining({ code: 'unsupported-code-language' }));
  });

  it('fails closed for unsupported remote Code languages', () => {
    const remote = code('Build', 0, 'x\n', 'plaintext', { remoteBlockId: 'r1' });
    remote.issues = [{ code: 'unsupported-code-language', message: 'unsupported remote language' }];

    expect(planCodeBlockChanges({
      localCurrent: document(code('Build', 0, 'x\n', 'python')),
      remoteCurrent: document(remote),
      tracked: false
    }).blockers).toContainEqual(expect.objectContaining({ code: 'unsupported-code-language' }));
  });
});

function document(...nodes: SemanticDocument['nodes']): SemanticDocument {
  return { nodes };
}

function text(section: string, ordinal: number, markdown: string, remoteBlockId?: string): SemanticTextBlock {
  return {
    kind: 'text',
    locator: { sectionPath: [section], kind: 'text', ordinal },
    blockType: 2,
    markdown,
    remoteBlockId
  };
}

function code(
  section: string,
  ordinal: number,
  content: string,
  language: string,
  extra: Partial<SemanticCodeBlock> = {}
): SemanticCodeBlock {
  const locator: SemanticLocator = { sectionPath: [section], kind: 'code', ordinal };
  return {
    kind: 'code',
    locator,
    content,
    sourceLanguage: language,
    resolvedLanguage: language,
    issues: [],
    ...extra
  };
}
