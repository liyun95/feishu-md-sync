import type { WhiteboardReceiptEntry } from '../receipts/publish-receipt.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type { SemanticAssetNode, SemanticDocument, SemanticLocator, SemanticNode } from '../semantic/types.js';
import type { LocalWhiteboardAsset } from './local-assets.js';

export type WhiteboardAssetState =
  | 'clean'
  | 'local-changed'
  | 'remote-changed'
  | 'conflict'
  | 'untracked'
  | 'missing';

export type WhiteboardOperation =
  | {
    kind: 'whiteboard-create';
    assetKey: string;
    locator: SemanticLocator;
    placementFingerprint: string;
    remoteImageBlockId: string;
    svgPath: string;
    svgHash: string;
  }
  | {
    kind: 'whiteboard-adopt';
    assetKey: string;
    locator: SemanticLocator;
    placementFingerprint: string;
    blockId: string;
    whiteboardToken: string;
    svgPath: string;
    svgHash: string;
    remoteStateHash: string;
  }
  | {
    kind: 'whiteboard-update';
    assetKey: string;
    locator: SemanticLocator;
    placementFingerprint: string;
    blockId: string;
    whiteboardToken: string;
    svgPath: string;
    svgHash: string;
    remoteStateHash: string;
    reason: 'local-changed' | 'confirmed-remote-overwrite';
  };

export type WhiteboardAssetPlan = {
  assetKey: string;
  state: WhiteboardAssetState;
  action: string;
  local: 'changed' | 'unchanged' | 'missing';
  remote: 'changed' | 'unchanged' | 'missing' | 'untracked';
};

export type WhiteboardPlanBlocker = {
  code: string;
  assetKey: string;
  message: string;
};

export type WhiteboardPlan = {
  kind: 'whiteboard-plan';
  safeToWrite: boolean;
  assets: WhiteboardAssetPlan[];
  operations: WhiteboardOperation[];
  blockers: WhiteboardPlanBlocker[];
  warnings: string[];
  requiresCollaborationRiskConfirmation: boolean;
  requiresUntrackedRemoteConfirmation: boolean;
};

export type WhiteboardPlanningInput = {
  localDocument: SemanticDocument;
  remoteDocument: SemanticDocument;
  localAssets: LocalWhiteboardAsset[];
  discoveryBlockers: Array<{ code: string; assetKey: string; message: string }>;
  receiptEntries: WhiteboardReceiptEntry[];
  remoteStates: ReadonlyMap<string, { hash: string }>;
  confirmedRemoteOverwrites: ReadonlySet<string>;
};

export function planWhiteboardPublish(input: WhiteboardPlanningInput): WhiteboardPlan {
  const blockers: WhiteboardPlanBlocker[] = [...input.discoveryBlockers];
  const assets: WhiteboardAssetPlan[] = input.discoveryBlockers.map((blocker) => ({
    assetKey: blocker.assetKey,
    state: 'missing',
    action: 'repair local Whiteboard asset',
    local: 'missing',
    remote: 'untracked'
  }));
  const operations: WhiteboardOperation[] = [];
  const receiptsByKey = new Map(input.receiptEntries.map((entry) => [entry.assetKey, entry]));
  const localKeys = new Set(input.localAssets.map((asset) => asset.assetKey));

  for (const asset of input.localAssets) {
    if (blockers.some((blocker) => blocker.assetKey === asset.assetKey)) continue;
    const receipt = receiptsByKey.get(asset.assetKey);
    if (!receipt) {
      planUntrackedAsset({ input, asset, blockers, assets, operations });
      continue;
    }
    planTrackedAsset({ input, asset, receipt, blockers, assets, operations });
  }

  for (const receipt of input.receiptEntries) {
    if (localKeys.has(receipt.assetKey)) continue;
    blockers.push({
      code: 'missing-local-whiteboard-asset',
      assetKey: receipt.assetKey,
      message: `tracked Whiteboard asset is missing locally: ${receipt.assetKey}`
    });
    assets.push({
      assetKey: receipt.assetKey,
      state: 'missing',
      action: 'restore local Whiteboard asset',
      local: 'missing',
      remote: 'unchanged'
    });
  }

  const safeToWrite = blockers.length === 0;
  const plannedOperations = safeToWrite ? operations : [];
  return {
    kind: 'whiteboard-plan',
    safeToWrite,
    assets,
    operations: plannedOperations,
    blockers,
    warnings: [],
    requiresCollaborationRiskConfirmation: plannedOperations.length > 0,
    requiresUntrackedRemoteConfirmation: plannedOperations.some((operation) => {
      return operation.kind === 'whiteboard-create' || operation.kind === 'whiteboard-adopt';
    })
  };
}

