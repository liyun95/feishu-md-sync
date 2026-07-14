import type { CodeBlockOperation } from './code-plan.js';
import type { SemanticCodeBlock, SemanticDocument, SemanticLocator } from '../semantic/types.js';

export type CodeBlockChangeSummary = {
  action: 'create' | 'update' | 'move' | 'delete' | 'reconcile';
  locator: SemanticLocator;
  language?: string;
  contentChanged?: boolean;
  languageChange?: { from: string; to: string };
  move?: { from: string[]; to: string[] };
  additions?: number;
  deletions?: number;
};

export function summarizeCodeBlockChanges(input: {
  operations: Array<{ kind: string }>;
  local?: SemanticDocument;
  remote?: SemanticDocument;
}): CodeBlockChangeSummary[] {
  return input.operations.flatMap((candidate): CodeBlockChangeSummary[] => {
    if (!candidate.kind.startsWith('code-')) return [];
    const operation = candidate as CodeBlockOperation;
    if (operation.kind === 'code-section-reconcile') {
      return [{
        action: 'reconcile' as const,
        locator: operation.locator,
        additions: operation.desiredCodes.length,
        deletions: operation.remoteCodes.length
      }];
    }
    if (operation.kind === 'code-create') {
      return [{
        action: 'create' as const,
        locator: operation.locator,
        language: operation.desiredCode.resolvedLanguage
      }];
    }
    if (operation.kind === 'code-delete') {
      const remote = findCode(input.remote, operation.sourceLocator);
      return [{
        action: 'delete' as const,
        locator: operation.locator,
        language: remote?.resolvedLanguage
      }];
    }
    if (operation.kind === 'code-move') {
      return [{
        action: 'move' as const,
        locator: operation.locator,
        language: operation.desiredCode.resolvedLanguage,
        move: {
          from: operation.sourceLocator.sectionPath,
          to: operation.locator.sectionPath
        }
      }];
    }
    const remote = findCode(input.remote, operation.sourceLocator);
    return [{
      action: 'update' as const,
      locator: operation.locator,
      language: operation.desiredCode.resolvedLanguage,
      contentChanged: remote ? remote.content !== operation.desiredCode.content : true,
      ...(remote && remote.resolvedLanguage !== operation.desiredCode.resolvedLanguage
        ? { languageChange: { from: remote.resolvedLanguage, to: operation.desiredCode.resolvedLanguage } }
        : {})
    }];
  });
}

function findCode(document: SemanticDocument | undefined, locator: SemanticLocator): SemanticCodeBlock | undefined {
  return document?.nodes.find((node): node is SemanticCodeBlock => {
    return node.kind === 'code' && locatorKey(node.locator) === locatorKey(locator);
  });
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}
