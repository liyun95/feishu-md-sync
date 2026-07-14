import { semanticHash, normalizeWhitespace } from '../semantic/normalize.js';
import type {
  SemanticCallout,
  SemanticCalloutChild,
  SemanticDocument,
  SemanticLocator,
  SemanticNode
} from '../semantic/types.js';

export type CalloutCreateOperation = {
  kind: 'callout-create';
  locator: SemanticLocator;
  parentBlockId: string;
  insertAfterBlockId: string;
  desiredCallout: SemanticCallout;
};

export type CalloutChildUpdateOperation = {
  kind: 'callout-child-update';
  locator: SemanticLocator;
  calloutBlockId: string;
  childOrdinal: number;
  remoteBlockId: string;
  desiredMarkdown: string;
};

export type CalloutChildCreateOperation = {
  kind: 'callout-child-create';
  locator: SemanticLocator;
  calloutBlockId: string;
  childOrdinal: number;
  insertAfterBlockId: string;
  desiredChildren: SemanticCalloutChild[];
  desiredMarkdown: string;
};

export type CalloutChildDeleteOperation = {
  kind: 'callout-child-delete';
  locator: SemanticLocator;
  calloutBlockId: string;
  childOrdinal: number;
  blockIds: string[];
};

export type CalloutDeleteOperation = {
  kind: 'callout-delete';
  locator: SemanticLocator;
  blockIds: string[];
};

export type CalloutOperation =
  | CalloutCreateOperation
  | CalloutChildUpdateOperation
  | CalloutChildCreateOperation
  | CalloutChildDeleteOperation
  | CalloutDeleteOperation;

export type CalloutPlanBlocker = {
  code:
    | 'callout-correspondence-ambiguous'
    | 'callout-type-change'
    | 'unsupported-callout-change'
    | 'remote-callout-conflict';
  locator?: SemanticLocator;
  message: string;
};

export type CalloutPlan = {
  operations: CalloutOperation[];
  blockers: CalloutPlanBlocker[];
  warnings: string[];
  localChanged: SemanticLocator[];
  remoteChanged: SemanticLocator[];
  overlappingConflicts: SemanticLocator[];
  unrelatedRemoteChanges: SemanticLocator[];
  requiresCollaborationRiskConfirmation: boolean;
  requiresUntrackedRemoteConfirmation: boolean;
};