function planUntrackedAsset(input: {
  input: WhiteboardPlanningInput;
  asset: LocalWhiteboardAsset;
  blockers: WhiteboardPlanBlocker[];
  assets: WhiteboardAssetPlan[];
  operations: WhiteboardOperation[];
}): void {
  if (hasMultipleUntrackedAssetSlots(input.input, input.asset.locator)) {
    input.blockers.push({
      code: 'whiteboard-correspondence-ambiguous',
      assetKey: input.asset.assetKey,
      message: `multiple untracked image or Whiteboard slots exist in this section: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'track or separate remote Whiteboard slots'));
    return;
  }
  const candidates = correspondingRemoteAssets(input.input.remoteDocument, input.asset.locator);
  if (candidates.length !== 1) {
    input.blockers.push({
      code: 'whiteboard-correspondence-ambiguous',
      assetKey: input.asset.assetKey,
      message: `expected one remote image or Whiteboard for ${input.asset.assetKey}, found ${candidates.length}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'resolve remote Whiteboard correspondence'));
    return;
  }
  const remote = candidates[0];
  const placementFingerprint = fingerprintFor(input.input.localDocument, input.asset.locator);
  const localCorrespondenceFingerprint = correspondenceFingerprintFor(input.input.localDocument, input.asset.locator);
  const remoteCorrespondenceFingerprint = correspondenceFingerprintFor(input.input.remoteDocument, remote.locator);
  if (localCorrespondenceFingerprint !== remoteCorrespondenceFingerprint) {
    input.blockers.push({
      code: 'whiteboard-placement-mismatch',
      assetKey: input.asset.assetKey,
      message: `local and remote context do not identify the same asset position: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'align local and remote Whiteboard placement'));
    return;
  }
  if (!remote.remoteBlockId) {
    input.blockers.push({
      code: 'missing-remote-whiteboard',
      assetKey: input.asset.assetKey,
      message: `remote asset block ID is missing: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair remote asset block'));
    return;
  }

  if (remote.representation === 'image') {
    input.operations.push({
      kind: 'whiteboard-create',
      assetKey: input.asset.assetKey,
      locator: input.asset.locator,
      placementFingerprint,
      remoteImageBlockId: remote.remoteBlockId,
      svgPath: input.asset.svgPath,
      svgHash: input.asset.svgHash
    });
    input.assets.push({
      assetKey: input.asset.assetKey,
      state: 'untracked',
      action: 'replace remote image with whiteboard',
      local: 'changed',
      remote: 'untracked'
    });
    return;
  }

  if (!remote.remoteToken || !input.input.remoteStates.has(remote.remoteToken)) {
    input.blockers.push({
      code: 'missing-remote-whiteboard',
      assetKey: input.asset.assetKey,
      message: `remote Whiteboard token or state is unavailable: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair remote Whiteboard mapping'));
    return;
  }
  input.operations.push({
    kind: 'whiteboard-adopt',
    assetKey: input.asset.assetKey,
    locator: input.asset.locator,
    placementFingerprint,
    blockId: remote.remoteBlockId,
    whiteboardToken: remote.remoteToken,
    svgPath: input.asset.svgPath,
    svgHash: input.asset.svgHash,
    remoteStateHash: input.input.remoteStates.get(remote.remoteToken)!.hash
  });
  input.assets.push({
    assetKey: input.asset.assetKey,
    state: 'untracked',
    action: 'adopt existing whiteboard',
    local: 'changed',
    remote: 'untracked'
  });
}

function planTrackedAsset(input: {
  input: WhiteboardPlanningInput;
  asset: LocalWhiteboardAsset;
  receipt: WhiteboardReceiptEntry;
  blockers: WhiteboardPlanBlocker[];
  assets: WhiteboardAssetPlan[];
  operations: WhiteboardOperation[];
}): void {
  const remote = input.input.remoteDocument.nodes.find((node): node is SemanticAssetNode => {
    return node.kind === 'asset' &&
      node.representation === 'whiteboard' &&
      node.remoteBlockId === input.receipt.blockId &&
      node.remoteToken === input.receipt.whiteboardToken;
  });
  const remoteState = input.input.remoteStates.get(input.receipt.whiteboardToken);
  if (!remote || !remoteState) {
    input.blockers.push({
      code: 'missing-remote-whiteboard',
      assetKey: input.asset.assetKey,
      message: `tracked remote Whiteboard is missing: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair remote Whiteboard mapping'));
    return;
  }

  const localChanged = input.asset.svgHash !== input.receipt.svgHash;
  const remoteChanged = remoteState.hash !== input.receipt.remoteStateHash;
  const placementFingerprint = fingerprintFor(input.input.localDocument, input.asset.locator);
  if (!localChanged && !remoteChanged) {
    input.assets.push({
      assetKey: input.asset.assetKey,
      state: 'clean',
      action: 'no-op',
      local: 'unchanged',
      remote: 'unchanged'
    });
    return;
  }

  const confirmed = input.input.confirmedRemoteOverwrites.has(input.asset.assetKey);
  if (remoteChanged && !confirmed) {
    const conflict = localChanged;
    input.blockers.push({
      code: conflict ? 'whiteboard-conflict' : 'remote-whiteboard-changed',
      assetKey: input.asset.assetKey,
      message: conflict
        ? `local and remote Whiteboard changed: ${input.asset.assetKey}`
        : `remote Whiteboard changed: ${input.asset.assetKey}`
    });
    input.assets.push({
      assetKey: input.asset.assetKey,
      state: conflict ? 'conflict' : 'remote-changed',
      action: conflict ? 'resolve whiteboard conflict' : 'review remote whiteboard',
      local: localChanged ? 'changed' : 'unchanged',
      remote: 'changed'
    });
    return;
  }

  input.operations.push({
    kind: 'whiteboard-update',
    assetKey: input.asset.assetKey,
    locator: input.asset.locator,
    placementFingerprint,
    blockId: remote.remoteBlockId!,
    whiteboardToken: remote.remoteToken!,
    svgPath: input.asset.svgPath,
    svgHash: input.asset.svgHash,
    remoteStateHash: remoteState.hash,
    reason: remoteChanged ? 'confirmed-remote-overwrite' : 'local-changed'
  });
  input.assets.push({
    assetKey: input.asset.assetKey,
    state: localChanged && remoteChanged ? 'conflict' : localChanged ? 'local-changed' : 'remote-changed',
    action: 'update existing whiteboard',
    local: localChanged ? 'changed' : 'unchanged',
    remote: remoteChanged ? 'changed' : 'unchanged'
  });
}

function correspondingRemoteAssets(document: SemanticDocument, locator: SemanticLocator): SemanticAssetNode[] {
  return document.nodes.filter((node): node is SemanticAssetNode => {
    return node.kind === 'asset' && sameLocator(node.locator, locator);
  });
}

function hasMultipleUntrackedAssetSlots(input: WhiteboardPlanningInput, locator: SemanticLocator): boolean {
  const trackedLocalLocators = input.receiptEntries.flatMap((receipt) => {
    return input.localAssets
      .filter((asset) => asset.assetKey === receipt.assetKey)
      .map((asset) => asset.locator);
  });
  const localCount = input.localDocument.nodes.filter((node) => {
    return node.kind === 'asset' &&
      sameSection(node.locator.sectionPath, locator.sectionPath) &&
      !trackedLocalLocators.some((tracked) => sameLocator(tracked, node.locator));
  }).length;
  const remoteCount = input.remoteDocument.nodes.filter((node) => {
    return node.kind === 'asset' &&
      sameSection(node.locator.sectionPath, locator.sectionPath) &&
      !input.receiptEntries.some((receipt) => {
        return receipt.blockId === node.remoteBlockId && receipt.whiteboardToken === node.remoteToken;
      });
  }).length;
  return localCount > 1 || remoteCount > 1;
}

function sameSection(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function sameLocator(left: SemanticLocator, right: SemanticLocator): boolean {
  return left.kind === right.kind &&
    left.ordinal === right.ordinal &&
    left.sectionPath.length === right.sectionPath.length &&
    left.sectionPath.every((part, index) => part === right.sectionPath[index]);
}

function fingerprintFor(document: SemanticDocument, locator: SemanticLocator): string {
  const index = document.nodes.findIndex((node) => sameLocator(node.locator, locator));
  const previous = index > 0 ? identityFor(document.nodes[index - 1]) : undefined;
  const next = index >= 0 && index < document.nodes.length - 1 ? identityFor(document.nodes[index + 1]) : undefined;
  return semanticHash({ locator, previous, next });
}

function correspondenceFingerprintFor(document: SemanticDocument, locator: SemanticLocator): string {
  const index = document.nodes.findIndex((node) => sameLocator(node.locator, locator));
  const previous = index > 0 ? correspondenceIdentityFor(document.nodes[index - 1]) : undefined;
  const next = index >= 0 && index < document.nodes.length - 1
    ? correspondenceIdentityFor(document.nodes[index + 1])
    : undefined;
  return semanticHash({ locator, previous, next });
}

function identityFor(node: SemanticNode | undefined): unknown {
  if (!node) return undefined;
  return {
    kind: node.kind,
    locator: node.locator,
    ...(node.kind === 'text' ? { blockType: node.blockType } : {})
  };
}

function correspondenceIdentityFor(node: SemanticNode | undefined): unknown {
  if (!node) return undefined;
  if (node.kind === 'asset') return identityFor(node);
  return stripExecutionMetadata(node);
}

function missingAsset(assetKey: string, action: string): WhiteboardAssetPlan {
  return {
    assetKey,
    state: 'missing',
    action,
    local: 'unchanged',
    remote: 'missing'
  };
}
