import { readFile } from 'node:fs/promises';
import type { FeishuAdapter, RemoteMarkdown } from '../adapters/feishu-adapter.js';
import { canonicalMarkdown } from '../core/markdown-canonical.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  canUpgradeLegacyReceipt,
  hashText,
  readLocalBaseSnapshot,
  readPublishReceipt,
  whiteboardEntries,
  writeLocalBaseSnapshot,
  writePublishReceipt,
  type PublishReceipt,
  type PublishReceiptTarget,
  type WhiteboardReceiptEntry
} from '../receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot, writeRemoteSemanticSnapshot } from '../receipts/semantic-snapshot.js';
import { localSemanticDocument } from '../semantic/local-document.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type { SemanticDocument, SemanticLocator, SemanticNode, SemanticTable, SemanticTextBlock } from '../semantic/types.js';
import { discoverLocalWhiteboardAssets, normalizeAssetKey, type LocalWhiteboardAsset } from '../whiteboards/local-assets.js';
import { verifyWhiteboardReadback, whiteboardRemoteStateHash } from '../whiteboards/remote-state.js';
import {
  planWhiteboardPublish,
  type WhiteboardOperation,
  type WhiteboardPlan
} from '../whiteboards/whiteboard-plan.js';
import { findPageBlock } from './block-state.js';
import { PartialWriteError, type PublishWriteOperationSummary } from './partial-write-error.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';
import { applyPublishTransformForProfile } from './profile-transform.js';
import { planScopedPatch, type ScopedPatchOperation, type ScopedPatchPlan } from './scoped-patch-plan.js';
import { diffCorrespondingTable, findCorrespondingRemoteTable } from './table-diff.js';
import { renderTableXml } from './table-xml.js';
import { resolvePublishTitle } from './title.js';

export type RunPublishResult = {
  mode: 'dry-run' | 'write';
  plan: PublishPlan;
  document?: {
    documentId: string;
    url?: string;
  };
};

export type PublishAnalysis = {
  plan: PublishPlan;
  resolvedDocumentId: string;
  localSource: string;
  publishDraft: string;
  blockPatchDraft: string;
  remote: RemoteMarkdown;
  receipt: PublishReceipt | undefined;
  localCurrent?: SemanticDocument;
  remoteCurrent?: SemanticDocument;
  whiteboardPlan?: WhiteboardPlan;
  whiteboardAssets?: LocalWhiteboardAsset[];
};

