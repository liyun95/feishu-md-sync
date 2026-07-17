import type { FeishuBlock, TextElement } from '../feishu/types.js';
import {
  planCodeBlockChanges,
  type CodeBlockOperation,
  type CodePlanBlocker
} from '../code-blocks/code-plan.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { normalizeWhitespace, semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type {
  SemanticDocument,
  SemanticLocator,
  SemanticNode,
  SemanticTable,
  SemanticTextChild,
  SemanticTextBlock
} from '../semantic/types.js';
import { planPublishBlockPatch } from './block-patch-plan.js';
import {
  calloutContentHash,
  planCalloutChanges,
  type CalloutOperation,
  type CalloutPlanBlocker
} from './callout-plan.js';
import { diffCorrespondingTable, findCorrespondingRemoteTable, tableIdentity, type TableDiff } from './table-diff.js';
import { canonicalizeMarkdownSemantics } from '../semantic/markdown-equivalence.js';
import {
  planProceduresChanges,
  type ProceduresOperation,
  type ProceduresPlanBlocker
} from '../zdoc/procedures-plan.js';

export type ScopedTextUpdateOperation = {
  kind: 'update';
  locator: SemanticLocator;
  parentBlockId: string;
  remoteBlockId: string;
  desiredMarkdown: string;
  recoveryExpectedRemoteMarkdown?: string;
};

export type ScopedTextCreateOperation = {
  kind: 'create';
  locator: SemanticLocator;
  parentBlockId: string;
  insertAfterBlockId: string;
  desiredMarkdown: string;
  desiredBlocks: Array<{
    blockType: number;
    markdown: string;
  }>;
};

export type ScopedTextDeleteOperation = {
  kind: 'delete';
  locator: SemanticLocator;
  parentBlockId: string;
  blockIds: string[];
  recovery?: {
    precedingBlockId?: string;
    preCreatePrecedingBlockId?: string;
    precedingDesiredMarkdown?: string;
    followingBlockId?: string;
    expectedBlocks: Array<{
      blockId: string;
      blockType: number;
      markdown: string;
    }>;
    expectedDescendantBlockIds?: string[];
  };
};

export type TableReplaceOperation = {
  kind: 'table-replace';
  locator: SemanticLocator;
  remoteBlockId: string;
  desiredTable: SemanticTable;
  diff: TableDiff;
};

export type TableCreateOperation = {
  kind: 'table-create';
  locator: SemanticLocator;
  parentBlockId: string;
  insertAfterBlockId: string;
  insertBeforeBlockId?: string;
  desiredTable: SemanticTable;
};

export type RecordedRoundTripLoss = {
  side: 'local-only' | 'remote-only' | 'divergent';
  nodeKind: 'table' | 'text';
  locator: SemanticLocator;
  state: 'repairable' | 'blocked';
  action: 'create-native-table' | 'preserve-created-table' | 'delete-duplicate-text' | 'repair-text-hierarchy' | 'block';
  message: string;
  remoteBlockId?: string;
};

export type ScopedPatchOperation =
  | ScopedTextUpdateOperation
  | ScopedTextCreateOperation
  | ScopedTextDeleteOperation
  | TableCreateOperation
  | TableReplaceOperation
  | CalloutOperation
  | CodeBlockOperation
  | ProceduresOperation;

