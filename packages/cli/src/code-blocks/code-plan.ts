import { semanticHash } from '../semantic/normalize.js';
import type {
  SemanticCodeBlock,
  SemanticDocument,
  SemanticLocator
} from '../semantic/types.js';

export type CodeUpdateOperation = {
  kind: 'code-update';
  locator: SemanticLocator;
  sourceLocator: SemanticLocator;
  remoteBlockId?: string;
  desiredCode: SemanticCodeBlock;
};

export type CodeCreateOperation = {
  kind: 'code-create';
  locator: SemanticLocator;
  afterLocator?: SemanticLocator;
  desiredCode: SemanticCodeBlock;
};

export type CodeMoveOperation = {
  kind: 'code-move';
  locator: SemanticLocator;
  sourceLocator: SemanticLocator;
  afterLocator?: SemanticLocator;
  remoteBlockId?: string;
  desiredCode: SemanticCodeBlock;
};

export type CodeDeleteOperation = {
  kind: 'code-delete';
  locator: SemanticLocator;
  sourceLocator: SemanticLocator;
  remoteBlockId?: string;
};

export type CodeSectionReconcileOperation = {
  kind: 'code-section-reconcile';
  locator: SemanticLocator;
  sectionPaths: string[][];
  desiredCodes: Array<{ code: SemanticCodeBlock; afterLocator?: SemanticLocator }>;
  remoteCodes: SemanticCodeBlock[];
};

export type CodeBlockOperation =
  | CodeUpdateOperation
  | CodeCreateOperation
  | CodeMoveOperation
  | CodeDeleteOperation
  | CodeSectionReconcileOperation;

export type CodePlanBlocker = {
  code:
    | 'unsupported-code-language'
    | 'unsupported-code-info-string'
    | 'remote-code-conflict'
    | 'remote-code-scope-changed'
    | 'code-correspondence-ambiguous'
    | 'caption-correspondence-ambiguous';
  locator?: SemanticLocator;
  field?: 'content' | 'language' | 'position' | 'deletion';
  message: string;
};

export type CodeBlockPlan = {
  operations: CodeBlockOperation[];
  blockers: CodePlanBlocker[];
  warnings: string[];
  requiresCollaborationRiskConfirmation: boolean;
};

