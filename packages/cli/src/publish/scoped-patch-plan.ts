import type { FeishuBlock } from '../feishu/types.js';
import {
  planCodeBlockChanges,
  type CodeBlockOperation,
  type CodePlanBlocker
} from '../code-blocks/code-plan.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import {
  canonicalizeAuthoringIncludeMarkup,
  normalizeWhitespace,
  preserveAuthoringIncludeMarkup,
  preserveRemoteFeishuLinkDestinations,
  semanticHash,
  stripExecutionMetadata
} from '../semantic/normalize.js';
import type {
  SemanticDocument,
  SemanticLocator,
  SemanticNode,
  SemanticTable,
  SemanticTextBlock
} from '../semantic/types.js';
import { planPublishBlockPatch } from './block-patch-plan.js';
import {
  calloutContentHash,
  planCalloutChanges,
  type CalloutOperation,
  type CalloutPlanBlocker
} from './callout-plan.js';
import {
  diffCorrespondingTable,
  findCorrespondingRemoteTable,
  preserveEquivalentRemoteTableRepresentation,
  tableCellsSemanticallyEquivalent,
  tableHeaderCellsSemanticallyEquivalent,
  tableIdentity,
  type TableDiff
} from './table-diff.js';
import { canonicalizeMarkdownSemantics } from '../semantic/markdown-equivalence.js';
import {
  planProceduresChanges,
  type ProceduresOperation,
  type ProceduresPlanBlocker
} from '../zdoc/procedures-plan.js';

export type ScopedTextUpdateOperation = {
  kind: 'update';
  locator: SemanticLocator;
  remoteBlockId: string;
  desiredMarkdown: string;
};

export type ScopedTextCreateOperation = {
  kind: 'create';
  locator: SemanticLocator;
  parentBlockId: string;
  insertAfterBlockId: string;
  afterLocator?: SemanticLocator;
  desiredMarkdown: string;
};

export type ScopedTextDeleteOperation = {
  kind: 'delete';
  locator: SemanticLocator;
  parentBlockId: string;
  blockIds: string[];
};

export type TableReplaceOperation = {
  kind: 'table-replace';
  locator: SemanticLocator;
  remoteBlockId: string;
  desiredTable: SemanticTable;
  diff: TableDiff;
};

export type ScopedPatchOperation =
  | ScopedTextUpdateOperation
  | ScopedTextCreateOperation
  | ScopedTextDeleteOperation
  | TableReplaceOperation
  | CalloutOperation
  | CodeBlockOperation
  | ProceduresOperation;

export type ScopedPatchBlocker = {
  code:
    | 'correspondence-ambiguous'
    | 'unsupported-local-change'
    | 'remote-scope-conflict'
    | CalloutPlanBlocker['code']
    | CodePlanBlocker['code']
    | ProceduresPlanBlocker['code'];
  locator?: SemanticLocator;
  message: string;
};

export type ScopedPatchPlan = {
  kind: 'scoped-patch-plan';
  safeToWrite: boolean;
  operations: ScopedPatchOperation[];
  blockers: ScopedPatchBlocker[];
  warnings: string[];
  requiresCollaborationRiskConfirmation: boolean;
  scopeSummary: {
    localChanged: SemanticLocator[];
    remoteChanged: SemanticLocator[];
    overlappingConflicts: SemanticLocator[];
    unrelatedRemoteChanges: SemanticLocator[];
  };
};