export function planCalloutChanges(input: {
  parentBlockId: string;
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): CalloutPlan {
  const operations: CalloutOperation[] = [];
  const blockers: CalloutPlanBlocker[] = [];
  const localChanged = changedCalloutLocators(input.localBase, input.localCurrent, input.tracked);
  const remoteChanged = input.tracked
    ? changedCalloutLocators(input.remoteBase, input.remoteCurrent, true)
    : [];
  let adoptedUntracked = false;

  if (!input.tracked) {
    for (const local of callouts(input.localCurrent)) {
      if (local.unsupported.length > 0) {
        blockers.push(unsupportedBlocker(local));
        continue;
      }
      const remote = findCallout(input.remoteCurrent, local.locator);
      if (!remote) {
        operations.push(createOperation(input.parentBlockId, input.localCurrent, input.remoteCurrent, local));
        continue;
      }
      if (!sameCalloutType(local, remote) || !adjacencyMatches(input.localCurrent, input.remoteCurrent, local, remote)) {
        blockers.push({
          code: 'callout-correspondence-ambiguous',
          locator: local.locator,
          message: `untracked Callout correspondence is ambiguous: ${locatorLabel(local.locator)}`
        });
        continue;
      }
      adoptedUntracked = true;
      planRemoteToDesired(remote, local, operations, blockers);
    }
  } else {
    const localPairs = alignTrackedCallouts(input.localBase, input.localCurrent);
    const remotePairs = alignTrackedCallouts(input.remoteBase, input.remoteCurrent);
    const remoteByBase = new Map(remotePairs.flatMap((pair) => {
      return pair.base ? [[locatorKey(pair.base.locator), pair] as const] : [];
    }));
    const remoteAdditions = remotePairs.flatMap((pair) => !pair.base && pair.current ? [pair.current] : []);
    for (const pair of localPairs) {
      const localBase = pair.base;
      const localCurrent = pair.current;
      const remotePair = localBase ? remoteByBase.get(locatorKey(localBase.locator)) : undefined;
      const remoteBase = remotePair?.base;
      const remoteCurrentRaw = remotePair?.current ?? (!localBase && localCurrent
        ? remoteAdditions.find((candidate) => locatorKey(candidate.locator) === locatorKey(localCurrent.locator))
        : undefined);
      const remoteCurrent = remoteCurrentRaw && remoteBase?.calloutType
        ? { ...remoteCurrentRaw, calloutType: remoteBase.calloutType }
        : remoteCurrentRaw;

      if (localBase && !localCurrent) {
        if (!remoteCurrent) continue;
        if (!remoteBase || calloutContentHash(remoteBase) !== calloutContentHash(remoteCurrent)) {
          blockers.push(conflictBlocker(localBase.locator, 'remote Callout changed before local deletion'));
          continue;
        }
        if (!remoteCurrent.remoteBlockId) {
          blockers.push(correspondenceBlocker(localBase.locator, 'remote Callout block ID is missing'));
          continue;
        }
        operations.push({
          kind: 'callout-delete',
          locator: localBase.locator,
          blockIds: [remoteCurrent.remoteBlockId]
        });
        continue;
      }

      if (!localCurrent) continue;
      if (!localBase) {
        if (!remoteCurrent) {
          operations.push(createOperation(input.parentBlockId, input.localCurrent, input.remoteCurrent, localCurrent));
          continue;
        }
        if (calloutContentHash(localCurrent) !== calloutContentHash(remoteCurrent)) {
          blockers.push(conflictBlocker(localCurrent.locator, 'local and remote added different Callouts'));
        }
        continue;
      }

      const localDidChange = calloutContentHash(localBase) !== calloutContentHash(localCurrent);
      if (localBase.calloutType !== localCurrent.calloutType) {
        blockers.push({
          code: 'callout-type-change',
          locator: localCurrent.locator,
          message: `Callout type changes are unsupported: ${locatorLabel(localCurrent.locator)}`
        });
        continue;
      }
      if (!localDidChange) continue;
      if (localCurrent.unsupported.length > 0) {
        blockers.push(unsupportedBlocker(localCurrent));
        continue;
      }
      if (!remoteCurrent || !remoteBase) {
        blockers.push(conflictBlocker(localCurrent.locator, 'remote Callout was deleted or its baseline is missing'));
        continue;
      }
      if (!sameCalloutType(localCurrent, remoteCurrent)) {
        blockers.push({
          code: 'callout-type-change',
          locator: localCurrent.locator,
          message: `Callout type changes are unsupported: ${locatorLabel(localCurrent.locator)}`
        });
        continue;
      }
      if (remoteCurrent.unsupported.length > 0) {
        blockers.push(unsupportedBlocker(remoteCurrent));
        continue;
      }
      planThreeWayChildren(localBase, localCurrent, remoteBase, remoteCurrent, operations, blockers);
    }
  }

  const overlappingConflicts = blockers.flatMap((blocker) => {
    return blocker.code === 'remote-callout-conflict' && blocker.locator ? [blocker.locator] : [];
  });
  const localKeys = new Set(localChanged.map(locatorKey));
  const unrelatedRemoteChanges = remoteChanged.filter((locator) => !localKeys.has(locatorKey(locator)));
  const requiresCollaborationRiskConfirmation = adoptedUntracked || operations.some((operation) => {
    return operation.kind !== 'callout-create';
  });

  return {
    operations,
    blockers,
    warnings: [],
    localChanged,
    remoteChanged,
    overlappingConflicts,
    unrelatedRemoteChanges,
    requiresCollaborationRiskConfirmation,
    requiresUntrackedRemoteConfirmation: adoptedUntracked
  };
}

export function calloutContentHash(callout: SemanticCallout): string {
  return semanticHash({
    calloutType: callout.calloutType,
    children: callout.children.map((child) => ({
      blockType: child.blockType,
      markdown: child.markdown
    })),
    unsupported: callout.unsupported
  });
}

function planThreeWayChildren(
  localBase: SemanticCallout,
  localCurrent: SemanticCallout,
  remoteBase: SemanticCallout,
  remoteCurrent: SemanticCallout,
  operations: CalloutOperation[],
  blockers: CalloutPlanBlocker[]
): void {
  const localStructureChanged = structureHash(localBase.children) !== structureHash(localCurrent.children);
  const remoteStructureChanged = structureHash(remoteBase.children) !== structureHash(remoteCurrent.children);
  if (localStructureChanged || remoteStructureChanged) {
    if (calloutContentHash(localCurrent) === calloutContentHash(remoteCurrent)) return;
    if (calloutContentHash(localBase) === calloutContentHash(remoteCurrent)) {
      planRemoteToDesired(remoteCurrent, localCurrent, operations, blockers);
      return;
    }
    if (calloutContentHash(localBase) === calloutContentHash(localCurrent)) return;
    blockers.push(conflictBlocker(localCurrent.locator, 'local and remote changed Callout structure'));
    return;
  }

  for (let index = 0; index < localCurrent.children.length; index += 1) {
    const baseLocal = localBase.children[index];
    const desired = localCurrent.children[index];
    const baseRemote = remoteBase.children[index];
    const remote = remoteCurrent.children[index];
    if (!baseLocal || !desired || !baseRemote || !remote) {
      blockers.push(conflictBlocker(localCurrent.locator, 'Callout child correspondence is incomplete'));
      return;
    }
    const localChanged = childHash(baseLocal) !== childHash(desired);
    const remoteChanged = childHash(baseRemote) !== childHash(remote);
    if (!localChanged) continue;
    if (remoteChanged && childHash(desired) !== childHash(remote)) {
      blockers.push(conflictBlocker(localCurrent.locator, `Callout child ${index + 1} changed locally and remotely`));
      continue;
    }
    if (childHash(desired) === childHash(remote)) continue;
    if (!remote.remoteBlockId || !remoteCurrent.remoteBlockId) {
      blockers.push(correspondenceBlocker(localCurrent.locator, 'remote Callout child block ID is missing'));
      continue;
    }
    operations.push({
      kind: 'callout-child-update',
      locator: localCurrent.locator,
      calloutBlockId: remoteCurrent.remoteBlockId,
      childOrdinal: index,
      remoteBlockId: remote.remoteBlockId,
      desiredMarkdown: desired.markdown
    });
  }
}

function planRemoteToDesired(
  remote: SemanticCallout,
  desired: SemanticCallout,
  operations: CalloutOperation[],
  blockers: CalloutPlanBlocker[]
): void {
  if (!remote.remoteBlockId) {
    blockers.push(correspondenceBlocker(desired.locator, 'remote Callout block ID is missing'));
    return;
  }
  const prefix = commonPrefix(remote.children, desired.children);
  const suffix = commonSuffix(remote.children, desired.children, prefix);
  const remoteMiddle = remote.children.slice(prefix, remote.children.length - suffix);
  const desiredMiddle = desired.children.slice(prefix, desired.children.length - suffix);
  const overlap = Math.min(remoteMiddle.length, desiredMiddle.length);
  for (let index = 0; index < overlap; index += 1) {
    const remoteChild = remoteMiddle[index];
    const desiredChild = desiredMiddle[index];
    if (!remoteChild || !desiredChild || childHash(remoteChild) === childHash(desiredChild)) continue;
    if (!remoteChild.remoteBlockId) {
      blockers.push(correspondenceBlocker(desired.locator, 'remote Callout child block ID is missing'));
      return;
    }
    operations.push({
      kind: 'callout-child-update',
      locator: desired.locator,
      calloutBlockId: remote.remoteBlockId,
      childOrdinal: prefix + index,
      remoteBlockId: remoteChild.remoteBlockId,
      desiredMarkdown: desiredChild.markdown
    });
  }

  const additions = desiredMiddle.slice(overlap);
  if (additions.length > 0) {
    const previous = remote.children[prefix + overlap - 1];
    const insertAfterBlockId = previous?.remoteBlockId ?? remote.title?.remoteBlockId;
    if (!insertAfterBlockId) {
      blockers.push(correspondenceBlocker(desired.locator, 'Callout insertion anchor is missing'));
      return;
    }
    operations.push({
      kind: 'callout-child-create',
      locator: desired.locator,
      calloutBlockId: remote.remoteBlockId,
      childOrdinal: prefix + overlap,
      insertAfterBlockId,
      desiredChildren: additions,
      desiredMarkdown: additions.map((child) => child.markdown).join('\n\n')
    });
  }

  const deletions = remoteMiddle.slice(overlap);
  if (deletions.length > 0) {
    const blockIds = deletions.flatMap((child) => child.remoteBlockId ? [child.remoteBlockId] : []);
    if (blockIds.length !== deletions.length) {
      blockers.push(correspondenceBlocker(desired.locator, 'Callout deletion block ID is missing'));
      return;
    }
    operations.push({
      kind: 'callout-child-delete',
      locator: desired.locator,
      calloutBlockId: remote.remoteBlockId,
      childOrdinal: prefix + overlap,
      blockIds
    });
  }
}

function createOperation(
  parentBlockId: string,
  local: SemanticDocument,
  remote: SemanticDocument,
  desiredCallout: SemanticCallout
): CalloutCreateOperation {
  return {
    kind: 'callout-create',
    locator: desiredCallout.locator,
    parentBlockId,
    insertAfterBlockId: insertionAnchor(parentBlockId, local, remote, desiredCallout),
    desiredCallout
  };
}

function insertionAnchor(
  parentBlockId: string,
  local: SemanticDocument,
  remote: SemanticDocument,
  desired: SemanticCallout
): string {
  const index = local.nodes.indexOf(desired);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const localNode = local.nodes[cursor];
    if (!localNode) continue;
    const remoteNode = remote.nodes.find((candidate) => locatorKey(candidate.locator) === locatorKey(localNode.locator));
    const blockId = remoteNode ? nodeBlockId(remoteNode) : undefined;
    if (blockId) return blockId;
  }
  return parentBlockId;
}

