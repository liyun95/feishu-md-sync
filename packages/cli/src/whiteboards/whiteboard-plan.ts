import type { WhiteboardReceiptEntry } from '../receipts/publish-receipt.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type { SemanticAssetNode, SemanticDocument, SemanticLocator, SemanticNode } from '../semantic/types.js';
import { normalizeAssetKey, type LocalWhiteboardAsset } from './local-assets.js';

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
    reason: 'local-changed' | 'confirmed-remote-overwrite' | 'confirmed-protected-overwrite';
  };

export type WhiteboardAssetPlan = {
  assetKey: string;
  state: WhiteboardAssetState;
  action: string;
  local: 'changed' | 'unchanged' | 'missing';
  remote: 'changed' | 'unchanged' | 'missing' | 'untracked';
  protection?: 'tracked';
  blockId?: string;
  whiteboardToken?: string;
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
  intent?: 'sync' | 'protect';
  localDocument: SemanticDocument;
  remoteDocument: SemanticDocument;
  localAssets: LocalWhiteboardAsset[];
  discoveryBlockers: Array<{ code: string; assetKey: string; message: string }>;
  receiptEntries: WhiteboardReceiptEntry[];
  remoteStates: ReadonlyMap<string, { hash: string }>;
  confirmedRemoteOverwrites: ReadonlySet<string>;
};