export async function runPublish(input: {
  cwd: string;
  file: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  write: boolean;
  create: boolean;
  strategy: 'auto' | PublishStrategy;
  confirmDestructive: boolean;
  confirmCollaborationRisk?: boolean;
  confirmUntrackedRemote?: boolean;
  syncWhiteboards?: boolean;
  confirmedRemoteWhiteboardOverwrites?: string[];
  adapter: FeishuAdapter;
}): Promise<RunPublishResult> {
  if (input.write && input.strategy === 'document-replace' && !input.confirmDestructive) {
    throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
  }
  if (input.syncWhiteboards && input.create) {
    throw new Error('--sync-whiteboards is not supported with --create');
  }
  if (input.syncWhiteboards && input.strategy === 'document-replace') {
    throw new Error('--sync-whiteboards is not supported with --strategy document-replace');
  }

  const localSource = await readFile(input.file, 'utf8');
  const transform = applyPublishTransformForProfile(localSource, input.profile);
  if (input.target.kind === 'folder' || (input.target.kind === 'wiki' && input.create)) {
    return createPublish({ ...input, localSource, publishDraft: transform.markdown, transformWarnings: transform.warnings });
  }

  const analysis = await analyzeExistingPublish({
    cwd: input.cwd,
    file: input.file,
    target: input.target,
    profile: input.profile,
    strategy: input.strategy,
    adapter: input.adapter,
    localSource,
    syncWhiteboards: input.syncWhiteboards,
    confirmedRemoteWhiteboardOverwrites: input.confirmedRemoteWhiteboardOverwrites
  });
  if (!input.write) return { mode: 'dry-run', plan: analysis.plan };

  const { plan } = analysis;
  if (plan.strategy === 'blocked') {
    throw new Error(`Scoped publish is blocked: ${plan.risks.join('; ')}`);
  }

  if (plan.requiresUntrackedRemoteConfirmation && !input.confirmUntrackedRemote) {
    throw new Error('publish for an untracked remote requires --confirm-untracked-remote');
  }
  if (plan.requiresCollaborationRiskConfirmation && !input.confirmCollaborationRisk) {
    throw new Error('block-patch replacing or deleting existing blocks requires --confirm-collaboration-risk');
  }

  if (plan.strategy === 'no-op') {
    if (!analysis.remoteCurrent) throw new Error('No-op adoption requires a remote semantic snapshot.');
    const receiptInput = {
      cwd: input.cwd,
      target: input.target,
      resolvedDocumentId: analysis.resolvedDocumentId,
      profile: input.profile,
      localSource: analysis.localSource,
      localSourceHash: plan.localSourceHash,
      publishDraftHash: plan.publishDraftHash,
      remoteMarkdown: analysis.remote.markdown,
      remoteRevision: analysis.remote.revision,
      remoteSemantic: analysis.remoteCurrent
    };
    if (input.syncWhiteboards) {
      await recordPublishReceiptV3({ ...receiptInput, whiteboards: whiteboardEntries(analysis.receipt) });
    } else {
      await recordPublishReceiptV2(receiptInput);
    }
    return { mode: 'write', plan };
  }

  if (plan.strategy === 'block-patch') {
    if (!plan.scopedPatch) throw new Error('block-patch write is missing a scoped patch plan');
    if (!analysis.localCurrent) throw new Error('block-patch write is missing local semantic state');
    const completedOperations = await applyScopedPatch({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      plan: plan.scopedPatch
    });
    const verifiedWhiteboards = input.syncWhiteboards && plan.whiteboards
      ? await applyWhiteboardPlan({
        adapter: input.adapter,
        doc: analysis.resolvedDocumentId,
        plan: plan.whiteboards,
        assets: analysis.whiteboardAssets ?? [],
        previousEntries: whiteboardEntries(analysis.receipt),
        completedOperations
      })
      : [];
    const afterMarkdown = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    const afterSemantic = await fetchRemoteSemantic(input.adapter, analysis.resolvedDocumentId);
    const receiptInput = {
      cwd: input.cwd,
      target: input.target,
      resolvedDocumentId: analysis.resolvedDocumentId,
      profile: input.profile,
      localSource: analysis.localSource,
      localSourceHash: plan.localSourceHash,
      publishDraftHash: plan.publishDraftHash,
      remoteMarkdown: afterMarkdown.markdown,
      remoteRevision: afterMarkdown.revision,
      remoteSemantic: afterSemantic
    };
    if (input.syncWhiteboards) {
      await recordPublishReceiptV3({ ...receiptInput, whiteboards: verifiedWhiteboards });
    } else {
      await recordPublishReceiptV2(receiptInput);
    }
    return { mode: 'write', plan };
  }

  if (plan.strategy === 'document-replace') {
    if (input.strategy !== 'document-replace') {
      throw new Error('document-replace requires --strategy document-replace');
    }
    await input.adapter.replaceDocument({ doc: analysis.resolvedDocumentId, markdown: analysis.publishDraft });
    const after = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    let afterSemantic: SemanticDocument | undefined;
    if (input.adapter.fetchDocBlocks) {
      try {
        afterSemantic = await fetchRemoteSemantic(input.adapter, analysis.resolvedDocumentId);
      } catch {
        afterSemantic = undefined;
      }
    }
    if (afterSemantic) {
      await recordPublishReceiptV2({
        cwd: input.cwd,
        target: input.target,
        resolvedDocumentId: analysis.resolvedDocumentId,
        profile: input.profile,
        localSource: analysis.localSource,
        localSourceHash: plan.localSourceHash,
        publishDraftHash: plan.publishDraftHash,
        remoteMarkdown: after.markdown,
        remoteRevision: after.revision,
        remoteSemantic: afterSemantic
      });
    } else {
      await recordLegacyReceipt({
        cwd: input.cwd,
        target: input.target,
        profile: input.profile,
        localSource: analysis.localSource,
        localSourceHash: plan.localSourceHash,
        publishDraftHash: plan.publishDraftHash,
        remoteMarkdown: after.markdown,
        remoteRevision: after.revision
      });
    }
    return { mode: 'write', plan };
  }

  throw new Error(`Write strategy ${plan.strategy} is not implemented.`);
}