function adjacencyMatches(
  local: SemanticDocument,
  remote: SemanticDocument,
  localCallout: SemanticCallout,
  remoteCallout: SemanticCallout
): boolean {
  return neighborText(local, localCallout, -1) === neighborText(remote, remoteCallout, -1) &&
    neighborText(local, localCallout, 1) === neighborText(remote, remoteCallout, 1);
}

function neighborText(document: SemanticDocument, callout: SemanticCallout, direction: -1 | 1): string {
  const start = document.nodes.indexOf(callout);
  for (let index = start + direction; index >= 0 && index < document.nodes.length; index += direction) {
    const node = document.nodes[index];
    if (node?.kind === 'text') return normalizeVisibleText(node.markdown);
  }
  return '';
}

function normalizeVisibleText(markdown: string): string {
  return normalizeWhitespace(markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>-]/g, ''));
}

function changedCalloutLocators(
  baseline: SemanticDocument | undefined,
  current: SemanticDocument,
  tracked: boolean
): SemanticLocator[] {
  if (!tracked || !baseline) return callouts(current).map((node) => node.locator);
  return alignTrackedCallouts(baseline, current).flatMap((pair) => {
    if (pair.base && pair.current && calloutContentHash(pair.base) === calloutContentHash(pair.current)) return [];
    const locator = pair.current?.locator ?? pair.base?.locator;
    return locator ? [locator] : [];
  });
}