export function planScopedPatch(input: {
  parentBlockId: string;
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
  supportsBlockMove?: boolean;
}): ScopedPatchPlan {
  const blockers: ScopedPatchBlocker[] = [];
  const warnings: string[] = [];
  const localChanged = changedLocatorKeys(input.localBase, input.localCurrent, input.tracked);
  const remoteChanged = input.tracked
    ? changedLocatorKeys(input.remoteBase, input.remoteCurrent, true)
    : new Set<string>();

  for (const node of input.localCurrent.nodes) {
    if (node.kind !== 'opaque') continue;
    if (node.description === 'unsupported indented fenced Code block') {
      blockers.push({
        code: 'unsupported-local-change',
        locator: node.locator,
        message: `unsupported local change: ${node.description}`
      });
    } else if (!input.tracked) {
      warnings.push(`adopting opaque local scope: ${node.description}`);
    } else if (localChanged.has(locatorKey(node.locator))) {
      blockers.push({
        code: 'unsupported-local-change',
        locator: node.locator,
        message: `unsupported local change: ${node.description}`
      });
    }
  }

  if (input.tracked && input.localBase) {
    const currentKeys = new Set(input.localCurrent.nodes.map((node) => locatorKey(node.locator)));
    for (const baselineNode of input.localBase.nodes) {
      if (currentKeys.has(locatorKey(baselineNode.locator))) continue;
      if (baselineNode.kind === 'table') {
        blockers.push({
          code: 'unsupported-local-change',
          locator: baselineNode.locator,
          message: `source table deletion is unsupported: ${tableIdentity(baselineNode)}`
        });
      } else if (baselineNode.kind === 'opaque') {
        blockers.push({
          code: 'unsupported-local-change',
          locator: baselineNode.locator,
          message: `unsupported local opaque deletion: ${baselineNode.description}`
        });
      }
    }
  }

  const textPlanning = planTextScopes({ ...input, localChanged, remoteChanged, blockers, warnings });
  const calloutPlanning = planCalloutChanges(input);
  const codePlanning = planCodeBlockChanges(input);
  const proceduresPlanning = planProceduresChanges({
    parentBlockId: input.parentBlockId,
    local: input.localCurrent,
    remote: input.remoteCurrent,
    supportsBlockMove: input.supportsBlockMove
  });
  blockers.push(...calloutPlanning.blockers);
  blockers.push(...codePlanning.blockers);
  blockers.push(...proceduresPlanning.blockers);
  warnings.push(...calloutPlanning.warnings);
  warnings.push(...codePlanning.warnings);
  const operations: ScopedPatchOperation[] = [
    ...textPlanning.operations,
    ...calloutPlanning.operations,
    ...codePlanning.operations,
    ...proceduresPlanning.operations
  ];
  if (textPlanning.fallbackReason) {
    blockers.push({
      code: 'unsupported-local-change',
      message: `text block planning unavailable: ${textPlanning.fallbackReason}`
    });
  }

  for (const sourceTable of input.localCurrent.nodes.filter(isTable)) {
    const key = locatorKey(sourceTable.locator);
    if (input.tracked && !localChanged.has(key)) continue;

    const baselineSource = input.tracked
      ? findTableByLocator(input.localBase, sourceTable.locator)
      : undefined;
    const baselineRemote = baselineSource
      ? findCorrespondingRemoteTable(baselineSource, input.remoteBase ?? { nodes: [] }).table
      : undefined;
    let match = findCorrespondingRemoteTable(sourceTable, input.remoteCurrent);
    if (!match.table && baselineRemote) {
      match = findCorrespondingRemoteTable(baselineRemote, input.remoteCurrent);
    }
    if (!match.table) {
      blockers.push({
        code: 'correspondence-ambiguous',
        locator: sourceTable.locator,
        message: match.blocker ?? `table correspondence missing: ${tableIdentity(sourceTable)}`
      });
      continue;
    }

    if (input.tracked) {
      if (!baselineRemote) {
        blockers.push({
          code: 'correspondence-ambiguous',
          locator: sourceTable.locator,
          message: `remote table baseline missing: ${tableIdentity(sourceTable)}`
        });
        continue;
      }
    }

    let desiredTable = sourceTable;
    if (input.tracked && baselineSource && baselineRemote) {
      const merged = mergeTrackedTableDelta({
        localBase: baselineSource,
        localCurrent: sourceTable,
        remoteBase: baselineRemote,
        remoteCurrent: match.table
      });
      if (!merged.table) {
        blockers.push(...merged.blockers.map((message) => ({
          code: 'unsupported-local-change' as const,
          locator: sourceTable.locator,
          message
        })));
        continue;
      }
      desiredTable = merged.table;
    } else if (input.tracked) {
      desiredTable = preserveEquivalentRemoteTableRepresentation(sourceTable, match.table);
    }
    const desiredEqualsRemote = semanticNodeHash(desiredTable) === semanticNodeHash(match.table);
    if (desiredEqualsRemote) continue;
    if (input.tracked && baselineRemote &&
      semanticNodeHash(baselineRemote) !== semanticNodeHash(match.table)) {
      blockers.push({
        code: 'remote-scope-conflict',
        locator: sourceTable.locator,
        message: `remote table changed in managed scope: ${tableIdentity(sourceTable)}`
      });
      continue;
    }

    const diff = diffCorrespondingTable(match.table, desiredTable, {
      allowHeaderChanges: Boolean(baselineSource && baselineRemote),
      allowSingleRowRename: Boolean(baselineSource && baselineRemote)
    });
    if (diff.blockers.length > 0) {
      blockers.push(...diff.blockers.map((message) => ({
        code: 'unsupported-local-change' as const,
        locator: sourceTable.locator,
        message
      })));
      continue;
    }
    if (!diff.headerChanged && diff.additions.length === 0 && diff.updates.length === 0) continue;
    if (!match.table.remoteBlockId) {
      blockers.push({
        code: 'correspondence-ambiguous',
        locator: sourceTable.locator,
        message: `remote table block ID missing: ${tableIdentity(sourceTable)}`
      });
      continue;
    }
    operations.push({
      kind: 'table-replace',
      locator: sourceTable.locator,
      remoteBlockId: match.table.remoteBlockId,
      desiredTable,
      diff
    });
  }

  const localChangedKeys = new Set(localChanged);
  if ([...remoteChanged].some((key) => !localChangedKeys.has(key))) {
    warnings.push('remote changed outside managed scopes');
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    kind: 'scoped-patch-plan',
    safeToWrite: blockers.length === 0,
    operations,
    blockers,
    warnings: uniqueWarnings,
    requiresCollaborationRiskConfirmation: calloutPlanning.requiresCollaborationRiskConfirmation ||
      codePlanning.requiresCollaborationRiskConfirmation || operations.some((operation) => {
      return operation.kind === 'update' || operation.kind === 'delete' || operation.kind === 'table-replace' ||
        operation.kind === 'authoring-token-move' || operation.kind === 'authoring-token-delete';
    }),
    scopeSummary: {
      localChanged: locatorsForKeys(input.localCurrent, localChanged),
      remoteChanged: locatorsForKeys(input.remoteCurrent, remoteChanged),
      overlappingConflicts: blockers.flatMap((blocker) => {
        return (blocker.code === 'remote-scope-conflict' || blocker.code === 'remote-callout-conflict' ||
          blocker.code === 'remote-code-conflict' || blocker.code === 'remote-code-scope-changed') && blocker.locator
          ? [blocker.locator]
          : [];
      }),
      unrelatedRemoteChanges: locatorsForKeys(
        input.remoteCurrent,
        new Set([...remoteChanged].filter((key) => !localChanged.has(key)))
      )
    }
  };
}

