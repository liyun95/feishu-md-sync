import type { ProtectedResourceReceiptEntry } from '../receipts/publish-receipt.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type {
  SemanticDocument,
  SemanticNode,
  SemanticProtectedResource
} from '../semantic/types.js';
import type { ZdocRoundTripItem } from './types.js';

export type ProtectedResourcePlanBlocker = {
  code: 'supademo-missing' | 'supademo-ambiguous' | 'supademo-changed' | 'supademo-removed';
  message: string;
};

export function planProtectedResources(input: {
  local: SemanticDocument;
  localBase?: SemanticDocument;
  remote: SemanticDocument;
  receiptEntries: ProtectedResourceReceiptEntry[];
}): {
  entries: ProtectedResourceReceiptEntry[];
  items: ZdocRoundTripItem[];
  blockers: ProtectedResourcePlanBlocker[];
} {
  const entries: ProtectedResourceReceiptEntry[] = [];
  const items: ZdocRoundTripItem[] = [];
  const blockers: ProtectedResourcePlanBlocker[] = [];
  const localResources = resources(input.local);
  const remoteResources = resources(input.remote);
  const tracked = input.receiptEntries.length > 0;
  const localIdentityCounts = new Map<string, number>();
  for (const resource of localResources) {
    if (!resource.componentId) continue;
    localIdentityCounts.set(
      resource.componentId,
      (localIdentityCounts.get(resource.componentId) ?? 0) + 1
    );
  }
  const reportedAmbiguousLocalIdentities = new Set<string>();

  for (const receipt of input.receiptEntries) {
    if (localResources.some((resource) => resource.componentId === receipt.componentId)) continue;
    entries.push(receipt);
    blockers.push({
      code: 'supademo-removed',
      message: `Removing tracked Supademo ${receipt.componentId} is not supported; its ISV block remains protected.`
    });
  }

  for (const local of localResources) {
    const componentId = local.componentId;
    if (!componentId) {
      blockers.push({
        code: 'supademo-missing',
        message: 'Local Supademo placeholder has no component ID.'
      });
      continue;
    }
    if ((localIdentityCounts.get(componentId) ?? 0) !== 1) {
      if (!reportedAmbiguousLocalIdentities.has(componentId)) {
        blockers.push({
          code: 'supademo-ambiguous',
          message: `Multiple local Supademo components use identity ${componentId}.`
        });
        reportedAmbiguousLocalIdentities.add(componentId);
      }
      continue;
    }

    if (tracked) {
      const matchingReceipts = input.receiptEntries.filter((entry) => entry.componentId === componentId);
      if (matchingReceipts.length === 0) {
        blockers.push({
          code: 'supademo-missing',
          message: `No receipt mapping exists for Supademo ${componentId}.`
        });
        continue;
      }
      if (matchingReceipts.length !== 1) {
        blockers.push({
          code: 'supademo-ambiguous',
          message: `Multiple receipt mappings exist for Supademo ${componentId}.`
        });
        continue;
      }
      const receipt = matchingReceipts[0];
      if (!receipt) continue;
      const baselineResources = input.localBase
        ? resources(input.localBase).filter((resource) => resource.componentId === componentId)
        : [];
      if (input.localBase && baselineResources.length !== 1) {
        blockers.push({
          code: baselineResources.length === 0 ? 'supademo-changed' : 'supademo-ambiguous',
          message: baselineResources.length === 0
            ? `The local baseline has no Supademo ${componentId}.`
            : `The local baseline has multiple Supademo components using identity ${componentId}.`
        });
        continue;
      }
      const baselineResource = baselineResources[0];
      const remote = remoteResources.find((candidate) => candidate.remoteBlockId === receipt.blockId);
      if (!remote || remote.componentId !== componentId ||
        remote.isShowcase !== local.isShowcase ||
        (receipt.isShowcase !== undefined &&
          (receipt.isShowcase !== local.isShowcase || receipt.isShowcase !== remote.isShowcase)) ||
        !sameSectionPath(local.locator.sectionPath, receipt.sectionPath) ||
        local.locator.ordinal !== receipt.ordinal ||
        (input.localBase && baselineResource &&
          !sameLocalPlacement(input.localBase, baselineResource, input.local, local)) ||
        remote.remoteShape !== receipt.remoteShape ||
        remote.remoteToken !== receipt.remoteToken ||
        !correspondingSectionPath(remote.locator.sectionPath, receipt.sectionPath) ||
        remote.locator.ordinal !== receipt.ordinal ||
        (receipt.previousFingerprint !== undefined &&
          neighborFingerprint(input.remote, remote, -1) !== receipt.previousFingerprint) ||
        (receipt.nextFingerprint !== undefined &&
          neighborFingerprint(input.remote, remote, 1) !== receipt.nextFingerprint)) {
        blockers.push({
          code: 'supademo-changed',
          message: `Protected Supademo ${componentId} changed shape, identity, or placement.`
        });
        continue;
      }
      entries.push({ ...receipt, isShowcase: local.isShowcase });
      items.push({
        code: 'supademo-protected',
        severity: 'info',
        component: 'Supademo',
        message: `protect Supademo ${componentId} without rewriting its ISV block`,
        remoteBlockId: receipt.blockId
      });
      continue;
    }

    const previousFingerprint = neighborFingerprint(input.local, local, -1);
    const nextFingerprint = neighborFingerprint(input.local, local, 1);
    const candidates = remoteResources.filter((remote) => {
      return remote.componentId === componentId &&
        remote.isShowcase === local.isShowcase &&
        correspondingSectionPath(remote.locator.sectionPath, local.locator.sectionPath) &&
        remote.locator.ordinal === local.locator.ordinal &&
        (previousFingerprint === undefined ||
          neighborFingerprint(input.remote, remote, -1) === previousFingerprint) &&
        (nextFingerprint === undefined ||
          neighborFingerprint(input.remote, remote, 1) === nextFingerprint);
    });
    if (candidates.length === 0) {
      blockers.push({
        code: 'supademo-missing',
        message: `No unique ISV correspondence exists for Supademo ${componentId}.`
      });
      continue;
    }
    if (candidates.length !== 1) {
      blockers.push({
        code: 'supademo-ambiguous',
        message: `Multiple ISV candidates correspond to Supademo ${componentId}.`
      });
      continue;
    }
    const remote = candidates[0];
    if (!remote?.remoteBlockId || !remote.remoteShape) {
      blockers.push({
        code: 'supademo-missing',
        message: `The ISV correspondence for Supademo ${componentId} lacks identity metadata.`
      });
      continue;
    }
    const entry: ProtectedResourceReceiptEntry = {
      kind: 'supademo',
      componentId,
      isShowcase: local.isShowcase,
      blockId: remote.remoteBlockId,
      remoteShape: remote.remoteShape,
      ...(remote.remoteToken ? { remoteToken: remote.remoteToken } : {}),
      sectionPath: [...local.locator.sectionPath],
      ordinal: local.locator.ordinal,
      ...(previousFingerprint ? { previousFingerprint } : {}),
      ...(nextFingerprint ? { nextFingerprint } : {})
    };
    entries.push(entry);
    items.push({
      code: 'supademo-adopt',
      severity: 'info',
      component: 'Supademo',
      message: `adopt existing ISV block for Supademo ${componentId}`,
      remoteBlockId: remote.remoteBlockId
    });
  }

  return { entries, items, blockers };
}

