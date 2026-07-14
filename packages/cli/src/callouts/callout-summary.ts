import type { CalloutOperation } from '../publish/callout-plan.js';
import type { ScopedPatchOperation } from '../publish/scoped-patch-plan.js';
import type { CalloutType, SemanticCallout, SemanticDocument, SemanticLocator } from '../semantic/types.js';

export type CalloutChildChangeSummary = {
  action: 'create' | 'update' | 'delete';
  ordinal: number;
  blockType?: number;
};

export type CalloutChangeSummary = {
  type: CalloutType | 'unknown';
  action: 'create' | 'update' | 'delete';
  locator: SemanticLocator;
  childChanges: CalloutChildChangeSummary[];
};

export function summarizeCalloutChanges(input: {
  operations: ScopedPatchOperation[];
  local?: SemanticDocument;
  remote?: SemanticDocument;
}): CalloutChangeSummary[] {
  const summaries = new Map<string, CalloutChangeSummary>();
  for (const operation of input.operations.filter(isCalloutOperation)) {
    const key = locatorKey(operation.locator);
    const local = findCallout(input.local, operation.locator);
    const remote = findCallout(input.remote, operation.locator);
    const summary = summaries.get(key) ?? {
      type: operation.kind === 'callout-create'
        ? operation.desiredCallout.calloutType ?? 'unknown'
        : local?.calloutType ?? remote?.calloutType ?? 'unknown',
      action: operation.kind === 'callout-create'
        ? 'create'
        : operation.kind === 'callout-delete'
          ? 'delete'
          : 'update',
      locator: operation.locator,
      childChanges: []
    };
    if (operation.kind === 'callout-create') {
      summary.childChanges.push(...operation.desiredCallout.children.map((child) => ({
        action: 'create' as const,
        ordinal: child.ordinal,
        blockType: child.blockType
      })));
    } else if (operation.kind === 'callout-child-update') {
      summary.childChanges.push({
        action: 'update',
        ordinal: operation.childOrdinal,
        blockType: local?.children[operation.childOrdinal]?.blockType ?? remote?.children[operation.childOrdinal]?.blockType
      });
    } else if (operation.kind === 'callout-child-create') {
      summary.childChanges.push(...operation.desiredChildren.map((child, index) => ({
        action: 'create' as const,
        ordinal: operation.childOrdinal + index,
        blockType: child.blockType
      })));
    } else if (operation.kind === 'callout-child-delete') {
      summary.childChanges.push(...operation.blockIds.map((_blockId, index) => ({
        action: 'delete' as const,
        ordinal: operation.childOrdinal + index,
        blockType: remote?.children[operation.childOrdinal + index]?.blockType
      })));
    }
    summaries.set(key, summary);
  }
  return [...summaries.values()];
}

export function calloutBlockTypeLabel(blockType: number | undefined): string {
  if (blockType === 2) return 'paragraph';
  if (blockType && blockType >= 3 && blockType <= 8) return `heading${blockType - 2}`;
  if (blockType === 12) return 'bullet';
  if (blockType === 13) return 'ordered';
  return 'block';
}

function isCalloutOperation(operation: ScopedPatchOperation): operation is CalloutOperation {
  return operation.kind.startsWith('callout-');
}

function findCallout(document: SemanticDocument | undefined, locator: SemanticLocator): SemanticCallout | undefined {
  return document?.nodes.find((node): node is SemanticCallout => {
    return node.kind === 'callout' && locatorKey(node.locator) === locatorKey(locator);
  });
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}