function planTextScopes(input: {
  parentBlockId: string;
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
  localChanged: Set<string>;
  remoteChanged: Set<string>;
  blockers: ScopedPatchBlocker[];
  warnings: string[];
}): { operations: ScopedPatchOperation[]; fallbackReason?: string } {
  const localIncludeBoundaries = input.localCurrent.nodes.filter((node) => {
    return node.kind === 'text' && isStandaloneIncludeBoundary(node.markdown);
  }).length;
  const remoteIncludeBoundaries = input.remoteCurrent.nodes.filter((node) => {
    return node.kind === 'text' && isStandaloneIncludeBoundary(node.markdown);
  }).length;
  if (remoteIncludeBoundaries > localIncludeBoundaries) {
    input.warnings.push('preserving remote standalone include boundary blocks');
  }
  const localEntries = planningEntries(input.localCurrent);
  const remoteEntries = planningEntries(input.remoteCurrent);
  const remoteByLocator = new Map(input.remoteCurrent.nodes.map((node) => [locatorKey(node.locator), node]));
  const remoteBaseByLocator = new Map((input.remoteBase?.nodes ?? []).map((node) => [locatorKey(node.locator), node]));

  const desiredEntries = localEntries.map((entry) => {
    if (entry.node.kind !== 'text') return entry;
    const key = locatorKey(entry.node.locator);
    const remote = remoteByLocator.get(key);
    if (!remote || remote.kind !== 'text') return entry;

    if (!input.tracked) {
      if (textRepresentationsEquivalent(entry.node.markdown, remote.markdown) && entry.node.markdown !== remote.markdown) {
        input.warnings.push(`adopting text representation difference at ${key}`);
        return textEntry({ ...entry.node, markdown: remote.markdown });
      }
      return entry;
    }

    if (!input.localChanged.has(key)) return textEntry({ ...entry.node, markdown: remote.markdown });
    const remoteBase = remoteBaseByLocator.get(key);
    if (remoteBase?.kind === 'text' && semanticNodeHash(remote) !== semanticNodeHash(remoteBase)) {
      if (semanticNodeHash(remote) === semanticNodeHash(entry.node)) {
        return textEntry({ ...entry.node, markdown: remote.markdown });
      }
      input.blockers.push({
        code: 'remote-scope-conflict',
        locator: entry.node.locator,
        message: `remote text changed in managed scope: ${key}`
      });
      return textEntry({ ...entry.node, markdown: remote.markdown });
    }
    const withIncludes = preserveAuthoringIncludeMarkup(entry.node.markdown, remote.markdown);
    return textEntry({
      ...entry.node,
      markdown: preserveRemoteFeishuLinkDestinations(withIncludes, remote.markdown)
    });
  });

  if (input.tracked && input.localBase && input.remoteBase) {
    return planTrackedTextScopes({
      parentBlockId: input.parentBlockId,
      localBase: planningEntries(input.localBase),
      localCurrent: localEntries,
      remoteBase: planningEntries(input.remoteBase),
      remoteCurrent: remoteEntries,
      desiredEntries,
      localChanged: input.localChanged,
      blockers: input.blockers
    });
  }

  const textPlan = planPublishBlockPatch({
    parentBlockId: input.parentBlockId,
    remoteBlocks: remoteEntries.map((entry) => entry.block),
    desiredBlocks: desiredEntries.map((entry) => entry.block)
  });
  if (!textPlan.safeToWrite) {
    if (textSequenceEquivalent(remoteEntries, desiredEntries)) return { operations: [] };
    return { operations: [], fallbackReason: textPlan.fallbackReason };
  }

  const operations = textPlan.operations.flatMap((operation): ScopedPatchOperation[] => {
    if (operation.kind === 'update') {
      const entry = desiredEntries[operation.path[0]];
      if (!entry || entry.node.kind !== 'text') return [];
      if (entry.node.blockType === 14) {
        input.blockers.push({
          code: 'unsupported-local-change',
          locator: entry.node.locator,
          message: 'code block updates are unsupported until language-preserving IO is available'
        });
        return [];
      }
      return [{
        kind: 'update',
        locator: entry.node.locator,
        remoteBlockId: operation.remoteBlockId,
        desiredMarkdown: entry.node.markdown
      }];
    }
    if (operation.kind === 'create') {
      const entry = desiredEntries[operation.index];
      if (!entry || entry.node.kind !== 'text') return [];
      if (entry.node.blockType === 14) {
        input.blockers.push({
          code: 'unsupported-local-change',
          locator: entry.node.locator,
          message: 'code block creation is unsupported until language-preserving IO is available'
        });
        return [];
      }
      return [{
        kind: 'create',
        locator: entry.node.locator,
        parentBlockId: operation.parentBlockId,
        insertAfterBlockId: operation.insertAfterBlockId,
        afterLocator: remoteEntries.find((candidate) => {
          return candidate.node.remoteBlockId === operation.insertAfterBlockId;
        })?.node.locator,
        desiredMarkdown: operation.blocks.map((block) => feishuBlocksToMarkdown([block]).trim()).join('\n\n')
      }];
    }
    const entry = remoteEntries[operation.startIndex];
    if (!entry || entry.node.kind !== 'text') return [];
    return [{
      kind: 'delete',
      locator: entry.node.locator,
      parentBlockId: operation.parentBlockId,
      blockIds: operation.blockIds
    }];
  });
  return { operations };
}