function resources(document: SemanticDocument): SemanticProtectedResource[] {
  return document.nodes.filter((node): node is SemanticProtectedResource => {
    return node.kind === 'protected-resource' && node.resourceKind === 'supademo';
  });
}

function neighborFingerprint(
  document: SemanticDocument,
  resource: SemanticProtectedResource,
  direction: -1 | 1
): string | undefined {
  const start = document.nodes.indexOf(resource);
  for (let index = start + direction; index >= 0 && index < document.nodes.length; index += direction) {
    const node = document.nodes[index];
    if (!node || node.kind === 'authoring-token' || node.kind === 'protected-resource') continue;
    return nodeFingerprint(node);
  }
  return undefined;
}

function nodeFingerprint(node: SemanticNode): string {
  const { locator: _locator, ...content } = stripExecutionMetadata(node);
  return semanticHash(content);
}

function correspondingSectionPath(left: string[], right: string[]): boolean {
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const offset = longer.length - shorter.length;
  return shorter.every((part, index) => part === longer[index + offset]);
}

function sameSectionPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameLocalPlacement(
  baseline: SemanticDocument,
  baselineResource: SemanticProtectedResource,
  current: SemanticDocument,
  currentResource: SemanticProtectedResource
): boolean {
  const before = adjacentLocatorKeys(baseline, baselineResource);
  const after = adjacentLocatorKeys(current, currentResource);
  return before.previous === after.previous && before.next === after.next;
}

function adjacentLocatorKeys(
  document: SemanticDocument,
  resource: SemanticProtectedResource
): { previous?: string; next?: string } {
  const index = document.nodes.indexOf(resource);
  return {
    ...(index > 0 ? { previous: locatorKey(document.nodes[index - 1]!) } : {}),
    ...(index >= 0 && index + 1 < document.nodes.length
      ? { next: locatorKey(document.nodes[index + 1]!) }
      : {})
  };
}

function locatorKey(node: SemanticNode): string {
  const locator = node.locator;
  return JSON.stringify({
    sectionPath: locator.sectionPath,
    kind: locator.kind,
    ordinal: locator.ordinal,
    ...(locator.textPath ? { textPath: locator.textPath } : {})
  });
}