export async function analyzeExistingPublish(input: {
  cwd: string;
  file: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  strategy: 'auto' | PublishStrategy;
  adapter: FeishuAdapter;
  localSource?: string;
  syncWhiteboards?: boolean;
  confirmedRemoteWhiteboardOverwrites?: string[];
}): Promise<PublishAnalysis> {
  const localSource = input.localSource ?? await readFile(input.file, 'utf8');
  const transform = applyPublishTransformForProfile(localSource, input.profile);
  const resolvedDocumentId = input.adapter.resolveDocumentId
    ? await input.adapter.resolveDocumentId({ target: input.target })
    : input.target.token;
  const remote = await input.adapter.fetchDocMarkdown({ doc: resolvedDocumentId });
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
  const blockPatchDraft = markdownBodyForBlockPatch(transform.markdown, remote.markdown);

  if (input.strategy === 'document-replace') {
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: transform.warnings,
        forceDocumentReplace: true
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      blockPatchDraft,
      remote,
      receipt
    };
  }

  if (!input.adapter.fetchDocBlocks) {
    const whiteboards = input.syncWhiteboards
      ? blockedWhiteboardPlan('whiteboard-adapter-unavailable', 'Whiteboard planning requires Docx block reads.')
      : undefined;
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, 'block-patch planning unavailable: adapter cannot fetch Docx blocks'],
        whiteboards
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      blockPatchDraft,
      remote,
      receipt,
      whiteboardPlan: whiteboards
    };
  }

  let remoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>;
  try {
    remoteBlocks = await input.adapter.fetchDocBlocks({ doc: resolvedDocumentId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const whiteboards = input.syncWhiteboards
      ? blockedWhiteboardPlan('whiteboard-adapter-unavailable', `Whiteboard planning requires Docx block reads: ${message}`)
      : undefined;
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, `block-patch planning unavailable: ${message}`],
        whiteboards
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      blockPatchDraft,
      remote,
      receipt,
      whiteboardPlan: whiteboards
    };
  }
  const page = findPageBlock(remoteBlocks.blocks, resolvedDocumentId);
  const localCurrent = localSemanticDocument(blockPatchDraft);
  const remoteCurrent = remoteSemanticDocument(remoteBlocks.blocks, resolvedDocumentId);
  const baseline = await loadSemanticBaselines({
    cwd: input.cwd,
    receipt,
    profile: input.profile,
    currentLocalSource: localSource,
    currentRemoteMarkdown: remote.markdown,
    currentRemoteSemantic: remoteCurrent
  });
  const scopedPatch = baseline.blocker
    ? blockedScopedPatch(baseline.blocker)
    : planScopedPatch({
      parentBlockId: page.block_id,
      localBase: baseline.localBase,
      localCurrent,
      remoteBase: baseline.remoteBase,
      remoteCurrent,
      tracked: Boolean(receipt)
    });
  const whiteboardAnalysis: { plan?: WhiteboardPlan; assets?: LocalWhiteboardAsset[] } = input.syncWhiteboards
    ? await analyzeWhiteboards({
      file: input.file,
      localSource,
      localCurrent,
      remoteCurrent,
      receipt,
      adapter: input.adapter,
      confirmedRemoteWhiteboardOverwrites: input.confirmedRemoteWhiteboardOverwrites ?? []
    })
    : {};
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: transform.warnings,
    scopedPatch,
    whiteboards: whiteboardAnalysis.plan
  });
  return {
    plan,
    resolvedDocumentId,
    localSource,
    publishDraft: transform.markdown,
    blockPatchDraft,
    remote,
    receipt,
    localCurrent,
    remoteCurrent,
    whiteboardPlan: whiteboardAnalysis.plan,
    whiteboardAssets: whiteboardAnalysis.assets
  };
}