function planTrackedTextScopes(input: {
  parentBlockId: string;
  localBase: PlanningEntry[];
  localCurrent: PlanningEntry[];
  remoteBase: PlanningEntry[];
  remoteCurrent: PlanningEntry[];
  desiredEntries: PlanningEntry[];
  localChanged: Set<string>;
  blockers: ScopedPatchBlocker[];
}): { operations: ScopedPatchOperation[]; fallbackReason?: string } {
  const desiredCorrespondence = correspondenceKeys(input.localBase, input.localCurrent);
  const remoteCorrespondence = correspondenceKeys(input.remoteBase, input.remoteCurrent);
  if (desiredCorrespondence.ambiguous || remoteCorrespondence.ambiguous) {
    return { operations: [], fallbackReason: 'tracked correspondence is ambiguous for repeated blocks' };
  }
  const desiredKeys = desiredCorrespondence.keys;
  const remoteKeys = remoteCorrespondence.keys;
  const desiredByKey = keyedEntries(input.desiredEntries, desiredKeys);
  const remoteByKey = keyedEntries(input.remoteCurrent, remoteKeys);
  const sharedKeys = new Set([...desiredByKey.keys()].filter((key) => remoteByKey.has(key)));
  const usedRemoteIndexes = new Set([...sharedKeys].flatMap((key) => {
    const remote = remoteByKey.get(key);
    return remote ? [remote.index] : [];
  }));
  const satisfiedTextAdditions = new Set<number>();
  for (let index = 0; index < input.desiredEntries.length; index += 1) {
    const desired = input.desiredEntries[index]!;
    if (desiredKeys[index] || desired.node.kind !== 'text') continue;
    const desiredText = desired.node;
    const candidates = input.remoteCurrent.flatMap((remote, remoteIndex) => {
      if (usedRemoteIndexes.has(remoteIndex) || remote.node.kind !== 'text') return [];
      if (remote.node.blockType !== desiredText.blockType ||
        !sameSectionPath(remote.node.locator.sectionPath, desiredText.locator.sectionPath) ||
        !textRepresentationsEquivalent(remote.node.markdown, desiredText.markdown)) return [];
      return additionPlacementMatches({
        desiredIndex: index,
        remoteIndex,
        desiredKeys,
        remoteByKey
      }) ? [remoteIndex] : [];
    });
    if (candidates.length > 1) {
      return { operations: [], fallbackReason: `tracked text addition correspondence is ambiguous at ${locatorKey(desired.node.locator)}` };
    }
    const matchedIndex = candidates[0];
    if (matchedIndex !== undefined) {
      satisfiedTextAdditions.add(index);
      usedRemoteIndexes.add(matchedIndex);
      continue;
    }
    const conflicting = input.remoteCurrent.some((remote, remoteIndex) => {
      return !usedRemoteIndexes.has(remoteIndex) && remote.node.kind === 'text' &&
        locatorKey(remote.node.locator) === locatorKey(desired.node.locator);
    });
    if (conflicting) {
      return { operations: [], fallbackReason: `tracked text addition conflicts with remote block at ${locatorKey(desired.node.locator)}` };
    }
  }
  const desiredOrder = input.desiredEntries.flatMap((entry, index) => {
    const key = desiredKeys[index];
    return key && sharedKeys.has(key) && entry.node.kind !== 'code' ? [key] : [];
  });
  const remoteOrder = input.remoteCurrent.flatMap((entry, index) => {
    const key = remoteKeys[index];
    return key && sharedKeys.has(key) && entry.node.kind !== 'code' ? [key] : [];
  });
  if (desiredOrder.length !== remoteOrder.length ||
    desiredOrder.some((key, index) => key !== remoteOrder[index])) {
    return { operations: [], fallbackReason: 'tracked block order changed at <root>' };
  }

  const operations: ScopedPatchOperation[] = [];
  for (let index = 0; index < input.desiredEntries.length; index += 1) {
    const desired = input.desiredEntries[index]!;
    const key = desiredKeys[index];
    if (!key) continue;
    const remote = remoteByKey.get(key);
    if (!remote) {
      if (desired.node.kind === 'text' && input.localChanged.has(locatorKey(desired.node.locator))) {
        return {
          operations: [],
          fallbackReason: `tracked text correspondence is missing at ${key}`
        };
      }
      continue;
    }
    if (desired.node.kind !== 'text' || remote.entry.node.kind !== 'text') continue;
    if (desired.node.blockType !== remote.entry.node.blockType) {
      return { operations: [], fallbackReason: `tracked text block type changed at ${key}` };
    }
    if (textRepresentationsEquivalent(desired.node.markdown, remote.entry.node.markdown)) continue;
    if (!remote.entry.node.remoteBlockId) {
      return { operations: [], fallbackReason: `tracked text block ID missing at ${key}` };
    }
    operations.push({
      kind: 'update',
      locator: desired.node.locator,
      remoteBlockId: remote.entry.node.remoteBlockId,
      desiredMarkdown: desired.node.markdown
    });
  }

  for (let index = 0; index < input.desiredEntries.length; index += 1) {
    const desired = input.desiredEntries[index]!;
    if (desiredKeys[index] || desired.node.kind !== 'text') continue;
    if (satisfiedTextAdditions.has(index)) continue;
    const next = input.desiredEntries[index + 1];
    if (next?.node.kind === 'text' && !desiredKeys[index + 1]) {
      return { operations: [], fallbackReason: 'multiple adjacent tracked text creations are unsupported' };
    }
    let previousRemoteBlockId = input.parentBlockId;
    let afterLocator: SemanticLocator | undefined;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const previousKey = desiredKeys[previous];
      const remote = previousKey ? remoteByKey.get(previousKey) : undefined;
      if (!remote || remote.entry.node.kind === 'code') continue;
      if (!remote.entry.node.remoteBlockId) {
        return { operations: [], fallbackReason: `tracked create anchor is missing at ${previousKey}` };
      }
      previousRemoteBlockId = remote.entry.node.remoteBlockId;
      afterLocator = input.desiredEntries[previous]?.node.locator;
      break;
    }
    operations.push({
      kind: 'create',
      locator: desired.node.locator,
      parentBlockId: input.parentBlockId,
      insertAfterBlockId: previousRemoteBlockId,
      afterLocator,
      desiredMarkdown: desired.node.markdown
    });
  }

  const deletedLocalTextKeys = new Set(input.localBase.flatMap((entry) => {
    const key = locatorKey(entry.node.locator);
    return entry.node.kind === 'text' && !desiredByKey.has(key) ? [key] : [];
  }));
  const deletedText = input.remoteCurrent.flatMap((entry, index) => {
    const key = remoteKeys[index];
    return key && deletedLocalTextKeys.has(key) && entry.node.kind === 'text' ? [{ entry, key }] : [];
  });
  if (deletedText.length > 0) {
    const changedRemotely = deletedText.filter(({ entry, key }) => {
      const baseline = input.remoteBase.find((candidate) => {
        return locatorKey(candidate.node.locator) === key && candidate.node.kind === 'text';
      });
      return !baseline || semanticNodeHash(baseline.node) !== semanticNodeHash(entry.node);
    });
    if (changedRemotely.length > 0) {
      input.blockers.push(...changedRemotely.map(({ entry, key }) => ({
        code: 'remote-scope-conflict' as const,
        locator: entry.node.locator,
        message: `remote text changed before tracked deletion: ${key}`
      })));
      return { operations };
    }
    const blockIds = deletedText.flatMap(({ entry }) => entry.node.remoteBlockId ? [entry.node.remoteBlockId] : []);
    if (blockIds.length !== deletedText.length) {
      return { operations: [], fallbackReason: 'tracked text deletion block ID is missing' };
    }
    operations.push({
      kind: 'delete',
      locator: deletedText[0]!.entry.node.locator,
      parentBlockId: input.parentBlockId,
      blockIds
    });
  }
  return { operations };
}