export function planWhiteboardPublish(input: WhiteboardPlanningInput): WhiteboardPlan {
  const intent = input.intent ?? 'sync';
  const blockers: WhiteboardPlanBlocker[] = [...input.discoveryBlockers];
  const operations: WhiteboardOperation[] = [];
  const receiptsByKey = new Map(input.receiptEntries.map((entry) => [entry.assetKey, entry]));
  const assets: WhiteboardAssetPlan[] = input.discoveryBlockers.map((blocker) => {
    return discoveryBlockedAsset(blocker, receiptsByKey.has(blocker.assetKey));
  });
  const localKeys = new Set([
    ...input.localAssets.map((asset) => asset.assetKey),
    ...input.discoveryBlockers.map((blocker) => blocker.assetKey)
  ]);

  for (const asset of input.localAssets) {
    if (blockers.some((blocker) => blocker.assetKey === asset.assetKey)) continue;
    const receipt = receiptsByKey.get(asset.assetKey);
    if (!receipt) {
      if (intent === 'protect') {
        planUntrackedProtectedAsset({ input, asset, blockers, assets });
      } else {
        planUntrackedAsset({ input, asset, blockers, assets, operations });
      }
      continue;
    }
    planTrackedAsset({ input, asset, receipt, intent, blockers, assets, operations });
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

function discoveryBlockedAsset(
  blocker: WhiteboardPlanningInput['discoveryBlockers'][number],
  tracked: boolean
): WhiteboardAssetPlan {
  if (blocker.code === 'invalid-svg') {
    return {
      assetKey: blocker.assetKey,
      state: 'local-changed',
      action: 'repair invalid Whiteboard SVG',
      local: 'changed',
      remote: tracked ? 'unchanged' : 'untracked'
    };
  }
  return {
    assetKey: blocker.assetKey,
    state: 'missing',
    action: 'repair local Whiteboard asset',
    local: 'missing',
    remote: tracked ? 'unchanged' : 'untracked'
  };
}

function planUntrackedProtectedAsset(input: {
  input: WhiteboardPlanningInput;
  asset: LocalWhiteboardAsset;
  blockers: WhiteboardPlanBlocker[];
  assets: WhiteboardAssetPlan[];
}): void {
  const candidates = correspondingRemoteAssets(input.input.remoteDocument, input.asset.locator)
    .filter((candidate) => candidate.representation === 'whiteboard');
  if (candidates.length === 0) return;
  input.blockers.push({
    code: 'tracked-whiteboard-receipt-missing',
    assetKey: input.asset.assetKey,
    message: `remote Whiteboard has no matching receipt identity: ${input.asset.assetKey}`
  });
  input.assets.push(missingAsset(input.asset.assetKey, 'restore or adopt the tracked Whiteboard receipt'));
}

function planUntrackedAsset(input: {
  input: WhiteboardPlanningInput;
  asset: LocalWhiteboardAsset;
  blockers: WhiteboardPlanBlocker[];
  assets: WhiteboardAssetPlan[];
  operations: WhiteboardOperation[];
}): void {
  if (input.asset.sourceKind === 'direct-svg') {
    planUntrackedProtectedAsset(input);
    return;
  }
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
  const placementFingerprint = whiteboardPlacementFingerprint(input.input.localDocument, input.asset.locator);
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
  intent: 'sync' | 'protect';
  blockers: WhiteboardPlanBlocker[];
  assets: WhiteboardAssetPlan[];
  operations: WhiteboardOperation[];
}): void {
  if (normalizeAssetKey(input.receipt.svgPath) !== input.asset.svgKey) {
    input.blockers.push({
      code: 'tracked-whiteboard-source-mismatch',
      assetKey: input.asset.assetKey,
      message: `tracked Whiteboard SVG path does not match the canonical source: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair the tracked Whiteboard source mapping'));
    return;
  }
  const remote = input.input.remoteDocument.nodes.find((node): node is SemanticAssetNode => {
    return node.kind === 'asset' &&
      node.representation === 'whiteboard' &&
      node.remoteBlockId === input.receipt.blockId &&
      node.remoteToken === input.receipt.whiteboardToken;
  });
  if (!remote) {
    input.blockers.push({
      code: input.intent === 'protect'
        ? 'tracked-whiteboard-identity-mismatch'
        : 'missing-remote-whiteboard',
      assetKey: input.asset.assetKey,
      message: input.intent === 'protect'
        ? `tracked remote Whiteboard block or token does not match the receipt: ${input.asset.assetKey}`
        : `tracked remote Whiteboard is missing: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair remote Whiteboard mapping'));
    return;
  }
  if (!sameLocator(remote.locator, input.asset.locator)) {
    input.blockers.push({
      code: 'tracked-whiteboard-placement-mismatch',
      assetKey: input.asset.assetKey,
      message: `tracked remote Whiteboard is not at the canonical asset position: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'restore the tracked Whiteboard placement'));
    return;
  }

  const localChanged = input.asset.svgHash !== input.receipt.svgHash;
  if (input.intent === 'protect') {
    if (localChanged) {
      input.blockers.push({
        code: 'protected-whiteboard-local-changed',
        assetKey: input.asset.assetKey,
        message: `tracked Whiteboard SVG changed; rerun with --sync-whiteboards and confirm this asset: ${input.asset.assetKey}`
      });
      input.assets.push({
        assetKey: input.asset.assetKey,
        state: 'local-changed',
        action: 'request explicit whiteboard sync confirmation',
        local: 'changed',
        remote: 'unchanged',
        protection: 'tracked',
        blockId: input.receipt.blockId,
        whiteboardToken: input.receipt.whiteboardToken
      });
      return;
    }
    input.assets.push({
      assetKey: input.asset.assetKey,
      state: 'clean',
      action: 'preserve tracked whiteboard',
      local: 'unchanged',
      remote: 'unchanged',
      protection: 'tracked',
      blockId: input.receipt.blockId,
      whiteboardToken: input.receipt.whiteboardToken
    });
    return;
  }

  const remoteState = input.input.remoteStates.get(input.receipt.whiteboardToken);
  if (!remoteState) {
    input.blockers.push({
      code: 'missing-remote-whiteboard',
      assetKey: input.asset.assetKey,
      message: `tracked remote Whiteboard state is unavailable: ${input.asset.assetKey}`
    });
    input.assets.push(missingAsset(input.asset.assetKey, 'repair remote Whiteboard mapping'));
    return;
  }
  const remoteChanged = remoteState.hash !== input.receipt.remoteStateHash;
  const placementFingerprint = whiteboardPlacementFingerprint(input.input.localDocument, input.asset.locator);
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
  if (input.asset.sourceKind === 'direct-svg' && localChanged && !confirmed) {
    input.blockers.push({
      code: 'protected-whiteboard-overwrite-confirmation-required',
      assetKey: input.asset.assetKey,
      message: `direct SVG update requires asset-specific Whiteboard confirmation: ${input.asset.assetKey}`
    });
    input.assets.push({
      assetKey: input.asset.assetKey,
      state: remoteChanged ? 'conflict' : 'local-changed',
      action: 'confirm protected whiteboard overwrite',
      local: 'changed',
      remote: remoteChanged ? 'changed' : 'unchanged',
      protection: 'tracked',
      blockId: input.receipt.blockId,
      whiteboardToken: input.receipt.whiteboardToken
    });
    return;
  }
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
    reason: input.asset.sourceKind === 'direct-svg'
      ? 'confirmed-protected-overwrite'
      : remoteChanged ? 'confirmed-remote-overwrite' : 'local-changed'
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

export function whiteboardPlacementFingerprint(
  document: SemanticDocument,
  locator: SemanticLocator
): string {
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