export type ScopedPatchBlocker = {
  code:
    | 'correspondence-ambiguous'
    | 'unsupported-local-change'
    | 'remote-scope-conflict'
    | 'round-trip-loss-drift'
    | 'round-trip-loss-ambiguous'
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
  roundTripLosses: RecordedRoundTripLoss[];
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
  const recordedLosses = analyzeRecordedRoundTripLosses(input);
  blockers.push(...recordedLosses.blockers);

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

  const textPlanning = planTextScopes({
    ...input,
    localChanged,
    remoteChanged,
    blockers,
    warnings,
    roundTripLosses: recordedLosses.losses
  });
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

    const match = findCorrespondingRemoteTable(sourceTable, input.remoteCurrent);
    if (!match.table) {
      blockers.push({
        code: 'correspondence-ambiguous',
        locator: sourceTable.locator,
        message: match.blocker ?? `table correspondence missing: ${tableIdentity(sourceTable)}`
      });
      continue;
    }

    const desiredEqualsRemote = semanticNodeHash(sourceTable) === semanticNodeHash(match.table);
    if (desiredEqualsRemote) continue;

    if (input.tracked) {
      const baselineRemote = findTableByIdentity(input.remoteBase, sourceTable);
      if (!baselineRemote) {
        blockers.push({
          code: 'correspondence-ambiguous',
          locator: sourceTable.locator,
          message: `remote table baseline missing: ${tableIdentity(sourceTable)}`
        });
        continue;
      }
      const changedRemotely = semanticNodeHash(baselineRemote) !== semanticNodeHash(match.table);
      if (changedRemotely) {
        blockers.push({
          code: 'remote-scope-conflict',
          locator: sourceTable.locator,
          message: `remote table changed in managed scope: ${tableIdentity(sourceTable)}`
        });
        continue;
      }
    }

    const diff = diffCorrespondingTable(match.table, sourceTable);
    if (diff.blockers.length > 0) {
      blockers.push(...diff.blockers.map((message) => ({
        code: 'unsupported-local-change' as const,
        locator: sourceTable.locator,
        message
      })));
      continue;
    }
    if (diff.additions.length === 0 && diff.updates.length === 0) continue;
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
      desiredTable: sourceTable,
      diff
    });
  }

  const localChangedKeys = new Set(localChanged);
  if ([...remoteChanged].some((key) => !localChangedKeys.has(key))) {
    warnings.push('remote changed outside managed scopes');
  }

  const uniqueWarnings = [...new Set(warnings)];
  const recordedLocalRepairs = recordedLosses.losses.flatMap((loss) => {
    return loss.state === 'repairable' && loss.side === 'local-only' ? [loss.locator] : [];
  });
  return {
    kind: 'scoped-patch-plan',
    safeToWrite: blockers.length === 0,
    operations,
    blockers,
    warnings: uniqueWarnings,
    roundTripLosses: recordedLosses.losses,
    requiresCollaborationRiskConfirmation: calloutPlanning.requiresCollaborationRiskConfirmation ||
      codePlanning.requiresCollaborationRiskConfirmation || operations.some((operation) => {
      return operation.kind === 'update' || operation.kind === 'delete' || operation.kind === 'table-replace' ||
        operation.kind === 'authoring-token-move' || operation.kind === 'authoring-token-delete';
    }),
    scopeSummary: {
      localChanged: uniqueLocators([
        ...locatorsForKeys(input.localCurrent, localChanged),
        ...recordedLocalRepairs
      ]),
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

function uniqueLocators(locators: SemanticLocator[]): SemanticLocator[] {
  return [...new Map(locators.map((locator) => [locatorKey(locator), locator])).values()];
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
  roundTripLosses: RecordedRoundTripLoss[];
}): { operations: ScopedPatchOperation[]; fallbackReason?: string } {
  const localEntries = planningEntries(input.localCurrent);
  const completedCreateRecoveries = findCompletedCreateRecoveries(input);
  const flattenedTreeRecoveries = findFlattenedTreeRecoveries(input);
  const malformedTreeRecoveries = findMalformedTreeRecoveries(input);
  const treeRecoveries = [...flattenedTreeRecoveries, ...malformedTreeRecoveries];
  const recoverySuffixBlockIds = new Set([
    ...completedCreateRecoveries.flatMap((recovery) => {
    return recovery.expectedSuffix.map((block) => block.blockId);
    }),
    ...treeRecoveries.flatMap((recovery) => {
      return recovery.expectedBlocks.map((block) => block.blockId);
    })
  ]);
  const recoveryPrefixByLocator = new Map(completedCreateRecoveries.flatMap((recovery) => {
    return recovery.prefix.map((entry) => [locatorKey(entry.desired.locator), entry] as const);
  }));
  const flattenedRecoveryKeys = new Set(treeRecoveries.flatMap((recovery) => {
    return recovery.desiredLocators.map(locatorKey);
  }));
  const repairableDuplicateKeys = new Set(input.roundTripLosses.flatMap((loss) => {
    return loss.state === 'repairable' && loss.side === 'remote-only' && loss.nodeKind === 'text'
      ? [locatorKey(loss.locator)]
      : [];
  }));
  const repairableHierarchyKeys = new Set(input.roundTripLosses.flatMap((loss) => {
    return loss.state === 'repairable' && loss.action === 'repair-text-hierarchy'
      ? [locatorKey(loss.locator)]
      : [];
  }));
  const remoteEntries = planningEntries(input.remoteCurrent).filter((entry) => {
    return !repairableDuplicateKeys.has(locatorKey(entry.node.locator)) &&
      (!entry.node.remoteBlockId || !recoverySuffixBlockIds.has(entry.node.remoteBlockId));
  });
  const remoteByLocator = new Map(input.remoteCurrent.nodes.map((node) => [locatorKey(node.locator), node]));
  const remoteBaseByLocator = new Map((input.remoteBase?.nodes ?? []).map((node) => [locatorKey(node.locator), node]));

  const desiredEntries = localEntries.map((entry) => {
    if (entry.node.kind !== 'text') return entry;
    const key = locatorKey(entry.node.locator);
    const remote = remoteByLocator.get(key);
    if (!remote || remote.kind !== 'text') return entry;

    const recovery = recoveryPrefixByLocator.get(key);
    if (recovery) {
      return recovery.match === 'link-repair'
        ? entry
        : textEntry({ ...entry.node, markdown: remote.markdown });
    }

    if (flattenedRecoveryKeys.has(key)) return entry;

    if (!input.tracked) {
      if (textRepresentationsEquivalent(entry.node.markdown, remote.markdown) && entry.node.markdown !== remote.markdown) {
        input.warnings.push(`adopting text representation difference at ${key}`);
        return textEntry({ ...entry.node, markdown: remote.markdown });
      }
      return entry;
    }

    if (!input.localChanged.has(key) && !repairableHierarchyKeys.has(key)) {
      return textEntry({ ...entry.node, markdown: remote.markdown });
    }
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
    return entry;
  });

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
      const desiredPath = operation.desiredPath ?? operation.path;
      const entry = desiredEntries[desiredPath[0]];
      if (!entry || entry.node.kind !== 'text') return [];
      const nestedPath = desiredPath.slice(1);
      const desiredBlock = blockAtPath(entry.block, nestedPath);
      if (!desiredBlock) {
        input.blockers.push({
          code: 'correspondence-ambiguous',
          locator: entry.node.locator,
          message: `nested text update path is missing: ${desiredPath.join('.')}`
        });
        return [];
      }
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
        locator: textLocatorAtPath(entry.node.locator, nestedPath),
        parentBlockId: operation.parentBlockId,
        remoteBlockId: operation.remoteBlockId,
        desiredMarkdown: nestedPath.length === 0
          ? entry.node.markdown
          : feishuBlocksToMarkdown([desiredBlock]).trim(),
        ...(recoveryPrefixByLocator.get(locatorKey(entry.node.locator))?.match === 'link-repair'
          ? { recoveryExpectedRemoteMarkdown: recoveryPrefixByLocator.get(locatorKey(entry.node.locator))?.remote.markdown }
          : {})
      }];
    }
    if (operation.kind === 'create') {
      if (operation.path.length > 1) {
        const entry = desiredEntries[operation.path[0]];
        if (!entry || entry.node.kind !== 'text') {
          input.blockers.push({
            code: 'correspondence-ambiguous',
            message: `nested text create root is missing: ${operation.path.join('.')}`
          });
          return [];
        }
        return [{
          kind: 'create',
          locator: textLocatorAtPath(entry.node.locator, operation.path.slice(1)),
          parentBlockId: operation.parentBlockId,
          insertAfterBlockId: operation.insertAfterBlockId,
          desiredMarkdown: feishuBlocksToMarkdown(operation.blocks).trim(),
          desiredBlocks: operation.blocks.map(scopedTextBlockShape)
        }];
      }
      const entries = desiredEntries.slice(operation.index, operation.index + operation.blocks.length);
      const tableEntry = entries[0];
      if (entries.length === 1 && tableEntry?.node.kind === 'table') {
        const table = tableEntry.node;
        const repairable = input.roundTripLosses.some((loss) => {
          return loss.state === 'repairable' && loss.side === 'local-only' && loss.nodeKind === 'table' &&
            loss.action === 'create-native-table' &&
            locatorKey(loss.locator) === locatorKey(table.locator);
        });
        if (!repairable) {
          input.blockers.push({
            code: 'unsupported-local-change',
            locator: table.locator,
            message: 'table creation is supported only for a verified receipt-recorded round-trip loss'
          });
          return [];
        }
        if (table.unsupported.length > 0) {
          input.blockers.push({
            code: 'unsupported-local-change',
            locator: table.locator,
            message: `source table has unsupported content: ${table.unsupported.join('; ')}`
          });
          return [];
        }
        return [{
          kind: 'table-create',
          locator: table.locator,
          parentBlockId: operation.parentBlockId,
          insertAfterBlockId: operation.insertAfterBlockId,
          ...tableCreateFollowingAnchor(
            remoteEntries,
            operation.insertAfterBlockId,
            input.parentBlockId,
            input.blockers,
            table.locator
          ),
          desiredTable: table
        }];
      }
      if (entries.length !== operation.blocks.length || entries.some((candidate) => candidate.node.kind !== 'text')) {
        input.blockers.push({
          code: 'unsupported-local-change',
          message: 'mixed text replacement crosses a non-text managed scope'
        });
        return [];
      }
      const textEntries = entries as Array<PlanningEntry & { node: SemanticTextBlock }>;
      const entry = textEntries[0];
      if (!entry) return [];
      if (textEntries.some((candidate) => candidate.node.blockType === 14)) {
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
        desiredMarkdown: textEntries.map((candidate) => candidate.node.markdown).join('\n\n'),
        desiredBlocks: textEntries.map((candidate) => ({
          blockType: candidate.node.blockType,
          markdown: candidate.node.markdown
        }))
      }];
    }
    if (operation.path.length > 1) {
      const entry = remoteEntries[operation.path[0]];
      if (!entry || entry.node.kind !== 'text') {
        input.blockers.push({
          code: 'correspondence-ambiguous',
          message: `nested text delete root is missing: ${operation.path.join('.')}`
        });
        return [];
      }
      return [{
        kind: 'delete',
        locator: textLocatorAtPath(entry.node.locator, operation.path.slice(1)),
        parentBlockId: operation.parentBlockId,
        blockIds: operation.blockIds
      }];
    }
    const entries = remoteEntries.slice(operation.startIndex, operation.endIndex);
    const entry = entries[0];
    if (!entry || entries.length !== operation.blockIds.length || entries.some((candidate) => candidate.node.kind !== 'text')) {
      input.blockers.push({
        code: 'unsupported-local-change',
        message: 'mixed text deletion crosses a non-text managed scope'
      });
      return [];
    }
    return [{
      kind: 'delete',
      locator: entry.node.locator,
      parentBlockId: operation.parentBlockId,
      blockIds: operation.blockIds
    }];
  });
  const duplicateDeletes = input.roundTripLosses.flatMap((loss): ScopedPatchOperation[] => {
    if (loss.state !== 'repairable' || loss.side !== 'remote-only' || loss.nodeKind !== 'text') return [];
    if (!loss.remoteBlockId) {
      input.blockers.push({
        code: 'round-trip-loss-drift',
        locator: loss.locator,
        message: `recorded remote-only duplicate has no current block ID: ${locatorKey(loss.locator)}`
      });
      return [];
    }
    return [{
      kind: 'delete',
      locator: loss.locator,
      parentBlockId: input.parentBlockId,
      blockIds: [loss.remoteBlockId]
    }];
  });
  const recoveryDeletes = completedCreateRecoveries.map((recovery): ScopedPatchOperation => ({
    kind: 'delete',
    locator: recovery.deleteLocator,
    parentBlockId: input.parentBlockId,
    blockIds: recovery.expectedSuffix.map((block) => block.blockId),
    recovery: {
      precedingBlockId: recovery.precedingBlockId,
      ...(recovery.followingBlockId ? { followingBlockId: recovery.followingBlockId } : {}),
      expectedBlocks: recovery.expectedSuffix
    }
  }));
  const flattenedRecoveryDeletes = flattenedTreeRecoveries.map((recovery): ScopedPatchOperation => ({
    kind: 'delete',
    locator: recovery.deleteLocator,
    parentBlockId: input.parentBlockId,
    blockIds: recovery.expectedBlocks.map((block) => block.blockId),
    recovery: {
      preCreatePrecedingBlockId: recovery.preCreatePrecedingBlockId,
      precedingDesiredMarkdown: recovery.precedingDesiredMarkdown,
      ...(recovery.followingBlockId ? { followingBlockId: recovery.followingBlockId } : {}),
      expectedBlocks: recovery.expectedBlocks
    }
  }));
  const malformedRecoveryDeletes = malformedTreeRecoveries.map((recovery): ScopedPatchOperation => ({
    kind: 'delete',
    locator: recovery.deleteLocator,
    parentBlockId: input.parentBlockId,
    blockIds: recovery.expectedBlocks.map((block) => block.blockId),
    recovery: {
      preCreatePrecedingBlockId: recovery.preCreatePrecedingBlockId,
      precedingDesiredMarkdown: recovery.precedingDesiredMarkdown,
      ...(recovery.followingBlockId ? { followingBlockId: recovery.followingBlockId } : {}),
      expectedBlocks: recovery.expectedBlocks,
      expectedDescendantBlockIds: recovery.expectedDescendantBlockIds
    }
  }));
  if (completedCreateRecoveries.length > 0 || treeRecoveries.length > 0) {
    input.warnings.push(...completedCreateRecoveries.map((recovery) => {
      return `recovering exact completed scoped create at ${JSON.stringify(recovery.sectionPath)}`;
    }), ...flattenedTreeRecoveries.map((recovery) => {
      return `recovering exact flattened scoped create at ${JSON.stringify(recovery.sectionPath)}`;
    }), ...malformedTreeRecoveries.map((recovery) => {
      return `recovering exact malformed scoped create at ${JSON.stringify(recovery.sectionPath)}`;
    }));
  }
  return { operations: [
    ...operations,
    ...recoveryDeletes,
    ...flattenedRecoveryDeletes,
    ...malformedRecoveryDeletes,
    ...duplicateDeletes
  ] };
}

