import { canonicalizeMarkdownSemantics } from '../semantic/markdown-equivalence.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type {
  SemanticAuthoringToken,
  SemanticDocument,
  SemanticLocator,
  SemanticNode
} from '../semantic/types.js';

export type ProceduresOperation =
  | {
      kind: 'authoring-token-create';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      parentBlockId: string;
      insertAfterBlockId: string;
    }
  | {
      kind: 'authoring-token-move';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      remoteBlockId: string;
      insertAfterBlockId: string;
    }
  | {
      kind: 'authoring-token-delete';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      parentBlockId: string;
      remoteBlockId: string;
    };

export type ProceduresPlanBlocker = {
  code: 'procedures-anchor-missing' | 'procedures-boundary-ambiguous' | 'procedures-move-unsupported';
  message: string;
};

export function planProceduresChanges(input: {
  parentBlockId: string;
  local: SemanticDocument;
  remote: SemanticDocument;
  supportsBlockMove?: boolean;
}): {
  operations: ProceduresOperation[];
  blockers: ProceduresPlanBlocker[];
} {
  const operations: ProceduresOperation[] = [];
  const blockers: ProceduresPlanBlocker[] = [];
  const localTokens = authoringTokens(input.local);
  const remoteTokens = authoringTokens(input.remote);

  if (localTokens.length === 0) {
    if (remoteTokens.length === 0) return { operations, blockers };
    if (remoteTokens.length !== 2 || !isPaired(remoteTokens)) {
      blockers.push({
        code: 'procedures-boundary-ambiguous',
        message: 'Remote Procedures deletion requires exactly one complete, uniquely paired boundary.'
      });
      return { operations, blockers };
    }
    for (const token of remoteTokens) {
      if (!token.remoteBlockId) {
        blockers.push({
          code: 'procedures-anchor-missing',
          message: `Remote ${token.markdown} block ID is missing.`
        });
        continue;
      }
      operations.push({
        kind: 'authoring-token-delete',
        locator: token.locator,
        token: token.markdown,
        parentBlockId: input.parentBlockId,
        remoteBlockId: token.remoteBlockId
      });
    }
    return { operations, blockers };
  }

  if (!isPaired(localTokens)) {
    blockers.push({
      code: 'procedures-boundary-ambiguous',
      message: 'Local Procedures tokens are not a complete, uniquely paired boundary.'
    });
    return { operations, blockers };
  }

  const desiredBoundaries: Array<{
    localToken: SemanticAuthoringToken;
    remoteAnchor: SemanticNode;
    remoteAnchorBlockId: string;
    remoteToken?: SemanticAuthoringToken;
  }> = [];
  for (const localToken of localTokens) {
    const localIndex = input.local.nodes.indexOf(localToken);
    const localAnchor = previousNonToken(input.local.nodes, localIndex);
    if (!localAnchor) {
      blockers.push({
        code: 'procedures-anchor-missing',
        message: `Cannot find a semantic predecessor for ${localToken.markdown}.`
      });
      continue;
    }
    const anchorCandidates = input.remote.nodes.filter((candidate) => {
      return candidate.kind !== 'authoring-token' &&
        correspondingSectionPath(candidate.locator.sectionPath, localAnchor.locator.sectionPath) &&
        nodeFingerprint(candidate) === nodeFingerprint(localAnchor);
    });
    if (anchorCandidates.length === 0) {
      blockers.push({
        code: 'procedures-anchor-missing',
        message: `Cannot find the remote predecessor for ${localToken.markdown}.`
      });
      continue;
    }
    if (anchorCandidates.length !== 1) {
      blockers.push({
        code: 'procedures-boundary-ambiguous',
        message: `The remote predecessor for ${localToken.markdown} is not unique.`
      });
      continue;
    }
    const remoteAnchor = anchorCandidates[0];
    if (!remoteAnchor?.remoteBlockId) {
      blockers.push({
        code: 'procedures-anchor-missing',
        message: `The remote predecessor for ${localToken.markdown} has no block ID.`
      });
      continue;
    }

    desiredBoundaries.push({
      localToken,
      remoteAnchor,
      remoteAnchorBlockId: remoteAnchor.remoteBlockId
    });
  }

  const claimedRemoteTokens = new Set<SemanticAuthoringToken>();
  const blockedLocalTokens = new Set<SemanticAuthoringToken>();
  for (const boundary of desiredBoundaries) {
    const exactMatches = remoteTokens.filter((candidate) => {
      if (claimedRemoteTokens.has(candidate)) return false;
      if (candidate.token !== boundary.localToken.token ||
        !correspondingSectionPath(candidate.locator.sectionPath, boundary.localToken.locator.sectionPath)) {
        return false;
      }
      const candidateIndex = input.remote.nodes.indexOf(candidate);
      return previousNonToken(input.remote.nodes, candidateIndex)?.remoteBlockId ===
        boundary.remoteAnchorBlockId;
    });
    if (exactMatches.length > 1) {
      blockers.push({
        code: 'procedures-boundary-ambiguous',
        message: `Multiple remote ${boundary.localToken.markdown} tokens exist at the same boundary.`
      });
      blockedLocalTokens.add(boundary.localToken);
      continue;
    }
    const exact = exactMatches[0];
    if (exact) {
      boundary.remoteToken = exact;
      claimedRemoteTokens.add(exact);
    }
  }

  for (const boundary of desiredBoundaries) {
    const { localToken, remoteAnchorBlockId } = boundary;
    if (blockedLocalTokens.has(localToken)) continue;
    let remoteToken = boundary.remoteToken;
    if (!remoteToken) {
      const matchingTokens = remoteTokens.filter((candidate) => {
        return !claimedRemoteTokens.has(candidate) &&
          candidate.token === localToken.token &&
          correspondingSectionPath(candidate.locator.sectionPath, localToken.locator.sectionPath);
      });
      if (matchingTokens.length > 1) {
        blockers.push({
          code: 'procedures-boundary-ambiguous',
          message: `Multiple unmatched remote ${localToken.markdown} tokens exist in the same section.`
        });
        continue;
      }
      remoteToken = matchingTokens[0];
      if (remoteToken) claimedRemoteTokens.add(remoteToken);
    }
    if (!remoteToken) {
      operations.push({
        kind: 'authoring-token-create',
        locator: localToken.locator,
        token: localToken.markdown,
        parentBlockId: input.parentBlockId,
        insertAfterBlockId: remoteAnchorBlockId
      });
      continue;
    }
    if (!remoteToken.remoteBlockId) {
      blockers.push({
        code: 'procedures-anchor-missing',
        message: `Remote ${localToken.markdown} block ID is missing.`
      });
      continue;
    }
    const remoteTokenIndex = input.remote.nodes.indexOf(remoteToken);
    const currentAnchor = previousNonToken(input.remote.nodes, remoteTokenIndex);
    if (currentAnchor?.remoteBlockId === remoteAnchorBlockId) continue;
    if (input.supportsBlockMove === false) {
      blockers.push({
        code: 'procedures-move-unsupported',
        message: `Moving ${localToken.markdown} requires block-move support from the adapter.`
      });
      continue;
    }
    operations.push({
      kind: 'authoring-token-move',
      locator: localToken.locator,
      token: localToken.markdown,
      remoteBlockId: remoteToken.remoteBlockId,
      insertAfterBlockId: remoteAnchorBlockId
    });
  }

  return { operations, blockers };
}

function authoringTokens(document: SemanticDocument): SemanticAuthoringToken[] {
  return document.nodes.filter((node): node is SemanticAuthoringToken => {
    return node.kind === 'authoring-token' && node.component === 'Procedures';
  });
}

function isPaired(tokens: SemanticAuthoringToken[]): boolean {
  if (tokens.length === 0) return true;
  let depth = 0;
  for (const token of tokens) {
    depth += token.token === 'open' ? 1 : -1;
    if (depth < 0 || depth > 1) return false;
  }
  return depth === 0;
}

function previousNonToken(nodes: SemanticNode[], fromIndex: number): SemanticNode | undefined {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node?.kind !== 'authoring-token') return node;
  }
  return undefined;
}

function nodeFingerprint(node: SemanticNode): string {
  const { locator: _locator, ...content } = stripExecutionMetadata(node);
  if (node.kind === 'text') {
    return semanticHash({
      kind: node.kind,
      blockType: node.blockType,
      markdown: canonicalizeMarkdownSemantics(node.markdown)
    });
  }
  return semanticHash(content);
}

function correspondingSectionPath(left: string[], right: string[]): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const offset = longer.length - shorter.length;
  return shorter.every((part, index) => part === longer[index + offset]);
}
