import type { FeishuBlock } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { normalizeWhitespace, semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
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
import { diffCorrespondingTable, findCorrespondingRemoteTable, tableIdentity, type TableDiff } from './table-diff.js';

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
  | CalloutOperation;

export type ScopedPatchBlocker = {
  code:
    | 'correspondence-ambiguous'
    | 'unsupported-local-change'
    | 'remote-scope-conflict'
    | CalloutPlanBlocker['code'];
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
}): ScopedPatchPlan {
  const blockers: ScopedPatchBlocker[] = [];
  const warnings: string[] = [];
  const localChanged = changedLocatorKeys(input.localBase, input.localCurrent, input.tracked);
  const remoteChanged = input.tracked
    ? changedLocatorKeys(input.remoteBase, input.remoteCurrent, true)
    : new Set<string>();

  for (const node of input.localCurrent.nodes) {
    if (node.kind !== 'opaque') continue;
    if (!input.tracked) {
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
  blockers.push(...calloutPlanning.blockers);
  warnings.push(...calloutPlanning.warnings);
  const operations: ScopedPatchOperation[] = [
    ...textPlanning.operations,
    ...calloutPlanning.operations
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
  return {
    kind: 'scoped-patch-plan',
    safeToWrite: blockers.length === 0,
    operations,
    blockers,
    warnings: uniqueWarnings,
    requiresCollaborationRiskConfirmation: calloutPlanning.requiresCollaborationRiskConfirmation || operations.some((operation) => {
      return operation.kind === 'update' || operation.kind === 'delete' || operation.kind === 'table-replace';
    }),
    scopeSummary: {
      localChanged: locatorsForKeys(input.localCurrent, localChanged),
      remoteChanged: locatorsForKeys(input.remoteCurrent, remoteChanged),
      overlappingConflicts: blockers.flatMap((blocker) => {
        return (blocker.code === 'remote-scope-conflict' || blocker.code === 'remote-callout-conflict') && blocker.locator
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
    return entry;
  });

  const textPlan = planPublishBlockPatch({
    parentBlockId: input.parentBlockId,
    remoteBlocks: remoteEntries.map((entry) => entry.block),
    desiredBlocks: desiredEntries.map((entry) => entry.block)
  });
  if (!textPlan.safeToWrite) return { operations: [], fallbackReason: textPlan.fallbackReason };

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

type PlanningEntry = { node: SemanticNode; block: FeishuBlock };

function planningEntries(document: SemanticDocument): PlanningEntry[] {
  return document.nodes.flatMap((node): PlanningEntry[] => {
    if (node.kind === 'opaque' || node.kind === 'asset' || node.kind === 'callout' || node.kind === 'code') return [];
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

function findTableByIdentity(document: SemanticDocument | undefined, source: SemanticTable): SemanticTable | undefined {
  return document?.nodes.find((node): node is SemanticTable => {
    return node.kind === 'table' && tableIdentity(node) === tableIdentity(source);
  });
}

function semanticNodeHash(node: SemanticNode): string {
  if (node.kind === 'callout') return calloutContentHash(node);
  return semanticHash(stripExecutionMetadata(node));
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

function visibleText(markdown: string): string {
  return normalizeWhitespace(markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
}

function textRepresentationsEquivalent(local: string, remote: string): boolean {
  if (visibleText(local) === visibleText(remote)) return true;
  const localCode = fencedCode(local);
  const remoteCode = fencedCode(remote);
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
