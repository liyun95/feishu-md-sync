import { describe, expect, it } from 'vitest';
import { summarizeCodeBlockChanges } from '../src/code-blocks/code-summary.js';
import type { CodeBlockOperation } from '../src/code-blocks/code-plan.js';
import type { SemanticCodeBlock, SemanticDocument } from '../src/semantic/types.js';

describe('Code block summaries', () => {
  it('summarizes content, language, movement, and section reconcile', () => {
    const remoteCode = code(['Build'], 0, 'old\n', 'python');
    const desired = code(['Search'], 0, 'new\n', 'go');
    const operations: CodeBlockOperation[] = [
      {
        kind: 'code-update',
        locator: desired.locator,
        sourceLocator: remoteCode.locator,
        desiredCode: desired
      },
      {
        kind: 'code-move',
        locator: desired.locator,
        sourceLocator: remoteCode.locator,
        desiredCode: desired
      },
      {
        kind: 'code-section-reconcile',
        locator: desired.locator,
        sectionPaths: [['Search']],
        desiredCodes: [{ code: desired }],
        remoteCodes: [remoteCode]
      }
    ];

    expect(summarizeCodeBlockChanges({
      operations,
      local: document(desired),
      remote: document(remoteCode)
    })).toEqual([
      expect.objectContaining({
        action: 'update',
        contentChanged: true,
        languageChange: { from: 'python', to: 'go' }
      }),
      expect.objectContaining({
        action: 'move',
        move: { from: ['Build'], to: ['Search'] }
      }),
      expect.objectContaining({ action: 'reconcile', additions: 1, deletions: 1 })
    ]);
  });
});

function document(...nodes: SemanticCodeBlock[]): SemanticDocument {
  return { nodes };
}

function code(sectionPath: string[], ordinal: number, content: string, language: string): SemanticCodeBlock {
  return {
    kind: 'code',
    locator: { sectionPath, kind: 'code', ordinal },
    content,
    sourceLanguage: language,
    resolvedLanguage: language,
    issues: []
  };
}