type TrackedCalloutPair = {
  base?: SemanticCallout;
  current?: SemanticCallout;
};

function alignTrackedCallouts(
  baseline: SemanticDocument | undefined,
  current: SemanticDocument | undefined
): TrackedCalloutPair[] {
  const bases = callouts(baseline);
  const currents = callouts(current);
  const currentByBase = new Map<SemanticCallout, SemanticCallout>();
  const matchedCurrents = new Set<SemanticCallout>();

  matchUniqueCallouts(bases, currents, currentByBase, matchedCurrents, (base, candidate) => {
    return sameSectionPath(base.locator, candidate.locator) &&
      sameCalloutType(base, candidate) &&
      calloutContentHash(base) === calloutContentHash(candidate);
  });

  for (const base of bases) {
    if (currentByBase.has(base)) continue;
    const candidate = currents.find((currentCallout) => {
      return !matchedCurrents.has(currentCallout) &&
        locatorKey(currentCallout.locator) === locatorKey(base.locator) &&
        sameCalloutType(base, currentCallout);
    });
    if (candidate) matchCallouts(base, candidate, currentByBase, matchedCurrents);
  }

  matchUniqueCallouts(bases, currents, currentByBase, matchedCurrents, (base, candidate) => {
    return sameSectionPath(base.locator, candidate.locator) && sameCalloutType(base, candidate);
  });

  for (const base of bases) {
    if (currentByBase.has(base)) continue;
    const candidate = currents.find((currentCallout) => {
      return !matchedCurrents.has(currentCallout) && locatorKey(currentCallout.locator) === locatorKey(base.locator);
    });
    if (candidate) matchCallouts(base, candidate, currentByBase, matchedCurrents);
  }

  return [
    ...bases.map((base) => ({ base, current: currentByBase.get(base) })),
    ...currents.filter((candidate) => !matchedCurrents.has(candidate)).map((candidate) => ({ current: candidate }))
  ];
}

