import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import {
  assignCodeReconcileExactMatches,
  fetchRemoteSemantic,
  findCodeReconcileCandidate,
  findObsoleteCodeIdsForReconcile,
  partitionScopedOperations,
  reconcileCandidateNeedsMove
} from '../src/publish/run-publish.js';
import type { SemanticCodeBlock, SemanticDocument, SemanticTextBlock } from '../src/semantic/types.js';
import { semanticHash } from '../src/semantic/normalize.js';

describe('Code section reconcile correspondence', () => {
  it('does not select an identical Code block from an unrelated section', () => {
    const desired = code(['Target'], 'same');
    const unrelated = code(['Unrelated'], 'same', 'remote-z');
    const document: SemanticDocument = { nodes: [unrelated] };

    expect(findCodeReconcileCandidate(document, desired, [['Source'], ['Target']])).toBeUndefined();
  });

  it('selects a unique matching Code block inside participating sections', () => {
    const desired = code(['Target'], 'same');
    const source = code(['Source'], 'same', 'remote-a');
    const document: SemanticDocument = { nodes: [source, code(['Unrelated'], 'same', 'remote-z')] };

    expect(findCodeReconcileCandidate(document, desired, [['Source'], ['Target']])).toBe(source);
  });

  it('does not reuse a consumed matching Code block', () => {
    const desired = code(['Target'], 'same');
    const source = code(['Source'], 'same', 'remote-a');
    const document: SemanticDocument = { nodes: [source] };

    expect(findCodeReconcileCandidate(
      document,
      desired,
      [['Source'], ['Target']],
      new Set(['remote-a'])
    )).toBeUndefined();
  });

  it('splits reconcile placement from deletion so deletion runs in the final phase', () => {
    const desired = code(['Target'], 'new');
    const operation = {
      kind: 'code-section-reconcile' as const,
      locator: desired.locator,
      sectionPaths: [['Source'], ['Target']],
      desiredCodes: [{ code: desired }],
      remoteCodes: [code(['Source'], 'old', 'remote-a')]
    };

    const phases = partitionScopedOperations([operation]);

    expect(phases.moves).toEqual([expect.objectContaining({
      kind: 'code-section-reconcile',
      phase: 'place'
    })]);
    expect(phases.deletes).toEqual([expect.objectContaining({
      kind: 'code-section-reconcile',
      phase: 'delete'
    })]);
  });

  it('retries rate-limited semantic readback fetches', async () => {
    let attempts = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: '' }),
      fetchDocBlocks: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('429 too many requests');
        return { blocks: [{ block_id: 'doc', block_type: 1, children: [] }] };
      },
      replaceDocument: async () => {}
    };

    await expect(fetchRemoteSemantic(adapter, 'doc')).resolves.toEqual({ nodes: [] });
    expect(attempts).toBe(2);
  });

  it('deletes duplicate fingerprints from the wrong section instead of the desired section', () => {
    const desired = code(['Target'], 'same');
    const document: SemanticDocument = {
      nodes: [
        code(['Source'], 'same', 'source-id'),
        code(['Target'], 'same', 'target-id')
      ]
    };

    expect(findObsoleteCodeIdsForReconcile(document, [desired], [['Source'], ['Target']]))
      .toEqual(['source-id']);
  });

  it('reserves exact managed matches before locator fallback can overwrite them', () => {
    const keep = { ...code(['Target'], 'keep', 'keep-id'), caption: 'Keep caption' };
    const document: SemanticDocument = {
      nodes: [code(['Source'], 'old', 'old-id'), keep]
    };
    const desired = [code(['Target'], 'new'), code(['Target'], 'keep')];
    desired[1]!.locator.ordinal = 1;

    expect(assignCodeReconcileExactMatches(document, desired, [['Source'], ['Target']]))
      .toEqual(new Map([[1, 'keep-id']]));
  });

  it('requires a move when the Code locator is unchanged but its prose predecessor changed', () => {
    const paragraph = text(['Target'], 0, 'Paragraph.', 'p1');
    const keep = code(['Target'], 'keep', 'keep-id');
    const document: SemanticDocument = { nodes: [keep, paragraph] };

    expect(reconcileCandidateNeedsMove(document, keep, paragraph.locator)).toBe(true);
  });

  it('accepts the correct predecessor when consecutive Code blocks have identical fingerprints', () => {
    const first = code(['Target'], 'same', 'first-id');
    const second = code(['Target'], 'same', 'second-id');
    second.locator.ordinal = 1;
    const document: SemanticDocument = { nodes: [first, second] };
    const fingerprint = semanticHash({ content: 'same', language: 'python' });

    expect(reconcileCandidateNeedsMove(
      document,
      second,
      first.locator,
      fingerprint
    )).toBe(false);
  });
});

function code(sectionPath: string[], content: string, remoteBlockId?: string): SemanticCodeBlock {
  return {
    kind: 'code',
    locator: { sectionPath, kind: 'code', ordinal: 0 },
    content,
    sourceLanguage: 'python',
    resolvedLanguage: 'python',
    remoteBlockId,
    issues: []
  };
}

function text(
  sectionPath: string[],
  ordinal: number,
  markdown: string,
  remoteBlockId?: string
): SemanticTextBlock {
  return {
    kind: 'text',
    locator: { sectionPath, kind: 'text', ordinal },
    blockType: 2,
    markdown,
    remoteBlockId
  };
}
