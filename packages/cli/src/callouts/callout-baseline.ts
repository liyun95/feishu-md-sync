import type { CalloutType, SemanticCallout, SemanticDocument, SemanticLocator } from '../semantic/types.js';

export function applyTrackedCalloutTypes(
  current: SemanticDocument,
  baseline: SemanticDocument | undefined
): SemanticDocument {
  if (!baseline) return current;
  const baselineByLocator = new Map(baseline.nodes.flatMap((node) => {
    return node.kind === 'callout' && node.calloutType
      ? [[locatorKey(node.locator), node.calloutType] as const]
      : [];
  }));
  return {
    nodes: current.nodes.map((node) => {
      if (node.kind !== 'callout') return node;
      const calloutType = baselineByLocator.get(locatorKey(node.locator));
      if (!calloutType) return node;
      return {
        ...node,
        calloutType,
        unsupported: node.unsupported.filter((message) => message !== 'remote Callout title is unrecognized')
      };
    })
  };
}

export function calloutTypeHints(document: SemanticDocument | undefined): Array<CalloutType | undefined> {
  return document?.nodes.filter((node): node is SemanticCallout => node.kind === 'callout')
    .map((node) => node.calloutType) ?? [];
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}
