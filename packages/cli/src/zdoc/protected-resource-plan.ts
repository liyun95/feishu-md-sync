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

    if (tracked) {
      const receipt = input.receiptEntries.find((entry) => entry.componentId === componentId);
      if (!receipt) {
        blockers.push({
          code: 'supademo-missing',
          message: `No receipt mapping exists for Supademo ${componentId}.`
        });
        continue;
      }
      const remote = remoteResources.find((candidate) => candidate.remoteBlockId === receipt.blockId);
      if (!remote || remote.componentId !== componentId ||
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
      entries.push(receipt);
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