function additionPlacementMatches(input: {
  desiredIndex: number;
  remoteIndex: number;
  desiredKeys: Array<string | undefined>;
  remoteByKey: Map<string, { entry: PlanningEntry; index: number }>;
}): boolean {
  let previousRemoteIndex = -1;
  for (let index = input.desiredIndex - 1; index >= 0; index -= 1) {
    const key = input.desiredKeys[index];
    const remote = key ? input.remoteByKey.get(key) : undefined;
    if (!remote) continue;
    previousRemoteIndex = remote.index;
    break;
  }
  let nextRemoteIndex = Number.POSITIVE_INFINITY;
  for (let index = input.desiredIndex + 1; index < input.desiredKeys.length; index += 1) {
    const key = input.desiredKeys[index];
    const remote = key ? input.remoteByKey.get(key) : undefined;
    if (!remote) continue;
    nextRemoteIndex = remote.index;
    break;
  }
  return input.remoteIndex > previousRemoteIndex && input.remoteIndex < nextRemoteIndex;
}

function sameSectionPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function correspondenceKeys(base: PlanningEntry[], current: PlanningEntry[]): {
  keys: Array<string | undefined>;
  ambiguous: boolean;
} {
  const keys: Array<string | undefined> = Array.from({ length: current.length });
  const reservedBase = new Set<number>();
  const baseByHash = groupedIndexes(base.map((entry) => correspondenceHash(entry.node)));
  const currentByHash = groupedIndexes(current.map((entry) => correspondenceHash(entry.node)));
  const ambiguous = base.length !== current.length && [...baseByHash].some(([hash, indexes]) => {
    return indexes.length > 1 && base[indexes[0]!]?.node.kind === 'text' &&
      (currentByHash.get(hash)?.length ?? 0) > 0;
  });
  for (const [hash, baseIndexes] of baseByHash) {
    const currentIndexes = currentByHash.get(hash) ?? [];
    if (baseIndexes.length !== 1 || currentIndexes.length !== 1) continue;
    const baseIndex = baseIndexes[0]!;
    const currentIndex = currentIndexes[0]!;
    keys[currentIndex] = locatorKey(base[baseIndex]!.node.locator);
    reservedBase.add(baseIndex);
  }
  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    if (keys[currentIndex]) continue;
    const currentEntry = current[currentIndex]!;
    const baseIndex = base.findIndex((entry, index) => {
      return !reservedBase.has(index) && entry.node.kind === currentEntry.node.kind &&
        locatorKey(entry.node.locator) === locatorKey(currentEntry.node.locator);
    });
    if (baseIndex === -1) continue;
    keys[currentIndex] = locatorKey(base[baseIndex]!.node.locator);
    reservedBase.add(baseIndex);
  }
  return { keys, ambiguous };
}