function matchUniqueCallouts(
  bases: SemanticCallout[],
  currents: SemanticCallout[],
  currentByBase: Map<SemanticCallout, SemanticCallout>,
  matchedCurrents: Set<SemanticCallout>,
  matches: (base: SemanticCallout, current: SemanticCallout) => boolean
): void {
  for (const base of bases) {
    if (currentByBase.has(base)) continue;
    const candidates = currents.filter((candidate) => !matchedCurrents.has(candidate) && matches(base, candidate));
    if (candidates.length !== 1) continue;
    const candidate = candidates[0]!;
    const competingBases = bases.filter((other) => !currentByBase.has(other) && matches(other, candidate));
    if (competingBases.length !== 1) continue;
    matchCallouts(base, candidate, currentByBase, matchedCurrents);
  }
}

function matchCallouts(
  base: SemanticCallout,
  current: SemanticCallout,
  currentByBase: Map<SemanticCallout, SemanticCallout>,
  matchedCurrents: Set<SemanticCallout>
): void {
  currentByBase.set(base, current);
  matchedCurrents.add(current);
}

function sameSectionPath(left: SemanticLocator, right: SemanticLocator): boolean {
  return left.sectionPath.length === right.sectionPath.length &&
    left.sectionPath.every((part, index) => part === right.sectionPath[index]);
}

function structureHash(children: SemanticCalloutChild[]): string {
  return semanticHash(children.map((child) => child.blockType));
}

function childHash(child: SemanticCalloutChild): string {
  return semanticHash({ blockType: child.blockType, markdown: child.markdown });
}

function commonPrefix(remote: SemanticCalloutChild[], desired: SemanticCalloutChild[]): number {
  const length = Math.min(remote.length, desired.length);
  for (let index = 0; index < length; index += 1) {
    if (childHash(remote[index]!) !== childHash(desired[index]!)) return index;
  }
  return length;
}

function commonSuffix(remote: SemanticCalloutChild[], desired: SemanticCalloutChild[], prefix: number): number {
  const length = Math.min(remote.length, desired.length) - prefix;
  for (let offset = 0; offset < length; offset += 1) {
    if (childHash(remote[remote.length - 1 - offset]!) !== childHash(desired[desired.length - 1 - offset]!)) return offset;
  }
  return length;
}

function sameCalloutType(local: SemanticCallout, remote: SemanticCallout): boolean {
  return Boolean(local.calloutType && remote.calloutType && local.calloutType === remote.calloutType);
}

function callouts(document: SemanticDocument | undefined): SemanticCallout[] {
  return document?.nodes.filter((node): node is SemanticCallout => node.kind === 'callout') ?? [];
}

function findCallout(document: SemanticDocument, locator: SemanticLocator): SemanticCallout | undefined {
  return findCalloutByKey(document, locatorKey(locator));
}

function findCalloutByKey(document: SemanticDocument | undefined, key: string): SemanticCallout | undefined {
  return callouts(document).find((node) => locatorKey(node.locator) === key);
}

function nodeBlockId(node: SemanticNode): string | undefined {
  return 'remoteBlockId' in node ? node.remoteBlockId : undefined;
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

function locatorLabel(locator: SemanticLocator): string {
  return `${locator.sectionPath.join(' > ') || '<root>'} [${locator.ordinal}]`;
}

function unsupportedBlocker(callout: SemanticCallout): CalloutPlanBlocker {
  return {
    code: 'unsupported-callout-change',
    locator: callout.locator,
    message: `unsupported Callout change: ${callout.unsupported.join('; ')}`
  };
}

function conflictBlocker(locator: SemanticLocator, message: string): CalloutPlanBlocker {
  return { code: 'remote-callout-conflict', locator, message };
}

function correspondenceBlocker(locator: SemanticLocator, message: string): CalloutPlanBlocker {
  return { code: 'callout-correspondence-ambiguous', locator, message };
}