type CompletedCreateRecovery = {
  sectionPath: string[];
  prefix: Array<{
    desired: SemanticTextBlock;
    remote: SemanticTextBlock;
    match: 'exact' | 'representation' | 'link-repair';
  }>;
  expectedSuffix: Array<{
    blockId: string;
    blockType: number;
    markdown: string;
  }>;
  precedingBlockId: string;
  followingBlockId?: string;
  deleteLocator: SemanticLocator;
};

type FlattenedTreeRecovery = {
  sectionPath: string[];
  desiredLocators: SemanticLocator[];
  expectedBlocks: Array<{
    blockId: string;
    blockType: number;
    markdown: string;
  }>;
  precedingDesiredMarkdown: string;
  preCreatePrecedingBlockId: string;
  followingBlockId?: string;
  deleteLocator: SemanticLocator;
};

type MalformedTreeRecovery = FlattenedTreeRecovery & {
  expectedDescendantBlockIds: string[];
};

function findFlattenedTreeRecoveries(input: {
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): FlattenedTreeRecovery[] {
  if (!input.tracked || !input.localBase || !input.remoteBase) return [];
  const sections = new Map<string, string[]>();
  for (const node of input.localCurrent.nodes) {
    if (node.kind === 'text' && node.children?.length) {
      sections.set(JSON.stringify(node.locator.sectionPath), node.locator.sectionPath);
    }
  }
  const recoveries: FlattenedTreeRecovery[] = [];
  for (const sectionPath of sections.values()) {
    if (!sectionContainsOnlyText(input.localBase, sectionPath) ||
      !sectionContainsOnlyText(input.localCurrent, sectionPath) ||
      !sectionContainsOnlyText(input.remoteBase, sectionPath) ||
      !sectionContainsOnlyText(input.remoteCurrent, sectionPath)) continue;
    const localBase = textNodesInSection(input.localBase, sectionPath);
    const desired = textNodesInSection(input.localCurrent, sectionPath);
    const remoteBase = textNodesInSection(input.remoteBase, sectionPath);
    const remoteCurrent = textNodesInSection(input.remoteCurrent, sectionPath);
    const prefixLength = commonStableTextPrefixLength({ localBase, desired, remoteBase, remoteCurrent });
    if (prefixLength < 1 || prefixLength >= desired.length || prefixLength >= localBase.length) continue;
    const desiredTrees = desired.slice(prefixLength);
    if (!desiredTrees.some((node) => node.children?.length)) continue;
    const flattenedDesired = desiredTrees.flatMap((node) => {
      const block = markdownToFeishuBlocks(node.markdown)[0];
      return block ? flattenTextBlockShapes(block) : [];
    });
    if (flattenedDesired.length <= desiredTrees.length) continue;
    const completedTrees = remoteCurrent.slice(prefixLength, prefixLength + desiredTrees.length);
    const completedNestedCreate = completedTrees.length === desiredTrees.length && completedTrees.every((node, index) => {
      const desiredNode = desiredTrees[index];
      return Boolean(desiredNode && node.remoteBlockId && textNodeExactEquivalent(node, desiredNode));
    });
    const flattenedStart = prefixLength + (completedNestedCreate ? desiredTrees.length : 0);
    const created = remoteCurrent.slice(flattenedStart, flattenedStart + flattenedDesired.length);
    if (created.length !== flattenedDesired.length || created.some((node, index) => {
      const shape = flattenedDesired[index];
      return !shape || !node.remoteBlockId || node.children?.length || !completedCreateTextMatch(shape, node);
    })) continue;
    const baselineSuffix = remoteBase.slice(prefixLength);
    const suffix = remoteCurrent.slice(flattenedStart + flattenedDesired.length);
    if (suffix.length !== baselineSuffix.length || suffix.some((node, index) => {
      const baseline = baselineSuffix[index];
      return !baseline || !node.remoteBlockId || !textNodeExactEquivalent(node, baseline);
    })) continue;
    const expected = [...created, ...suffix];
    const deleteLocator = expected[0]?.locator;
    const precedingDesiredMarkdown = desiredTrees.at(-1)?.markdown;
    const preCreatePrecedingBlockId = completedNestedCreate
      ? completedTrees.at(-1)?.remoteBlockId
      : remoteCurrent[prefixLength - 1]?.remoteBlockId;
    if (!deleteLocator || !precedingDesiredMarkdown || !preCreatePrecedingBlockId) continue;
    const lastExpected = expected.at(-1);
    const lastIndex = lastExpected
      ? input.remoteCurrent.nodes.findIndex((node) => node === lastExpected)
      : -1;
    const following = lastIndex >= 0 ? input.remoteCurrent.nodes[lastIndex + 1] : undefined;
    if (following && !following.remoteBlockId) continue;
    recoveries.push({
      sectionPath,
      desiredLocators: desiredTrees.map((node) => node.locator),
      expectedBlocks: expected.map((node) => ({
        blockId: node.remoteBlockId!,
        blockType: node.blockType,
        markdown: node.markdown
      })),
      precedingDesiredMarkdown,
      preCreatePrecedingBlockId,
      ...(following?.remoteBlockId ? { followingBlockId: following.remoteBlockId } : {}),
      deleteLocator
    });
  }
  return recoveries;
}

function findMalformedTreeRecoveries(input: {
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): MalformedTreeRecovery[] {
  if (!input.tracked || !input.localBase || !input.remoteBase) return [];
  const sections = new Map<string, string[]>();
  for (const node of input.localCurrent.nodes) {
    if (node.kind === 'text' && node.children?.length) {
      sections.set(JSON.stringify(node.locator.sectionPath), node.locator.sectionPath);
    }
  }
  const recoveries: MalformedTreeRecovery[] = [];
  for (const sectionPath of sections.values()) {
    if (!sectionContainsOnlyText(input.localBase, sectionPath) ||
      !sectionContainsOnlyText(input.localCurrent, sectionPath) ||
      !sectionContainsOnlyText(input.remoteBase, sectionPath) ||
      !sectionContainsOnlyText(input.remoteCurrent, sectionPath)) continue;
    const localBase = textNodesInSection(input.localBase, sectionPath);
    const desired = textNodesInSection(input.localCurrent, sectionPath);
    const remoteBase = textNodesInSection(input.remoteBase, sectionPath);
    const remoteCurrent = textNodesInSection(input.remoteCurrent, sectionPath);
    const prefixLength = commonStableTextPrefixLength({ localBase, desired, remoteBase, remoteCurrent });
    if (prefixLength < 1 || prefixLength >= desired.length || prefixLength >= localBase.length) continue;
    const baselineTrees = localBase.slice(prefixLength);
    const desiredTrees = desired.slice(prefixLength);
    if (baselineTrees.length !== desiredTrees.length || desiredTrees.length === 0 ||
      desiredTrees.some((node, index) => {
        const baseline = baselineTrees[index];
        return !baseline || !node.children?.length || semanticNodeHash(node) !== semanticNodeHash(baseline);
      })) continue;
    const malformedShapes = desiredTrees.map((node) => {
      const parsed = markdownToFeishuBlocks(node.markdown);
      return parsed.length === 1 ? observedMalformedMarkdownTree(parsed[0]!) : undefined;
    });
    if (malformedShapes.some((shape) => !shape)) continue;
    const flattenedBaseline = baselineTrees.flatMap((node) => {
      const parsed = markdownToFeishuBlocks(node.markdown);
      return parsed.length === 1 ? flattenTextBlockShapes(parsed[0]!) : [];
    });
    const remoteBaselineSuffix = remoteBase.slice(prefixLength);
    if (flattenedBaseline.length !== remoteBaselineSuffix.length || flattenedBaseline.some((shape, index) => {
      const baseline = remoteBaselineSuffix[index];
      return !baseline || baseline.children?.length || baseline.blockType !== shape.blockType ||
        canonicalizeMarkdownSemantics(baseline.markdown) !== canonicalizeMarkdownSemantics(shape.markdown);
    })) continue;
    const completedTrees = remoteCurrent.slice(prefixLength, prefixLength + desiredTrees.length);
    const completedNestedCreate = completedTrees.length === desiredTrees.length && completedTrees.every((node, index) => {
      const desiredNode = desiredTrees[index];
      return Boolean(desiredNode && node.remoteBlockId && textNodeExactEquivalent(node, desiredNode));
    });
    const partialStagedCreate = completedNestedCreate
      ? undefined
      : matchPartialStagedTextTrees(completedTrees, desiredTrees);
    const partialStagedRoots = partialStagedCreate ? completedTrees : [];
    const malformedStart = prefixLength + (completedNestedCreate || partialStagedCreate ? desiredTrees.length : 0);
    const malformedRootGroups: SemanticTextBlock[][] = [];
    const descendantBlockIds: string[] = [...(partialStagedCreate?.descendantBlockIds ?? [])];
    let malformedCursor = malformedStart;
    let malformedDrift = false;
    while (remoteCurrent.length - malformedCursor > remoteBaselineSuffix.length) {
      const group = remoteCurrent.slice(malformedCursor, malformedCursor + desiredTrees.length);
      if (group.length !== desiredTrees.length || group.some((node, index) => {
        const shape = malformedShapes[index];
        if (!shape || !node.remoteBlockId) return true;
        const descendants = matchMalformedTextTree(node, shape);
        if (!descendants) return true;
        descendantBlockIds.push(...descendants);
        return false;
      })) {
        malformedDrift = true;
        break;
      }
      malformedRootGroups.push(group);
      malformedCursor += group.length;
    }
    if (malformedDrift || (!partialStagedCreate && malformedRootGroups.length === 0)) continue;
    const malformedRoots = malformedRootGroups.flat();
    const suffix = remoteCurrent.slice(malformedCursor);
    if (suffix.length !== remoteBaselineSuffix.length || suffix.some((node, index) => {
      const baseline = remoteBaselineSuffix[index];
      return !baseline || !node.remoteBlockId || node.children?.length || !textNodeExactEquivalent(node, baseline);
    })) continue;
    const expected = [...partialStagedRoots, ...malformedRoots, ...suffix];
    const expectedRootIds = expected.flatMap((node) => node.remoteBlockId ? [node.remoteBlockId] : []);
    if (expectedRootIds.length !== expected.length ||
      new Set([...expectedRootIds, ...descendantBlockIds]).size !== expectedRootIds.length + descendantBlockIds.length) {
      continue;
    }
    const preCreatePrecedingBlockId = completedNestedCreate
      ? completedTrees.at(-1)?.remoteBlockId
      : remoteCurrent[prefixLength - 1]?.remoteBlockId;
    const precedingDesiredMarkdown = desiredTrees.at(-1)?.markdown;
    const deleteLocator = expected[0]?.locator;
    if (!preCreatePrecedingBlockId || !precedingDesiredMarkdown || !deleteLocator) continue;
    const lastExpected = expected.at(-1);
    const lastIndex = lastExpected
      ? input.remoteCurrent.nodes.findIndex((node) => node === lastExpected)
      : -1;
    const following = lastIndex >= 0 ? input.remoteCurrent.nodes[lastIndex + 1] : undefined;
    if (following && !following.remoteBlockId) continue;
    recoveries.push({
      sectionPath,
      desiredLocators: desiredTrees.map((node) => node.locator),
      expectedBlocks: expected.map((node) => ({
        blockId: node.remoteBlockId!,
        blockType: node.blockType,
        markdown: node.markdown
      })),
      expectedDescendantBlockIds: descendantBlockIds,
      precedingDesiredMarkdown,
      preCreatePrecedingBlockId,
      ...(following?.remoteBlockId ? { followingBlockId: following.remoteBlockId } : {}),
      deleteLocator
    });
  }
  return recoveries;
}

function observedMalformedMarkdownTree(block: FeishuBlock): FeishuBlock | undefined {
  if (block.block_type !== 12 && block.block_type !== 13) return undefined;
  const key = block.block_type === 12 ? 'bullet' : 'ordered';
  const shell = asTextContainer(block[key]);
  if (!shell) return undefined;
  const children = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const elements = [...shell.elements];
  const preservedChildren: FeishuBlock[] = [];
  let encounteredNestedList = false;
  let changed = false;
  for (const child of children) {
    if (child.block_type === 2) {
      changed = true;
      if (!encounteredNestedList) {
        const paragraph = asTextContainer(child.text);
        if (!paragraph) return undefined;
        elements.push(...paragraph.elements);
      }
      continue;
    }
    if (child.block_type === 12 || child.block_type === 13) {
      encounteredNestedList = true;
      preservedChildren.push(child);
      continue;
    }
    return undefined;
  }
  if (!changed) return undefined;
  return {
    ...block,
    [key]: { ...shell.record, elements },
    ...(preservedChildren.length > 0 ? { children: preservedChildren } : { children: undefined })
  };
}

function matchMalformedTextTree(remote: SemanticTextBlock, expected: FeishuBlock): string[] | undefined {
  if (remote.blockType !== expected.block_type ||
    canonicalizeMarkdownSemantics(remote.markdown) !==
      canonicalizeMarkdownSemantics(feishuBlocksToMarkdown([expected]).trim())) return undefined;
  const descendants: string[] = [];
  return matchSemanticTextChildren(remote.children ?? [], childFeishuBlocks(expected), descendants)
    ? descendants
    : undefined;
}

function matchPartialStagedTextTrees(
  remoteTrees: SemanticTextBlock[],
  desiredTrees: SemanticTextBlock[]
): { descendantBlockIds: string[] } | undefined {
  if (remoteTrees.length !== desiredTrees.length || remoteTrees.length === 0) return undefined;
  const descendantBlockIds: string[] = [];
  let incompleteSeen = false;
  let hasIncomplete = false;
  for (const [index, remote] of remoteTrees.entries()) {
    const desired = desiredTrees[index];
    const desiredBlock = desired ? markdownToFeishuBlocks(desired.markdown)[0] : undefined;
    if (!desiredBlock || !remote.remoteBlockId || remote.blockType !== desiredBlock.block_type ||
      textRootMarkdown(remote.markdown) !== textBlockRootMarkdown(desiredBlock)) return undefined;
    const expectedChildren = childFeishuBlocks(desiredBlock);
    const remoteChildren = remote.children ?? [];
    if (expectedChildren.length === 0) {
      if (remoteChildren.length > 0 || incompleteSeen) return undefined;
      continue;
    }
    if (remoteChildren.length === 0) {
      incompleteSeen = true;
      hasIncomplete = true;
      continue;
    }
    if (incompleteSeen || !matchSemanticTextChildren(remoteChildren, expectedChildren, descendantBlockIds)) {
      return undefined;
    }
  }
  return hasIncomplete ? { descendantBlockIds } : undefined;
}

function textRootMarkdown(markdown: string): string {
  const block = markdownToFeishuBlocks(markdown)[0];
  return block ? textBlockRootMarkdown(block) : canonicalizeMarkdownSemantics(markdown);
}

function textBlockRootMarkdown(block: FeishuBlock): string {
  const { children: _children, ...shell } = block;
  return canonicalizeMarkdownSemantics(feishuBlocksToMarkdown([shell]).trim());
}

function matchSemanticTextChildren(
  remote: SemanticTextChild[],
  expected: FeishuBlock[],
  descendantBlockIds: string[]
): boolean {
  if (remote.length !== expected.length) return false;
  return remote.every((child, index) => {
    const expectedChild = expected[index];
    if (!expectedChild || !child.remoteBlockId || child.blockType !== expectedChild.block_type ||
      canonicalizeMarkdownSemantics(child.markdown) !==
        canonicalizeMarkdownSemantics(feishuBlocksToMarkdown([expectedChild]).trim())) return false;
    descendantBlockIds.push(child.remoteBlockId);
    return matchSemanticTextChildren(
      child.children ?? [],
      childFeishuBlocks(expectedChild),
      descendantBlockIds
    );
  });
}

function childFeishuBlocks(block: FeishuBlock): FeishuBlock[] {
  return Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
}

function asTextContainer(value: unknown): { record: Record<string, unknown>; elements: TextElement[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const elements = Array.isArray(record.elements)
    ? record.elements.filter((element): element is TextElement => {
        return Boolean(element && typeof element === 'object' && !Array.isArray(element));
      })
    : [];
  return { record, elements };
}

function findCompletedCreateRecoveries(input: {
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): CompletedCreateRecovery[] {
  if (!input.tracked || !input.localBase || !input.remoteBase) return [];
  const sections = new Map<string, string[]>();
  for (const node of input.localCurrent.nodes) {
    if (node.kind !== 'text') continue;
    sections.set(JSON.stringify(node.locator.sectionPath), node.locator.sectionPath);
  }
  const recoveries: CompletedCreateRecovery[] = [];
  for (const sectionPath of sections.values()) {
    if (!sectionContainsOnlyText(input.localBase, sectionPath) ||
      !sectionContainsOnlyText(input.localCurrent, sectionPath) ||
      !sectionContainsOnlyText(input.remoteBase, sectionPath) ||
      !sectionContainsOnlyText(input.remoteCurrent, sectionPath)) continue;
    const localBase = textNodesInSection(input.localBase, sectionPath);
    const desired = textNodesInSection(input.localCurrent, sectionPath);
    const remoteBase = textNodesInSection(input.remoteBase, sectionPath);
    const remoteCurrent = textNodesInSection(input.remoteCurrent, sectionPath);
    if (localBase.length < 2 || desired.length <= localBase.length || remoteBase.length !== localBase.length) continue;
    if (!localBase.every((node, index) => {
      const remote = remoteBase[index];
      return Boolean(remote && textNodeExactEquivalent(node, remote));
    })) continue;
    const stablePrefixLength = commonStableTextPrefixLength({
      localBase,
      desired,
      remoteBase,
      remoteCurrent
    });
    if (stablePrefixLength < 1 || stablePrefixLength >= localBase.length ||
      stablePrefixLength >= desired.length) continue;
    if (remoteCurrent.length !== desired.length + remoteBase.length - stablePrefixLength) continue;
    const prefix = remoteCurrent.slice(0, desired.length);
    const suffix = remoteCurrent.slice(desired.length);
    const prefixMatches = desired.map((node, index) => {
      const remote = prefix[index];
      const match = remote ? completedCreateTextMatch(node, remote) : undefined;
      return remote && match ? { desired: node, remote, match } : undefined;
    });
    if (prefixMatches.some((entry) => !entry)) continue;
    const baselineSuffix = remoteBase.slice(stablePrefixLength);
    if (suffix.length !== baselineSuffix.length || suffix.some((node, index) => {
      const baseline = baselineSuffix[index];
      return !baseline || !textNodeExactEquivalent(node, baseline) || !node.remoteBlockId;
    })) continue;
    const precedingBlockId = prefix.at(-1)?.remoteBlockId;
    const deleteLocator = suffix[0]?.locator;
    if (!precedingBlockId || !deleteLocator) continue;
    const lastSuffix = suffix.at(-1);
    const lastSuffixIndex = lastSuffix
      ? input.remoteCurrent.nodes.findIndex((node) => node === lastSuffix)
      : -1;
    const followingNode = lastSuffixIndex >= 0 ? input.remoteCurrent.nodes[lastSuffixIndex + 1] : undefined;
    if (followingNode && !followingNode.remoteBlockId) continue;
    const followingBlockId = followingNode?.remoteBlockId;
    recoveries.push({
      sectionPath,
      prefix: prefixMatches as CompletedCreateRecovery['prefix'],
      expectedSuffix: suffix.map((node) => ({
        blockId: node.remoteBlockId!,
        blockType: node.blockType,
        markdown: node.markdown
      })),
      precedingBlockId,
      ...(followingBlockId ? { followingBlockId } : {}),
      deleteLocator
    });
  }
  return recoveries;
}

function commonStableTextPrefixLength(input: {
  localBase: SemanticTextBlock[];
  desired: SemanticTextBlock[];
  remoteBase: SemanticTextBlock[];
  remoteCurrent: SemanticTextBlock[];
}): number {
  const length = Math.min(
    input.localBase.length,
    input.desired.length,
    input.remoteBase.length,
    input.remoteCurrent.length
  );
  let prefixLength = 0;
  while (prefixLength < length) {
    const localBase = input.localBase[prefixLength];
    const desired = input.desired[prefixLength];
    const remoteBase = input.remoteBase[prefixLength];
    const remoteCurrent = input.remoteCurrent[prefixLength];
    if (!localBase || !desired || !remoteBase || !remoteCurrent ||
      !textNodeExactEquivalent(localBase, desired) ||
      !textNodeExactEquivalent(localBase, remoteBase) ||
      !textNodeExactEquivalent(localBase, remoteCurrent)) break;
    prefixLength += 1;
  }
  return prefixLength;
}

function sectionContainsOnlyText(document: SemanticDocument, sectionPath: string[]): boolean {
  const key = JSON.stringify(sectionPath);
  const nodes = document.nodes.filter((node) => JSON.stringify(node.locator.sectionPath) === key);
  return nodes.length > 0 && nodes.every((node) => node.kind === 'text');
}

function textNodesInSection(document: SemanticDocument, sectionPath: string[]): SemanticTextBlock[] {
  return document.nodes.filter((node): node is SemanticTextBlock => {
    return node.kind === 'text' && JSON.stringify(node.locator.sectionPath) === JSON.stringify(sectionPath);
  });
}

function completedCreateTextMatch(
  desired: Pick<SemanticTextBlock, 'blockType' | 'markdown'>,
  remote: Pick<SemanticTextBlock, 'blockType' | 'markdown'>
): CompletedCreateRecovery['prefix'][number]['match'] | undefined {
  if (desired.blockType !== remote.blockType) return undefined;
  if (textNodeExactEquivalent(desired, remote)) return 'exact';
  if (!textRepresentationsEquivalent(desired.markdown, remote.markdown)) return undefined;
  const desiredLinks = markdownLinkTargets(desired.markdown);
  const remoteLinks = markdownLinkTargets(remote.markdown);
  if (desiredLinks.length > 0 && remoteLinks.length === 0 && desiredLinks.every(isFeishuDocumentUrl)) {
    return 'link-repair';
  }
  if (JSON.stringify(desiredLinks) === JSON.stringify(remoteLinks)) return 'representation';
  return undefined;
}

function textNodeExactEquivalent(
  left: Pick<SemanticTextBlock, 'blockType' | 'markdown'>,
  right: Pick<SemanticTextBlock, 'blockType' | 'markdown'>
): boolean {
  return left.blockType === right.blockType &&
    canonicalizeMarkdownSemantics(left.markdown) === canonicalizeMarkdownSemantics(right.markdown);
}

function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].flatMap((match) => match[1] ? [match[1]] : []);
}

function isFeishuDocumentUrl(url: string): boolean {
  return /^https:\/\/[^/]+\.(?:feishu\.cn|larksuite\.com)\/(?:wiki|docx)\//.test(url);
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
    return [textEntry(node)];
  });
}