function correspondenceHash(node: SemanticNode): string {
  if (node.kind === 'text') {
    return semanticHash({
      kind: node.kind,
      blockType: node.blockType,
      markdown: canonicalizeAuthoringIncludeMarkup(node.markdown)
    });
  }
  const normalized = stripExecutionMetadata(node) as SemanticNode;
  const { locator: _locator, ...content } = normalized;
  return semanticHash(content);
}

function groupedIndexes(values: string[]): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  values.forEach((value, index) => grouped.set(value, [...(grouped.get(value) ?? []), index]));
  return grouped;
}

function keyedEntries(entries: PlanningEntry[], keys: Array<string | undefined>): Map<string, {
  entry: PlanningEntry;
  index: number;
}> {
  const keyed = new Map<string, { entry: PlanningEntry; index: number }>();
  entries.forEach((entry, index) => {
    const key = keys[index];
    if (key) keyed.set(key, { entry, index });
  });
  return keyed;
}

function textSequenceEquivalent(remoteEntries: PlanningEntry[], desiredEntries: PlanningEntry[]): boolean {
  const remoteText = remoteEntries.filter((entry): entry is PlanningEntry & { node: SemanticTextBlock } => {
    return entry.node.kind === 'text';
  });
  const desiredText = desiredEntries.filter((entry): entry is PlanningEntry & { node: SemanticTextBlock } => {
    return entry.node.kind === 'text';
  });
  return remoteText.length === desiredText.length && remoteText.every((entry, index) => {
    const desired = desiredText[index];
    return Boolean(desired &&
      entry.node.blockType === desired.node.blockType &&
      locatorKey(entry.node.locator) === locatorKey(desired.node.locator) &&
      textRepresentationsEquivalent(entry.node.markdown, desired.node.markdown));
  });
}

type PlanningEntry = { node: SemanticNode; block: FeishuBlock };

function planningEntries(document: SemanticDocument): PlanningEntry[] {
  return document.nodes.flatMap((node): PlanningEntry[] => {
    if (node.kind === 'opaque' || node.kind === 'asset' || node.kind === 'callout' ||
      node.kind === 'authoring-token' || node.kind === 'protected-resource') return [];
    if (node.kind === 'code') {
      return [{
        node,
        block: placeholderBlock('__FMS_CODE_BLOCK__', node.remoteBlockId)
      }];
    }
    if (node.kind === 'table') {
      return [{
        node,
        block: placeholderBlock(`__FMS_TABLE__:${tableIdentity(node)}`, node.remoteBlockId)
      }];
    }
    if (node.kind === 'text' && isStandaloneIncludeBoundary(node.markdown)) return [];
    return [textEntry(node)];
  });
}