export function planCodeBlockChanges(input: {
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): CodeBlockPlan {
  const blockers: CodePlanBlocker[] = localCodes(input.localCurrent).flatMap((code) => code.issues.map((issue) => ({
    ...issue,
    locator: code.locator
  })));
  if (blockers.length > 0) return finish([], blockers, []);
  if (!input.tracked || !input.localBase || !input.remoteBase) {
    return planUntracked(input.localCurrent, input.remoteCurrent, blockers);
  }

  const baseLocal = localCodes(input.localBase);
  const baseRemote = localCodes(input.remoteBase);
  const currentLocal = localCodes(input.localCurrent);
  const currentRemote = localCodes(input.remoteCurrent);
  const localMatches = matchFromBaseline(baseLocal, currentLocal);
  const remoteMatches = matchFromBaseline(baseRemote, currentRemote);
  const operations: CodeBlockOperation[] = [];
  const usedLocal = new Set(currentLocal.filter((code) => [...localMatches.values()].includes(code)));
  const unmatchedBase: SemanticCodeBlock[] = [];

  for (let index = 0; index < baseLocal.length; index += 1) {
    const localBase = baseLocal[index]!;
    const remoteBase = findByLocator(baseRemote, localBase.locator) ?? baseRemote[index];
    if (!remoteBase) {
      blockers.push(blocker('code-correspondence-ambiguous', localBase.locator, 'remote Code baseline is missing'));
      continue;
    }
    const local = localMatches.get(localBase);
    const remote = remoteMatches.get(remoteBase);

    if (!local) {
      if (!remote) continue;
      if (!managedEqual(remoteBase, remote) || !samePosition(remoteBase, remote)) {
        blockers.push({
          ...blocker('remote-code-conflict', localBase.locator, 'remote Code block changed while local deleted it'),
          field: 'deletion'
        });
        continue;
      }
      operations.push({
        kind: 'code-delete',
        locator: localBase.locator,
        sourceLocator: remote.locator,
        remoteBlockId: remote.remoteBlockId
      });
      continue;
    }

    if (!remote) {
      blockers.push({
        ...blocker('remote-code-conflict', local.locator, 'remote Code block was deleted while local retained or changed it'),
        field: 'deletion'
      });
      continue;
    }

    const merged = mergeManagedFields({ localBase, local, remoteBase, remote });
    if (merged.blockers.length > 0) {
      blockers.push(...merged.blockers);
      continue;
    }
    const localMoved = !samePosition(localBase, local);
    const remoteMoved = !samePosition(remoteBase, remote);
    if (localMoved && remoteMoved && !samePosition(local, remote)) {
      blockers.push({
        ...blocker('remote-code-conflict', local.locator, 'local and remote moved the same Code block differently'),
        field: 'position'
      });
      continue;
    }
    const desiredCode: SemanticCodeBlock = {
      ...local,
      content: merged.content,
      resolvedLanguage: merged.language,
      caption: remote.caption,
      remoteBlockId: remote.remoteBlockId,
      issues: []
    };
    if (!managedEqual(desiredCode, remote)) {
      operations.push({
        kind: 'code-update',
        locator: local.locator,
        sourceLocator: remote.locator,
        remoteBlockId: remote.remoteBlockId,
        desiredCode
      });
    }
    if (localMoved && !remoteMoved) {
      operations.push({
        kind: 'code-move',
        locator: local.locator,
        sourceLocator: remote.locator,
        afterLocator: previousLocator(input.localCurrent, local),
        remoteBlockId: remote.remoteBlockId,
        desiredCode
      });
    }
  }

  for (const base of baseLocal) {
    if (!localMatches.get(base)) unmatchedBase.push(base);
  }
  const unmatchedLocal = currentLocal.filter((code) => !usedLocal.has(code));
  const needsReconcile = unmatchedBase.length > 0 && unmatchedLocal.length > 0;
  if (needsReconcile) {
    const sectionPaths = uniqueSections([...unmatchedBase, ...unmatchedLocal]);
    const remoteScopeChanged = sectionPaths.some((section) => {
      return !scopeEqual(codesInSection(baseRemote, section), codesInSection(currentRemote, section));
    });
    if (remoteScopeChanged) {
      blockers.push(blocker(
        'remote-code-scope-changed',
        unmatchedLocal[0]?.locator,
        'remote Code scope changed in a section required for reconcile'
      ));
    } else {
      const desiredFingerprints = new Set(unmatchedLocal.map(managedFingerprint));
      const captioned = currentRemote.find((code) => {
        return Boolean(code.caption) &&
          sectionPaths.some((section) => sameSection(code.locator.sectionPath, section)) &&
          !desiredFingerprints.has(managedFingerprint(code));
      });
      if (captioned) {
        blockers.push(blocker(
          'caption-correspondence-ambiguous',
          captioned.locator,
          'cannot safely preserve the caption of an unmatched Code block during section reconcile'
        ));
      } else {
        removeOperationsForSections(operations, sectionPaths);
        const desiredCodes = currentLocal
          .filter((code) => sectionPaths.some((section) => sameSection(code.locator.sectionPath, section)))
          .map((code) => ({ code, afterLocator: previousLocator(input.localCurrent, code) }));
        operations.push({
          kind: 'code-section-reconcile',
          locator: unmatchedLocal[0]!.locator,
          sectionPaths,
          desiredCodes,
          remoteCodes: currentRemote.filter((code) => {
            return sectionPaths.some((section) => sameSection(code.locator.sectionPath, section));
          })
        });
      }
    }
  } else {
    for (const code of unmatchedLocal) {
      operations.push({
        kind: 'code-create',
        locator: code.locator,
        afterLocator: previousLocator(input.localCurrent, code),
        desiredCode: code
      });
    }
  }

  return finish(operations, blockers, []);
}

function planUntracked(
  localDocument: SemanticDocument,
  remoteDocument: SemanticDocument,
  blockers: CodePlanBlocker[]
): CodeBlockPlan {
  const operations: CodeBlockOperation[] = [];
  const local = localCodes(localDocument);
  const remote = localCodes(remoteDocument);
  const usedRemote = new Set<SemanticCodeBlock>();
  for (const code of local) {
    const match = findByLocator(remote, code.locator) ?? uniqueByFingerprint(remote, managedFingerprint(code));
    if (!match) {
      operations.push({
        kind: 'code-create',
        locator: code.locator,
        afterLocator: previousLocator(localDocument, code),
        desiredCode: code
      });
      continue;
    }
    usedRemote.add(match);
    if (!managedEqual(code, match)) {
      operations.push({
        kind: 'code-update',
        locator: code.locator,
        sourceLocator: match.locator,
        remoteBlockId: match.remoteBlockId,
        desiredCode: { ...code, caption: match.caption, remoteBlockId: match.remoteBlockId }
      });
    }
  }
  for (const code of remote.filter((candidate) => !usedRemote.has(candidate))) {
    operations.push({
      kind: 'code-delete',
      locator: code.locator,
      sourceLocator: code.locator,
      remoteBlockId: code.remoteBlockId
    });
  }
  return finish(operations, blockers, []);
}

function matchFromBaseline(
  baseline: SemanticCodeBlock[],
  current: SemanticCodeBlock[]
): Map<SemanticCodeBlock, SemanticCodeBlock> {
  const result = new Map<SemanticCodeBlock, SemanticCodeBlock>();
  const used = new Set<SemanticCodeBlock>();
  for (const base of baseline) {
    const byFingerprint = uniqueByFingerprint(current.filter((code) => !used.has(code)), managedFingerprint(base));
    const match = byFingerprint ?? findByLocator(current.filter((code) => !used.has(code)), base.locator);
    if (match) {
      result.set(base, match);
      used.add(match);
    }
  }
  return result;
}

function mergeManagedFields(input: {
  localBase: SemanticCodeBlock;
  local: SemanticCodeBlock;
  remoteBase: SemanticCodeBlock;
  remote: SemanticCodeBlock;
}): { content: string; language: string; blockers: CodePlanBlocker[] } {
  const blockers: CodePlanBlocker[] = [];
  const content = mergeField('content', input.localBase.content, input.local.content, input.remoteBase.content, input.remote.content);
  const language = mergeField(
    'language',
    input.localBase.resolvedLanguage,
    input.local.resolvedLanguage,
    input.remoteBase.resolvedLanguage,
    input.remote.resolvedLanguage
  );
  if (content.conflict) blockers.push({
    ...blocker('remote-code-conflict', input.local.locator, 'local and remote changed Code content differently'),
    field: 'content'
  });
  if (language.conflict) blockers.push({
    ...blocker('remote-code-conflict', input.local.locator, 'local and remote changed Code language differently'),
    field: 'language'
  });
  return { content: content.value, language: language.value, blockers };
}

function mergeField<T>(field: string, base: T, local: T, remoteBase: T, remote: T): { value: T; conflict: boolean } {
  const localChanged = local !== base;
  const remoteChanged = remote !== remoteBase;
  if (localChanged && remoteChanged && local !== remote) return { value: local, conflict: true };
  return { value: localChanged ? local : remote, conflict: false };
}

function finish(
  operations: CodeBlockOperation[],
  blockers: CodePlanBlocker[],
  warnings: string[]
): CodeBlockPlan {
  return {
    operations,
    blockers,
    warnings,
    requiresCollaborationRiskConfirmation: operations.some((operation) => operation.kind !== 'code-create')
  };
}

function blocker(code: CodePlanBlocker['code'], locator: SemanticLocator | undefined, message: string): CodePlanBlocker {
  return { code, locator, message };
}

function localCodes(document: SemanticDocument): SemanticCodeBlock[] {
  return document.nodes.filter((node): node is SemanticCodeBlock => node.kind === 'code');
}

function findByLocator(codes: SemanticCodeBlock[], locator: SemanticLocator): SemanticCodeBlock | undefined {
  return codes.find((code) => locatorKey(code.locator) === locatorKey(locator));
}

function uniqueByFingerprint(codes: SemanticCodeBlock[], fingerprint: string): SemanticCodeBlock | undefined {
  const matches = codes.filter((code) => managedFingerprint(code) === fingerprint);
  return matches.length === 1 ? matches[0] : undefined;
}

function managedFingerprint(code: SemanticCodeBlock): string {
  return semanticHash({ content: code.content, language: code.resolvedLanguage });
}

function managedEqual(left: SemanticCodeBlock, right: SemanticCodeBlock): boolean {
  return left.content === right.content && left.resolvedLanguage === right.resolvedLanguage;
}

function samePosition(left: SemanticCodeBlock, right: SemanticCodeBlock): boolean {
  return locatorKey(left.locator) === locatorKey(right.locator);
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

function previousLocator(document: SemanticDocument, code: SemanticCodeBlock): SemanticLocator | undefined {
  const index = document.nodes.indexOf(code);
  return index > 0 ? document.nodes[index - 1]?.locator : undefined;
}

function uniqueSections(codes: SemanticCodeBlock[]): string[][] {
  const seen = new Set<string>();
  return codes.flatMap((code) => {
    const key = JSON.stringify(code.locator.sectionPath);
    if (seen.has(key)) return [];
    seen.add(key);
    return [code.locator.sectionPath];
  });
}

function codesInSection(codes: SemanticCodeBlock[], section: string[]): SemanticCodeBlock[] {
  return codes.filter((code) => sameSection(code.locator.sectionPath, section));
}

function sameSection(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function scopeEqual(left: SemanticCodeBlock[], right: SemanticCodeBlock[]): boolean {
  return left.length === right.length && left.every((code, index) => {
    const candidate = right[index];
    return Boolean(candidate && managedEqual(code, candidate) && samePosition(code, candidate));
  });
}

function removeOperationsForSections(operations: CodeBlockOperation[], sections: string[][]): void {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index]!;
    if (sections.some((section) => sameSection(operation.locator.sectionPath, section))) {
      operations.splice(index, 1);
    }
  }
}