function textEntry(node: SemanticTextBlock): PlanningEntry {
  const parsed = markdownToFeishuBlocks(node.markdown)[0] ?? placeholderBlock('', node.remoteBlockId);
  return {
    node,
    block: applyTextExecutionMetadata(parsed, node.remoteBlockId, node.children)
  };
}

function applyTextExecutionMetadata(
  block: FeishuBlock,
  remoteBlockId: string | undefined,
  children: SemanticTextChild[] | undefined
): FeishuBlock {
  const parsedChildren = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const resolvedChildren = children && children.length === parsedChildren.length
    ? parsedChildren.map((child, index) => {
        const metadata = children[index];
        return metadata
          ? applyTextExecutionMetadata(child, metadata.remoteBlockId, metadata.children)
          : child;
      })
    : parsedChildren;
  return {
    ...block,
    ...(remoteBlockId ? { block_id: remoteBlockId } : {}),
    ...(resolvedChildren.length > 0 ? { children: resolvedChildren } : {})
  };
}

function blockAtPath(block: FeishuBlock, path: number[]): FeishuBlock | undefined {
  let current: FeishuBlock | undefined = block;
  for (const index of path) {
    const children: FeishuBlock[] = Array.isArray(current?.children)
      ? current.children.filter(isFeishuBlock)
      : [];
    current = children[index];
  }
  return current;
}