function textEntry(node: SemanticTextBlock): PlanningEntry {
  const parsed = markdownToFeishuBlocks(node.markdown)[0] ?? placeholderBlock('', node.remoteBlockId);
  return {
    node,
    block: node.remoteBlockId ? { ...parsed, block_id: node.remoteBlockId } : parsed
  };
}

function placeholderBlock(content: string, blockId?: string): FeishuBlock {
  return {
    ...(blockId ? { block_id: blockId } : {}),
    block_type: 2,
    text: {
      elements: [{ text_run: { content, text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false
      } } }],
      style: { align: 1 }
    }
  };
}

function changedLocatorKeys(
  baseline: SemanticDocument | undefined,
  current: SemanticDocument,
  tracked: boolean
): Set<string> {
  if (!tracked || !baseline) return new Set(current.nodes.map((node) => locatorKey(node.locator)));
  const baselineByKey = new Map(baseline.nodes.map((node) => [locatorKey(node.locator), node]));
  const currentByKey = new Map(current.nodes.map((node) => [locatorKey(node.locator), node]));
  const keys = new Set([...baselineByKey.keys(), ...currentByKey.keys()]);
  return new Set([...keys].filter((key) => {
    const before = baselineByKey.get(key);
    const after = currentByKey.get(key);
    return !before || !after || semanticNodeHash(before) !== semanticNodeHash(after);
  }));
}

function findTableByLocator(
  document: SemanticDocument | undefined,
  locator: SemanticLocator
): SemanticTable | undefined {
  return document?.nodes.find((node): node is SemanticTable => {
    return node.kind === 'table' && locatorKey(node.locator) === locatorKey(locator);
  });
}

function mergeTrackedTableDelta(input: {
  localBase: SemanticTable;
  localCurrent: SemanticTable;
  remoteBase: SemanticTable;
  remoteCurrent: SemanticTable;
}): { table?: SemanticTable; blockers: string[] } {
  const localDelta = diffCorrespondingTable(input.localBase, input.localCurrent, {
    allowHeaderChanges: true,
    allowSingleRowRename: true
  });
  if (localDelta.blockers.length > 0) return { blockers: localDelta.blockers };
  const widths = [
    input.localBase.headers.length,
    input.localCurrent.headers.length,
    input.remoteBase.headers.length,
    input.remoteCurrent.headers.length
  ];
  if (new Set(widths).size !== 1) {
    return { blockers: ['tracked table column count differs across L0, L1, R0, or current remote'] };
  }

  const localBaseToCurrent = correspondRows(input.localBase.rows, input.localCurrent.rows, true);
  const localBaseToRemote = correspondRows(input.localBase.rows, input.remoteBase.rows);
  const remoteBaseToCurrent = correspondRows(input.remoteBase.rows, input.remoteCurrent.rows);
  const blockers: string[] = [];
  const rows = [...input.remoteCurrent.rows];

  for (const update of localDelta.updates) {
    const localCurrent = input.localCurrent.rows.find((row) => row.key === update.key);
    const localBase = localCurrent
      ? [...localBaseToCurrent].find(([, current]) => current === localCurrent)?.[0]
      : undefined;
    const remoteBase = localBase ? localBaseToRemote.get(localBase) : undefined;
    const remoteCurrent = remoteBase ? remoteBaseToCurrent.get(remoteBase) : undefined;
    if (!localCurrent || !localBase || !remoteBase || !remoteCurrent) {
      blockers.push(`tracked table row correspondence is missing for local update: ${update.key}`);
      continue;
    }
    if (localCurrent.cells.length !== remoteCurrent.cells.length) {
      blockers.push(`tracked table row width differs for local update: ${update.key}`);
      continue;
    }
    const index = rows.indexOf(remoteCurrent);
    if (index < 0) {
      blockers.push(`tracked remote table row is missing for local update: ${update.key}`);
      continue;
    }
    const cells = remoteCurrent.cells.map((cell, cellIndex) => {
      return update.changedCellIndexes.includes(cellIndex)
        ? localCurrent.cells[cellIndex] ?? cell
        : cell;
    });
    rows[index] = {
      key: update.changedCellIndexes.includes(0) ? localCurrent.key : remoteCurrent.key,
      cells
    };
  }

  for (const addition of localDelta.additions) {
    const row = input.localCurrent.rows[addition.index];
    if (!row) {
      blockers.push(`tracked table addition is missing at index ${addition.index}`);
      continue;
    }
    if (rows.some((candidate) => candidate.key === row.key)) {
      blockers.push(`tracked table addition conflicts with remote row key: ${row.key}`);
      continue;
    }
    let insertAt = 0;
    for (let previous = addition.index - 1; previous >= 0; previous -= 1) {
      const localPrevious = input.localCurrent.rows[previous];
      if (!localPrevious) continue;
      const existingIndex = rows.findIndex((candidate) => candidate.key === localPrevious.key);
      if (existingIndex >= 0) {
        insertAt = existingIndex + 1;
        break;
      }
      const localBase = [...localBaseToCurrent].find(([, current]) => current === localPrevious)?.[0];
      const remoteBase = localBase ? localBaseToRemote.get(localBase) : undefined;
      const remoteCurrent = remoteBase ? remoteBaseToCurrent.get(remoteBase) : undefined;
      const mappedIndex = remoteCurrent ? rows.indexOf(remoteCurrent) : -1;
      if (mappedIndex >= 0) {
        insertAt = mappedIndex + 1;
        break;
      }
    }
    rows.splice(insertAt, 0, row);
  }

  if (blockers.length > 0) return { blockers };
  const headers = input.localCurrent.headers.map((header, index) => {
    const base = input.localBase.headers[index]!;
    return tableHeaderCellsSemanticallyEquivalent(base, header)
      ? input.remoteCurrent.headers[index]!
      : header;
  });
  return {
    blockers: [],
    table: {
      ...input.remoteCurrent,
      locator: input.localCurrent.locator,
      headers,
      rows,
      unsupported: input.localCurrent.unsupported
    }
  };
}