async function analyzeWhiteboards(input: {
  file: string;
  localSource: string;
  localCurrent: SemanticDocument;
  remoteCurrent: SemanticDocument;
  receipt: PublishReceipt | undefined;
  adapter: FeishuAdapter;
  confirmedRemoteWhiteboardOverwrites: string[];
}): Promise<{ plan: WhiteboardPlan; assets: LocalWhiteboardAsset[] }> {
  if (!input.adapter.queryWhiteboard || !input.adapter.updateWhiteboard || !input.adapter.replaceImageWithWhiteboard) {
    return {
      plan: blockedWhiteboardPlan(
        'whiteboard-adapter-unavailable',
        'Configured Feishu adapter does not support Whiteboard create/query/update.'
      ),
      assets: []
    };
  }

  const tracked = whiteboardEntries(input.receipt);
  const discovery = await discoverLocalWhiteboardAssets({
    sourcePath: input.file,
    markdown: input.localSource,
    document: input.localCurrent,
    tracked
  });
  const localLocators = new Set(discovery.assets.map((asset) => locatorKey(asset.locator)));
  const tokens = new Set([
    ...tracked.map((entry) => entry.whiteboardToken),
    ...input.remoteCurrent.nodes.flatMap((node) => {
      return node.kind === 'asset' &&
        node.representation === 'whiteboard' &&
        node.remoteToken &&
        localLocators.has(locatorKey(node.locator))
        ? [node.remoteToken]
        : [];
    })
  ]);
  const remoteStates = new Map<string, { hash: string }>();
  const queryBlockers: Array<{ code: string; assetKey: string; message: string }> = [];
  for (const token of tokens) {
    try {
      const remote = await input.adapter.queryWhiteboard({ whiteboardToken: token });
      remoteStates.set(token, { hash: whiteboardRemoteStateHash(remote.raw) });
    } catch (error) {
      const related = tracked.find((entry) => entry.whiteboardToken === token)?.assetKey ?? '<untracked-whiteboard>';
      queryBlockers.push({
        code: 'remote-whiteboard-query-failed',
        assetKey: related,
        message: `failed to query remote Whiteboard ${token}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return {
    plan: planWhiteboardPublish({
      localDocument: input.localCurrent,
      remoteDocument: input.remoteCurrent,
      localAssets: discovery.assets,
      discoveryBlockers: [...discovery.blockers, ...queryBlockers],
      receiptEntries: tracked,
      remoteStates,
      confirmedRemoteOverwrites: new Set(input.confirmedRemoteWhiteboardOverwrites.map(normalizeAssetKey))
    }),
    assets: discovery.assets
  };
}

function blockedWhiteboardPlan(code: string, message: string): WhiteboardPlan {
  return {
    kind: 'whiteboard-plan',
    safeToWrite: false,
    assets: [],
    operations: [],
    blockers: [{ code, assetKey: '<whiteboard>', message }],
    warnings: [],
    requiresCollaborationRiskConfirmation: false,
    requiresUntrackedRemoteConfirmation: false
  };
}

async function createPublish(input: {
  cwd: string;
  file: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  write: boolean;
  adapter: FeishuAdapter;
  localSource: string;
  publishDraft: string;
  transformWarnings: string[];
}): Promise<RunPublishResult> {
  const title = resolvePublishTitle({ sourcePath: input.file, markdown: input.publishDraft }).title;
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource: input.localSource,
    publishDraft: input.publishDraft,
    remoteMarkdown: '',
    receipt: undefined,
    transformWarnings: input.transformWarnings,
    createDocument: true
  });
  if (!input.write) return { mode: 'dry-run', plan };

  const created = await input.adapter.createDocument({
    title,
    markdown: input.publishDraft,
    parentToken: input.target.token
  });
  const createdTarget = { kind: 'docx' as const, token: created.documentId };
  const after = await input.adapter.fetchDocMarkdown({ doc: created.documentId });
  if (input.adapter.fetchDocBlocks) {
    const semantic = await fetchRemoteSemantic(input.adapter, created.documentId);
    await recordPublishReceiptV2({
      cwd: input.cwd,
      target: createdTarget,
      resolvedDocumentId: created.documentId,
      profile: input.profile,
      localSource: input.localSource,
      localSourceHash: plan.localSourceHash,
      publishDraftHash: plan.publishDraftHash,
      remoteMarkdown: after.markdown,
      remoteRevision: after.revision ?? created.revision,
      remoteSemantic: semantic
    });
  } else {
    await recordLegacyReceipt({
      cwd: input.cwd,
      target: createdTarget,
      profile: input.profile,
      localSource: input.localSource,
      localSourceHash: plan.localSourceHash,
      publishDraftHash: plan.publishDraftHash,
      remoteMarkdown: after.markdown,
      remoteRevision: after.revision ?? created.revision
    });
  }
  return {
    mode: 'write',
    plan,
    document: { documentId: created.documentId, url: created.url }
  };
}

async function loadSemanticBaselines(input: {
  cwd: string;
  receipt: PublishReceipt | undefined;
  profile: PublishProfileName;
  currentLocalSource: string;
  currentRemoteMarkdown: string;
  currentRemoteSemantic: SemanticDocument;
}): Promise<{ localBase?: SemanticDocument; remoteBase?: SemanticDocument; blocker?: string }> {
  if (!input.receipt) return {};

  let localBaseSource = input.receipt.localBaseSnapshot
    ? await readLocalBaseSnapshot({ cwd: input.cwd, snapshot: input.receipt.localBaseSnapshot })
    : undefined;
  if (!localBaseSource && input.receipt.localSourceHash === hashText(input.currentLocalSource)) {
    localBaseSource = input.currentLocalSource;
  }
  if (!localBaseSource) return { blocker: 'legacy local baseline unavailable' };

  const localBaseDraft = applyPublishTransformForProfile(localBaseSource, input.profile).markdown;
  const localBase = localSemanticDocument(markdownBodyForBlockPatch(localBaseDraft, input.currentRemoteMarkdown));
  if (input.receipt.version === 2 || input.receipt.version === 3) {
    const remoteBase = await readRemoteSemanticSnapshot({
      cwd: input.cwd,
      snapshot: input.receipt.remoteSemanticSnapshot
    });
    if (!remoteBase) return { blocker: 'remote semantic baseline unavailable' };
    return { localBase, remoteBase };
  }

  if (!canUpgradeLegacyReceipt({ receipt: input.receipt, currentRemoteMarkdown: input.currentRemoteMarkdown })) {
    return { blocker: 'legacy remote baseline changed; cannot migrate safely' };
  }
  return { localBase, remoteBase: stripExecutionMetadata(input.currentRemoteSemantic) };
}

function blockedScopedPatch(message: string): ScopedPatchPlan {
  return {
    kind: 'scoped-patch-plan',
    safeToWrite: false,
    operations: [],
    blockers: [{ code: 'remote-scope-conflict', message }],
    warnings: [],
    requiresCollaborationRiskConfirmation: false,
    scopeSummary: {
      localChanged: [],
      remoteChanged: [],
      overlappingConflicts: [],
      unrelatedRemoteChanges: []
    }
  };
}

async function applyScopedPatch(input: {
  adapter: FeishuAdapter;
  doc: string;
  plan: ScopedPatchPlan;
}): Promise<PublishWriteOperationSummary[]> {
  if (!input.adapter.replaceBlock || !input.adapter.insertBlocksAfter || !input.adapter.deleteBlocks || !input.adapter.fetchDocBlocks) {
    throw new Error('Configured Feishu adapter does not support scoped block-patch writes');
  }
  const completed: ScopedPatchOperation[] = [];
  for (const operation of input.plan.operations) {
    try {
      if (operation.kind === 'update') {
        await input.adapter.replaceBlock({
          doc: input.doc,
          blockId: operation.remoteBlockId,
          content: operation.desiredMarkdown,
          format: 'markdown'
        });
      } else if (operation.kind === 'create') {
        await input.adapter.insertBlocksAfter({
          doc: input.doc,
          blockId: operation.insertAfterBlockId,
          markdown: operation.desiredMarkdown
        });
      } else if (operation.kind === 'delete') {
        await input.adapter.deleteBlocks({ doc: input.doc, blockIds: operation.blockIds });
      } else {
        await input.adapter.replaceBlock({
          doc: input.doc,
          blockId: operation.remoteBlockId,
          content: renderTableXml(operation.desiredTable),
          format: 'xml'
        });
      }
      const blocks = await input.adapter.fetchDocBlocks({ doc: input.doc });
      verifyOperation(operation, blocks.blocks, input.doc);
      completed.push(operation);
    } catch (error) {
      if (completed.length === 0) throw error;
      throw new PartialWriteError({ completedOperations: completed, failedOperation: operation, cause: error });
    }
  }
  return completed;
}

async function applyWhiteboardPlan(input: {
  adapter: FeishuAdapter;
  doc: string;
  plan: WhiteboardPlan;
  assets: LocalWhiteboardAsset[];
  previousEntries: WhiteboardReceiptEntry[];
  completedOperations: PublishWriteOperationSummary[];
}): Promise<WhiteboardReceiptEntry[]> {
  const replaceImageWithWhiteboard = input.adapter.replaceImageWithWhiteboard?.bind(input.adapter);
  const queryWhiteboard = input.adapter.queryWhiteboard?.bind(input.adapter);
  const updateWhiteboard = input.adapter.updateWhiteboard?.bind(input.adapter);
  const fetchDocBlocks = input.adapter.fetchDocBlocks?.bind(input.adapter);
  if (!replaceImageWithWhiteboard || !queryWhiteboard || !updateWhiteboard || !fetchDocBlocks) {
    throw new Error('Configured Feishu adapter does not support verified Whiteboard writes.');
  }

  const localByKey = new Map(input.assets.map((asset) => [asset.assetKey, asset]));
  const entries = new Map(input.previousEntries.map((entry) => [entry.assetKey, entry]));
  const completed = [...input.completedOperations];
  for (const operation of input.plan.operations) {
    const summary = summarizeWhiteboardOperation(operation);
    try {
      const asset = localByKey.get(operation.assetKey);
      if (!asset) throw new Error(`local Whiteboard asset unavailable during write: ${operation.assetKey}`);

      let blockId: string;
      let whiteboardToken: string;
      if (operation.kind === 'whiteboard-create') {
        const created = await replaceImageWithWhiteboard({
          doc: input.doc,
          blockId: operation.remoteImageBlockId,
          svg: asset.svgSource
        });
        blockId = created.blockId;
        whiteboardToken = created.whiteboardToken;
      } else {
        blockId = operation.blockId;
        whiteboardToken = operation.whiteboardToken;
        await updateWhiteboard({
          whiteboardToken,
          svg: asset.svgSource,
          idempotencyToken: `fms-${semanticHash({
            whiteboardToken,
            svgHash: asset.svgHash,
            remoteStateHash: operation.remoteStateHash
          }).slice(0, 32)}`
        });
      }

      const remote = await queryWhiteboard({ whiteboardToken });
      verifyWhiteboardReadback({ raw: remote.raw, expectedTexts: asset.expectedTexts });
      const blocks = await fetchDocBlocks({ doc: input.doc });
      verifyWhiteboardIdentity(blocks.blocks, input.doc, blockId, whiteboardToken);
      entries.set(operation.assetKey, {
        assetKey: operation.assetKey,
        pngPath: operation.assetKey,
        svgPath: operation.assetKey.replace(/\.png$/i, '.svg'),
        svgHash: asset.svgHash,
        whiteboardToken,
        blockId,
        remoteStateHash: whiteboardRemoteStateHash(remote.raw),
        placementFingerprint: operation.placementFingerprint
      });
      completed.push(summary);
    } catch (error) {
      throw new PartialWriteError({
        completedOperations: completed,
        failedOperation: summary,
        cause: error
      });
    }
  }
  return [...entries.values()].sort((left, right) => left.assetKey.localeCompare(right.assetKey));
}

function summarizeWhiteboardOperation(operation: WhiteboardOperation): PublishWriteOperationSummary {
  return {
    kind: operation.kind,
    locator: operation.locator,
    assetKey: operation.assetKey
  };
}

function verifyWhiteboardIdentity(
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  blockId: string,
  whiteboardToken: string
): void {
  const remote = remoteSemanticDocument(blocks, documentId);
  const matched = remote.nodes.some((node) => {
    return node.kind === 'asset' &&
      node.representation === 'whiteboard' &&
      node.remoteBlockId === blockId &&
      node.remoteToken === whiteboardToken;
  });
  if (!matched) {
    throw new Error('Whiteboard readback identity does not match the created or tracked block.');
  }
}

function verifyOperation(operation: ScopedPatchOperation, blocks: import('../feishu/types.js').FeishuBlock[], documentId: string): void {
  if (operation.kind === 'delete') {
    const remaining = new Set(blocks.flatMap((block) => block.block_id ? [block.block_id] : []));
    if (operation.blockIds.some((blockId) => remaining.has(blockId))) {
      throw new Error('scoped readback verification failed: deleted block still exists');
    }
    return;
  }

  const remote = remoteSemanticDocument(blocks, documentId);
  if (operation.kind === 'table-replace') {
    const match = findCorrespondingRemoteTable(operation.desiredTable, remote);
    if (!match.table) throw new Error(`scoped readback verification failed: ${match.blocker}`);
    const diff = diffCorrespondingTable(match.table, operation.desiredTable);
    if (diff.blockers.length > 0 || diff.additions.length > 0 || diff.updates.length > 0) {
      throw new Error('scoped readback verification failed: remote table differs from desired table');
    }
    return;
  }

  const candidates = remote.nodes.filter((node): node is SemanticTextBlock => {
    return node.kind === 'text' && sameSection(node.locator, operation.locator);
  });
  if (!candidates.some((node) => canonicalMarkdown(node.markdown) === canonicalMarkdown(operation.desiredMarkdown))) {
    throw new Error('scoped readback verification failed: remote text differs from desired text');
  }
}

function sameSection(left: SemanticLocator, right: SemanticLocator): boolean {
  return left.sectionPath.length === right.sectionPath.length &&
    left.sectionPath.every((part, index) => part === right.sectionPath[index]);
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

async function fetchRemoteSemantic(adapter: FeishuAdapter, documentId: string): Promise<SemanticDocument> {
  if (!adapter.fetchDocBlocks) throw new Error('Configured Feishu adapter cannot fetch Docx blocks.');
  const blocks = await adapter.fetchDocBlocks({ doc: documentId });
  return remoteSemanticDocument(blocks.blocks, documentId);
}

async function recordPublishReceiptV2(input: {
  cwd: string;
  target: PublishReceiptTarget;
  resolvedDocumentId: string;
  profile: PublishProfileName;
  localSource: string;
  localSourceHash: string;
  publishDraftHash: string;
  remoteMarkdown: string;
  remoteRevision?: string;
  remoteSemantic: SemanticDocument;
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.localSource
  });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: input.cwd,
    target: input.target,
    document: input.remoteSemantic
  });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 2,
      target: input.target,
      resolvedDocumentId: input.resolvedDocumentId,
      profile: input.profile,
      localSourceHash: input.localSourceHash,
      publishDraftHash: input.publishDraftHash,
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      remoteRevision: input.remoteRevision,
      localBaseSnapshot,
      remoteSemanticSnapshot,
      updatedAt: new Date().toISOString()
    }
  });
}

async function recordPublishReceiptV3(input: {
  cwd: string;
  target: PublishReceiptTarget;
  resolvedDocumentId: string;
  profile: PublishProfileName;
  localSource: string;
  localSourceHash: string;
  publishDraftHash: string;
  remoteMarkdown: string;
  remoteRevision?: string;
  remoteSemantic: SemanticDocument;
  whiteboards: WhiteboardReceiptEntry[];
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.localSource
  });
  const remoteSemanticSnapshot = await writeRemoteSemanticSnapshot({
    cwd: input.cwd,
    target: input.target,
    document: input.remoteSemantic
  });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 3,
      target: input.target,
      resolvedDocumentId: input.resolvedDocumentId,
      profile: input.profile,
      localSourceHash: input.localSourceHash,
      publishDraftHash: input.publishDraftHash,
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      remoteRevision: input.remoteRevision,
      localBaseSnapshot,
      remoteSemanticSnapshot,
      whiteboards: input.whiteboards,
      updatedAt: new Date().toISOString()
    }
  });
}

async function recordLegacyReceipt(input: {
  cwd: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSource: string;
  localSourceHash: string;
  publishDraftHash: string;
  remoteMarkdown: string;
  remoteRevision?: string;
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({ cwd: input.cwd, target: input.target, markdown: input.localSource });
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 1,
      target: input.target,
      profile: input.profile,
      localSourceHash: input.localSourceHash,
      publishDraftHash: input.publishDraftHash,
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      remoteRevision: input.remoteRevision,
      localBaseSnapshot,
      updatedAt: new Date().toISOString()
    }
  });
}

function markdownBodyForBlockPatch(publishDraft: string, remoteMarkdown: string): string {
  const publishTitle = leadingH1Title(publishDraft);
  if (!publishTitle) return publishDraft;
  const remoteTitle = leadingH1Title(remoteMarkdown);
  if (remoteTitle !== publishTitle) return publishDraft;
  return stripLeadingH1(publishDraft);
}

function leadingH1Title(markdown: string): string | undefined {
  const { body } = splitLeadingFrontmatter(markdown);
  const match = body.match(/^#\s+(.+?)(?:\n|$)/);
  return match?.[1]?.trim();
}

function stripLeadingH1(markdown: string): string {
  const { frontmatter, body } = splitLeadingFrontmatter(markdown);
  const stripped = body
    .replace(/^#\s+.+?(?:\n{1,2}|$)/, '')
    .trimStart();
  return frontmatter ? `${frontmatter}\n${stripped}` : stripped;
}

function splitLeadingFrontmatter(markdown: string): { frontmatter?: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, '\n').trimStart();
  const match = normalized.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  if (!match) return { body: normalized };
  return {
    frontmatter: match[0].trimEnd(),
    body: normalized.slice(match[0].length).trimStart()
  };
}

function semanticNodeHash(node: SemanticNode): string {
  return semanticHash(stripExecutionMetadata(node));
}