function textLocatorAtPath(locator: SemanticLocator, path: number[]): SemanticLocator {
  return path.length > 0 ? { ...locator, textPath: path } : locator;
}

function scopedTextBlockShape(block: FeishuBlock): ScopedTextCreateOperation['desiredBlocks'][number] {
  return {
    blockType: block.block_type,
    markdown: feishuBlocksToMarkdown([block]).trim()
  };
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
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

function analyzeRecordedRoundTripLosses(input: {
  localBase?: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase?: SemanticDocument;
  remoteCurrent: SemanticDocument;
  tracked: boolean;
}): { losses: RecordedRoundTripLoss[]; blockers: ScopedPatchBlocker[] } {
  if (!input.tracked || !input.localBase || !input.remoteBase) return { losses: [], blockers: [] };
  const losses: RecordedRoundTripLoss[] = [];
  const blockers: ScopedPatchBlocker[] = [];
  const localBaseByKey = nodesByLocator(input.localBase);
  const localCurrentByKey = nodesByLocator(input.localCurrent);
  const remoteBaseByKey = nodesByLocator(input.remoteBase);
  const remoteCurrentByKey = nodesByLocator(input.remoteCurrent);
  const hierarchyCorrespondence = recordedTextHierarchyCorrespondence(input);
  const malformedTreeRecoveries = findMalformedTreeRecoveries(input);
  const malformedRepairKeys = new Set(malformedTreeRecoveries.flatMap((recovery) => {
    return recovery.desiredLocators.map(locatorKey);
  }));
  const malformedRecoverySections = new Set(malformedTreeRecoveries.map((recovery) => {
    return JSON.stringify(recovery.sectionPath);
  }));

  for (const node of input.localBase.nodes) {
    if (node.kind !== 'text') continue;
    const key = locatorKey(node.locator);
    if (hierarchyCorrespondence.repairableKeys.has(key) || malformedRepairKeys.has(key)) {
      losses.push({
        side: 'local-only',
        nodeKind: 'text',
        locator: node.locator,
        state: 'repairable',
        action: 'repair-text-hierarchy',
        message: `repairing receipt-recorded nested text hierarchy at ${key}`
      });
      continue;
    }
    if (hierarchyCorrespondence.alignedKeys.has(key)) continue;
    const remoteNode = remoteBaseByKey.get(key);
    if (remoteNode?.kind !== 'text' || textNodeContentEquivalent(node, remoteNode)) continue;
    const message = `receipt-recorded text baseline divergence is ambiguous at ${key}`;
    losses.push({
      side: 'divergent',
      nodeKind: 'text',
      locator: node.locator,
      state: 'blocked',
      action: 'block',
      message,
      ...(remoteCurrentByKey.get(key)?.remoteBlockId
        ? { remoteBlockId: remoteCurrentByKey.get(key)?.remoteBlockId }
        : {})
    });
    blockers.push({ code: 'round-trip-loss-ambiguous', locator: node.locator, message });
  }

  for (const node of input.localBase.nodes) {
    if (node.kind !== 'table') continue;
    const key = locatorKey(node.locator);
    if (remoteBaseByKey.has(key)) continue;
    const localCurrent = localCurrentByKey.get(key);
    const remoteCurrent = remoteCurrentByKey.get(key);
    const correspondingRemote = findCorrespondingRemoteTable(node, input.remoteCurrent);
    const localStable = localCurrent?.kind === 'table' && semanticNodeHash(localCurrent) === semanticNodeHash(node);
    const remoteStable = !remoteCurrent && !correspondingRemote.table;
    if (localStable && remoteStable) {
      losses.push({
        side: 'local-only',
        nodeKind: 'table',
        locator: node.locator,
        state: 'repairable',
        action: 'create-native-table',
        message: `repair receipt-recorded local-only table: ${tableIdentity(node)}`
      });
      continue;
    }
    if (localStable && localCurrent?.kind === 'table' && remoteCurrent?.kind === 'table' &&
      correspondingRemote.table === remoteCurrent &&
      isExactCompletedTableCreate({
        localBase: input.localBase,
        localCurrent: input.localCurrent,
        remoteBase: input.remoteBase,
        remoteCurrent: input.remoteCurrent,
        baselineTable: node,
        desiredTable: localCurrent,
        remoteTable: remoteCurrent
      })) {
      losses.push({
        side: 'local-only',
        nodeKind: 'table',
        locator: node.locator,
        state: 'repairable',
        action: 'preserve-created-table',
        message: `preserve exact completed native table: ${tableIdentity(node)}`,
        remoteBlockId: remoteCurrent.remoteBlockId
      });
      continue;
    }
    const message = !localStable
      ? `recorded local-only table changed locally after the receipt: ${tableIdentity(node)}`
      : `recorded local-only table scope changed remotely after the receipt: ${tableIdentity(node)}`;
    losses.push({
      side: 'local-only',
      nodeKind: 'table',
      locator: node.locator,
      state: 'blocked',
      action: 'block',
      message
    });
    blockers.push({ code: 'round-trip-loss-drift', locator: node.locator, message });
  }

  for (const node of input.remoteBase.nodes) {
    if (node.kind !== 'text') continue;
    if (malformedRecoverySections.has(JSON.stringify(node.locator.sectionPath))) continue;
    if (hierarchyCorrespondence.consumedRemoteBlockIds.has(
      remoteCurrentByKey.get(locatorKey(node.locator))?.remoteBlockId ?? ''
    )) continue;
    const key = locatorKey(node.locator);
    if (localBaseByKey.has(key)) continue;
    const counterpart = input.localBase.nodes.find((candidate): candidate is SemanticTextBlock => {
      return candidate.kind === 'text' &&
        sameSection(candidate.locator, node.locator) &&
        textNodeContentEquivalent(candidate, node);
    });
    if (!counterpart) continue;
    const remoteCounterpart = remoteBaseByKey.get(locatorKey(counterpart.locator));
    if (remoteCounterpart?.kind !== 'text' || !textNodeContentEquivalent(remoteCounterpart, counterpart)) {
      continue;
    }
    const localCurrent = localCurrentByKey.get(key);
    const localCurrentCounterpart = localCurrentByKey.get(locatorKey(counterpart.locator));
    const remoteCurrent = remoteCurrentByKey.get(key);
    const remoteCurrentCounterpart = remoteCurrentByKey.get(locatorKey(counterpart.locator));
    const localStable = !localCurrent && localCurrentCounterpart?.kind === 'text' &&
      semanticNodeHash(localCurrentCounterpart) === semanticNodeHash(counterpart);
    const remoteStable = remoteCurrent?.kind === 'text' && remoteCurrentCounterpart?.kind === 'text' &&
      semanticNodeHash(remoteCurrent) === semanticNodeHash(node) &&
      semanticNodeHash(remoteCurrentCounterpart) === semanticNodeHash(remoteCounterpart);
    if (localStable && remoteStable) {
      losses.push({
        side: 'remote-only',
        nodeKind: 'text',
        locator: node.locator,
        state: 'repairable',
        action: 'delete-duplicate-text',
        message: `delete receipt-recorded remote-only duplicate text at ${key}`,
        remoteBlockId: remoteCurrent.remoteBlockId
      });
      continue;
    }
    const message = !localStable
      ? `recorded remote-only duplicate scope changed locally after the receipt: ${key}`
      : `recorded remote-only duplicate changed remotely after the receipt: ${key}`;
    losses.push({
      side: 'remote-only',
      nodeKind: 'text',
      locator: node.locator,
      state: 'blocked',
      action: 'block',
      message,
      ...(remoteCurrent?.kind === 'text' && remoteCurrent.remoteBlockId
        ? { remoteBlockId: remoteCurrent.remoteBlockId }
        : {})
    });
    blockers.push({ code: 'round-trip-loss-drift', locator: node.locator, message });
  }

  return { losses, blockers };
}

function recordedTextHierarchyCorrespondence(
  input: {
    localBase?: SemanticDocument;
    localCurrent: SemanticDocument;
    remoteBase?: SemanticDocument;
    remoteCurrent: SemanticDocument;
    tracked: boolean;
  }
): {
  repairableKeys: Set<string>;
  alignedKeys: Set<string>;
  consumedRemoteBlockIds: Set<string>;
} {
  const result = {
    repairableKeys: new Set<string>(),
    alignedKeys: new Set<string>(),
    consumedRemoteBlockIds: new Set<string>()
  };
  if (!input.localBase || !input.remoteBase) return result;
  const sections = new Map<string, string[]>();
  for (const node of input.localBase.nodes) {
    if (node.kind === 'text' && node.children?.length) {
      sections.set(JSON.stringify(node.locator.sectionPath), node.locator.sectionPath);
    }
  }
  for (const sectionPath of sections.values()) {
    if (!sectionContainsOnlyText(input.localBase, sectionPath) ||
      !sectionContainsOnlyText(input.localCurrent, sectionPath) ||
      !sectionContainsOnlyText(input.remoteBase, sectionPath) ||
      !sectionContainsOnlyText(input.remoteCurrent, sectionPath)) continue;
    const localBase = textNodesInSection(input.localBase, sectionPath);
    const localCurrentByKey = nodesByLocator(input.localCurrent);
    const remoteBase = textNodesInSection(input.remoteBase, sectionPath);
    const remoteCurrent = textNodesInSection(input.remoteCurrent, sectionPath);
    if (remoteBase.length !== remoteCurrent.length) continue;
    const sectionRepairableKeys = new Set<string>();
    const sectionAlignedKeys = new Set<string>();
    const sectionConsumedRemoteBlockIds = new Set<string>();
    let remoteIndex = 0;
    let valid = true;
    for (const baselineNode of localBase) {
      const key = locatorKey(baselineNode.locator);
      const localCurrent = localCurrentByKey.get(key);
      if (localCurrent?.kind !== 'text' || semanticNodeHash(localCurrent) !== semanticNodeHash(baselineNode)) {
        valid = false;
        break;
      }
      const desiredBlocks = markdownToFeishuBlocks(baselineNode.markdown);
      if (desiredBlocks.length !== 1) {
        valid = false;
        break;
      }
      const flattened = flattenTextBlockShapes(desiredBlocks[0]!);
      const baselineSlice = remoteBase.slice(remoteIndex, remoteIndex + flattened.length);
      const currentSlice = remoteCurrent.slice(remoteIndex, remoteIndex + flattened.length);
      const currentBlockIds = currentSlice.flatMap((node) => node.remoteBlockId ? [node.remoteBlockId] : []);
      if (baselineSlice.length !== flattened.length || currentSlice.length !== flattened.length ||
        currentBlockIds.length !== currentSlice.length ||
        new Set(currentBlockIds).size !== currentBlockIds.length ||
        currentBlockIds.some((blockId) => sectionConsumedRemoteBlockIds.has(blockId)) ||
        flattened.some((shape, index) => {
          const baseline = baselineSlice[index];
          const current = currentSlice[index];
          return !baseline || !current || baseline.children?.length || current.children?.length ||
            !current.remoteBlockId || locatorKey(baseline.locator) !== locatorKey(current.locator) ||
            baseline.blockType !== shape.blockType || current.blockType !== shape.blockType ||
            canonicalizeMarkdownSemantics(baseline.markdown) !== canonicalizeMarkdownSemantics(shape.markdown) ||
            canonicalizeMarkdownSemantics(current.markdown) !== canonicalizeMarkdownSemantics(shape.markdown);
        })) {
        valid = false;
        break;
      }
      sectionAlignedKeys.add(key);
      if (flattened.length > 1) sectionRepairableKeys.add(key);
      for (const current of currentSlice) sectionConsumedRemoteBlockIds.add(current.remoteBlockId!);
      remoteIndex += flattened.length;
    }
    if (!valid || remoteIndex !== remoteBase.length || remoteIndex !== remoteCurrent.length ||
      sectionRepairableKeys.size === 0) continue;
    for (const key of sectionRepairableKeys) result.repairableKeys.add(key);
    for (const key of sectionAlignedKeys) result.alignedKeys.add(key);
    for (const blockId of sectionConsumedRemoteBlockIds) result.consumedRemoteBlockIds.add(blockId);
  }
  return result;
}

function flattenTextBlockShapes(block: FeishuBlock): Array<{ blockType: number; markdown: string }> {
  const children = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const { children: _children, ...shell } = block;
  return [{
    blockType: block.block_type,
    markdown: feishuBlocksToMarkdown([shell]).trim()
  }, ...children.flatMap(flattenTextBlockShapes)];
}

function isExactCompletedTableCreate(input: {
  localBase: SemanticDocument;
  localCurrent: SemanticDocument;
  remoteBase: SemanticDocument;
  remoteCurrent: SemanticDocument;
  baselineTable: SemanticTable;
  desiredTable: SemanticTable;
  remoteTable: SemanticTable;
}): boolean {
  if (!input.remoteTable.remoteBlockId ||
    locatorKey(input.baselineTable.locator) !== locatorKey(input.desiredTable.locator) ||
    locatorKey(input.desiredTable.locator) !== locatorKey(input.remoteTable.locator) ||
    semanticNodeHash(input.baselineTable) !== semanticNodeHash(input.desiredTable) ||
    semanticNodeHash(input.desiredTable) !== semanticNodeHash(input.remoteTable)) return false;

  const localBaseIndex = input.localBase.nodes.indexOf(input.baselineTable);
  const localCurrentIndex = input.localCurrent.nodes.indexOf(input.desiredTable);
  const remoteCurrentIndex = input.remoteCurrent.nodes.indexOf(input.remoteTable);
  if (localBaseIndex <= 0 || localCurrentIndex <= 0 || remoteCurrentIndex <= 0) return false;

  const localBasePreceding = input.localBase.nodes[localBaseIndex - 1];
  const localBaseFollowing = input.localBase.nodes[localBaseIndex + 1];
  const localCurrentPreceding = input.localCurrent.nodes[localCurrentIndex - 1];
  const localCurrentFollowing = input.localCurrent.nodes[localCurrentIndex + 1];
  const remoteCurrentPreceding = input.remoteCurrent.nodes[remoteCurrentIndex - 1];
  const remoteCurrentFollowing = input.remoteCurrent.nodes[remoteCurrentIndex + 1];
  if (!localBasePreceding || !localBaseFollowing || !localCurrentPreceding || !localCurrentFollowing ||
    !remoteCurrentPreceding?.remoteBlockId || !remoteCurrentFollowing?.remoteBlockId) return false;

  const remoteBasePreceding = input.remoteBase.nodes.find((node) => {
    return locatorKey(node.locator) === locatorKey(localBasePreceding.locator);
  });
  const remoteBaseFollowing = input.remoteBase.nodes.find((node) => {
    return locatorKey(node.locator) === locatorKey(localBaseFollowing.locator);
  });
  if (!remoteBasePreceding || !remoteBaseFollowing) return false;
  const remoteBasePrecedingIndex = input.remoteBase.nodes.indexOf(remoteBasePreceding);
  if (input.remoteBase.nodes[remoteBasePrecedingIndex + 1] !== remoteBaseFollowing) return false;

  return semanticNodeHash(localBasePreceding) === semanticNodeHash(localCurrentPreceding) &&
    semanticNodeHash(localBaseFollowing) === semanticNodeHash(localCurrentFollowing) &&
    semanticNodeHash(localBasePreceding) === semanticNodeHash(remoteBasePreceding) &&
    semanticNodeHash(localBaseFollowing) === semanticNodeHash(remoteBaseFollowing) &&
    semanticNodeHash(remoteBasePreceding) === semanticNodeHash(remoteCurrentPreceding) &&
    semanticNodeHash(remoteBaseFollowing) === semanticNodeHash(remoteCurrentFollowing);
}

function nodesByLocator(document: SemanticDocument): Map<string, SemanticNode> {
  return new Map(document.nodes.map((node) => [locatorKey(node.locator), node]));
}

function sameSection(left: SemanticLocator, right: SemanticLocator): boolean {
  return JSON.stringify(left.sectionPath) === JSON.stringify(right.sectionPath);
}

function textNodeContentEquivalent(left: SemanticTextBlock, right: SemanticTextBlock): boolean {
  return left.blockType === right.blockType && textRepresentationsEquivalent(left.markdown, right.markdown);
}

function tableCreateFollowingAnchor(
  remoteEntries: PlanningEntry[],
  insertAfterBlockId: string,
  parentBlockId: string,
  blockers: ScopedPatchBlocker[],
  locator: SemanticLocator
): { insertBeforeBlockId?: string } {
  const anchorIndex = insertAfterBlockId === parentBlockId
    ? -1
    : remoteEntries.findIndex((entry) => entry.node.remoteBlockId === insertAfterBlockId);
  if (insertAfterBlockId !== parentBlockId && anchorIndex < 0) {
    blockers.push({
      code: 'correspondence-ambiguous',
      locator,
      message: 'table creation preceding anchor is not present in the remote semantic sequence'
    });
    return {};
  }
  const following = remoteEntries[anchorIndex + 1];
  if (!following) return {};
  if (following.node.remoteBlockId) return { insertBeforeBlockId: following.node.remoteBlockId };
  blockers.push({
    code: 'correspondence-ambiguous',
    locator,
    message: 'table creation following anchor has no remote block ID'
  });
  return {};
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

function findTableByIdentity(document: SemanticDocument | undefined, source: SemanticTable): SemanticTable | undefined {
  return document?.nodes.find((node): node is SemanticTable => {
    return node.kind === 'table' && tableIdentity(node) === tableIdentity(source);
  });
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
  return semanticHash(stripExecutionMetadata(node));
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

function visibleText(markdown: string): string {
  return normalizeWhitespace(markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
}

function textRepresentationsEquivalent(local: string, remote: string): boolean {
  const canonicalLocal = canonicalizeMarkdownSemantics(local);
  const canonicalRemote = canonicalizeMarkdownSemantics(remote);
  if (visibleText(canonicalLocal) === visibleText(canonicalRemote)) return true;
  const localCode = fencedCode(canonicalLocal);
  const remoteCode = fencedCode(canonicalRemote);
  if (!localCode || !remoteCode || localCode.body !== remoteCode.body) return false;
  return !localCode.language || !remoteCode.language || localCode.language === remoteCode.language;
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