function correspondRows(
  base: SemanticTable['rows'],
  current: SemanticTable['rows'],
  allowSingleRowRename = false
): Map<SemanticTable['rows'][number], SemanticTable['rows'][number]> {
  const result = new Map<SemanticTable['rows'][number], SemanticTable['rows'][number]>();
  const used = new Set<SemanticTable['rows'][number]>();
  for (const row of base) {
    const exact = current.find((candidate) => !used.has(candidate) && candidate.key === row.key);
    if (!exact) continue;
    result.set(row, exact);
    used.add(exact);
  }
  const unmatchedBase = base.filter((row) => !result.has(row));
  const unmatchedCurrent = current.filter((row) => !used.has(row));
  if (!allowSingleRowRename || unmatchedBase.length !== 1 || unmatchedCurrent.length !== 1) return result;
  const before = unmatchedBase[0]!;
  const after = unmatchedCurrent[0]!;
  const beforeIndex = base.indexOf(before);
  const afterIndex = current.indexOf(after);
  const stableNonKeyCell = after.cells.slice(1).some((cell, index) => {
    const baseCell = before.cells[index + 1];
    return baseCell ? tableCellsSemanticallyEquivalent(baseCell, cell) : false;
  });
  if (base.length === current.length && beforeIndex === afterIndex &&
    before.cells.length === after.cells.length && stableNonKeyCell) {
    result.set(before, after);
  }
  return result;
}

function semanticNodeHash(node: SemanticNode): string {
  if (node.kind === 'callout') return calloutContentHash(node);
  if (node.kind === 'code') {
    return semanticHash({
      content: node.content,
      resolvedLanguage: node.resolvedLanguage,
      issues: node.issues
    });
  }
  if (node.kind === 'text') {
    return semanticHash({
      blockType: node.blockType,
      markdown: canonicalizeAuthoringIncludeMarkup(node.markdown)
    });
  }
  return semanticHash(stripExecutionMetadata(node));
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

function visibleText(markdown: string): string {
  return normalizeWhitespace(markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
}

function textRepresentationsEquivalent(local: string, remote: string): boolean {
  const canonicalLocal = canonicalizeMarkdownSemantics(canonicalizeAuthoringIncludeMarkup(local));
  const canonicalRemote = canonicalizeMarkdownSemantics(canonicalizeAuthoringIncludeMarkup(remote));
  if (visibleText(canonicalLocal) === visibleText(canonicalRemote)) return true;
  const localCode = fencedCode(canonicalLocal);
  const remoteCode = fencedCode(canonicalRemote);
  if (!localCode || !remoteCode || localCode.body !== remoteCode.body) return false;
  return !localCode.language || !remoteCode.language || localCode.language === remoteCode.language;
}

function isStandaloneIncludeBoundary(markdown: string): boolean {
  const trimmed = markdown.trim();
  return /^<include\b[^>]*>$/i.test(trimmed) || /^<\/include>$/i.test(trimmed);
}

function fencedCode(markdown: string): { language: string; body: string } | undefined {
  const match = markdown.match(/^```([^\n`]*)\n([\s\S]*?)\n```$/);
  if (!match) return undefined;
  return {
    language: (match[1] ?? '').trim().toLocaleLowerCase('en-US'),
    body: match[2] ?? ''
  };
}

function isTable(node: SemanticNode): node is SemanticTable {
  return node.kind === 'table';
}

function locatorsForKeys(document: SemanticDocument, keys: Set<string>): SemanticLocator[] {
  return document.nodes.flatMap((node) => keys.has(locatorKey(node.locator)) ? [node.locator] : []);
}
