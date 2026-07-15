import { confirmationRequired, validationFailure } from '../core/cli-failure.js';
import type { FeishuAdapter, RemoteMarkdown, RemoteWhiteboard } from '../adapters/feishu-adapter.js';
import { renderCodeBlockXml } from '../code-blocks/code-xml.js';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import type {
  CodeBlockOperation,
  CodeSectionReconcileOperation
} from '../code-blocks/code-plan.js';
import { renderCalloutXml } from '../callouts/callout-xml.js';
import { applyTrackedCalloutTypes, calloutTypeHints } from '../callouts/callout-baseline.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import { canonicalMarkdown } from '../core/markdown-canonical.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { DialectName } from '../dialects/types.js';
import type { DialectWorkspaceConfig } from '../link-resolvers/types.js';
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
import type {
  SemanticCodeBlock,
  SemanticDocument,
  SemanticLocator,
  SemanticNode,
  SemanticTable,
  SemanticTextBlock
} from '../semantic/types.js';
import { discoverLocalWhiteboardAssets, normalizeAssetKey, type LocalWhiteboardAsset } from '../whiteboards/local-assets.js';
import { verifyWhiteboardReadback, whiteboardRemoteStateHash } from '../whiteboards/remote-state.js';
import {
  planWhiteboardPublish,
  type WhiteboardOperation,
  type WhiteboardPlan
} from '../whiteboards/whiteboard-plan.js';
import { findPageBlock, renderableDirectChildBlocks } from './block-state.js';
import { PartialWriteError, type PublishWriteOperationSummary } from './partial-write-error.js';
import type { CalloutOperation } from './callout-plan.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';
import { buildPublishContext, type PublishContext } from './publish-context.js';
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

const WHITEBOARD_READBACK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000];

export type PublishAnalysis = {
  plan: PublishPlan;
  resolvedDocumentId: string;
  localSource: string;
  publishDraft: string;
  publishContext: PublishContext;
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
  dialect?: DialectName;
  dialectConfig?: DialectWorkspaceConfig;
  write: boolean;
  create: boolean;
  strategy: 'auto' | PublishStrategy;
  confirmDestructive: boolean;
  confirmCollaborationRisk?: boolean;
  confirmUntrackedRemote?: boolean;
  syncWhiteboards?: boolean;
  confirmedRemoteWhiteboardOverwrites?: string[];
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<RunPublishResult> {
  if (input.write && input.strategy === 'document-replace' && !input.confirmDestructive) {
    throw confirmationRequired({
      subtype: 'destructive_write',
      message: 'document-replace requires --confirm-destructive in non-interactive mode',
      hint: 'review the document-replace dry-run and obtain explicit approval',
      requiredFlags: ['--confirm-destructive']
    });
  }
  if (input.syncWhiteboards && input.create) {
    throw validationFailure({ message: '--sync-whiteboards is not supported with --create' });
  }
  if (input.syncWhiteboards && input.strategy === 'document-replace') {
    throw validationFailure({ message: '--sync-whiteboards is not supported with --strategy document-replace' });
  }

  const publishContext = await buildPublishContext({
    cwd: input.cwd,
    sourcePath: input.file,
    dialect: input.dialect ?? 'gfm',
    dialectConfig: input.dialectConfig ?? {},
    profile: input.profile,
    adapter: input.adapter
  });
  if (publishContext.dialectBlockers.length > 0) {
    const plan = buildPublishPlan({
      target: input.target,
      profile: input.profile,
      ...publishPlanDialectFields(publishContext),
      localSource: publishContext.localSource,
      publishDraft: publishContext.publishDraft,
      remoteMarkdown: '',
      receipt: undefined,
      transformWarnings: publishContext.transformWarnings,
      createDocument: input.target.kind === 'folder' || input.create
    });
    if (input.write) throw new Error(`Scoped publish is blocked: ${plan.risks.join('; ')}`);
    return { mode: 'dry-run', plan };
  }
  if (input.target.kind === 'folder' || (input.target.kind === 'wiki' && input.create)) {
    return createPublish({ ...input, publishContext });
  }

  const analysis = await analyzeExistingPublish({
    cwd: input.cwd,
    file: input.file,
    target: input.target,
    profile: input.profile,
    strategy: input.strategy,
    adapter: input.adapter,
    publishContext,
    syncWhiteboards: input.syncWhiteboards,
    callouts: input.callouts,
    codeBlocks: input.codeBlocks,
    confirmedRemoteWhiteboardOverwrites: input.confirmedRemoteWhiteboardOverwrites
  });
  if (!input.write) return { mode: 'dry-run', plan: analysis.plan };

  const { plan } = analysis;
  if (plan.strategy === 'blocked') {
    throw new Error(`Scoped publish is blocked: ${plan.risks.join('; ')}`);
  }

  if (plan.requiresUntrackedRemoteConfirmation && !input.confirmUntrackedRemote) {
    throw confirmationRequired({
      subtype: 'untracked_remote',
      message: 'publish for an untracked remote requires --confirm-untracked-remote',
      hint: 'review the dry-run and confirm that this workspace should adopt the existing remote document',
      requiredFlags: ['--confirm-untracked-remote']
    });
  }
  if (plan.requiresCollaborationRiskConfirmation && !input.confirmCollaborationRisk) {
    throw confirmationRequired({
      subtype: 'collaboration_risk',
      message: 'block-patch replacing or deleting existing blocks requires --confirm-collaboration-risk',
      hint: 'review the affected blocks and obtain explicit approval for the collaboration risk',
      requiredFlags: ['--confirm-collaboration-risk']
    });
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
    const phases = partitionScopedOperations(plan.scopedPatch.operations);
    const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
    let completedOperations = await applyScopedOperations({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      operations: [...phases.updates, ...phases.creates, ...phases.moves, ...phases.tables],
      callouts,
      pendingAfter: [
        ...(plan.whiteboards?.operations ?? []).map(summarizeWhiteboardOperation),
        ...phases.deletes.map(summarizeScopedOperation)
      ]
    });
    const whiteboardResult = input.syncWhiteboards && plan.whiteboards
      ? await applyWhiteboardPlan({
        adapter: input.adapter,
        doc: analysis.resolvedDocumentId,
        plan: plan.whiteboards,
        assets: analysis.whiteboardAssets ?? [],
        previousEntries: whiteboardEntries(analysis.receipt),
        completedOperations,
        pendingAfter: phases.deletes.map(summarizeScopedOperation)
      })
      : { entries: [] as WhiteboardReceiptEntry[], completedOperations };
    completedOperations = whiteboardResult.completedOperations;
    completedOperations = await applyScopedOperations({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      operations: phases.deletes,
      callouts,
      completedOperations
    });
    const afterMarkdownRaw = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    const afterSemantic = applyTrackedCalloutTypes(
      await fetchRemoteSemantic(input.adapter, analysis.resolvedDocumentId, callouts),
      analysis.remoteCurrent
    );
    const afterCanonical = canonicalizeRemoteCalloutMarkdown({
      markdown: afterMarkdownRaw.markdown,
      config: callouts,
      typeHints: calloutTypeHints(afterSemantic)
    });
    const afterMarkdown = { ...afterMarkdownRaw, markdown: afterCanonical.markdown };
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
      await recordPublishReceiptV3({ ...receiptInput, whiteboards: whiteboardResult.entries });
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
    const afterRaw = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    let afterSemantic: SemanticDocument | undefined;
    if (input.adapter.fetchDocBlocks) {
      try {
        afterSemantic = await fetchRemoteSemantic(
          input.adapter,
          analysis.resolvedDocumentId,
          input.callouts ?? DEFAULT_CALLOUT_CONFIG
        );
      } catch {
        afterSemantic = undefined;
      }
    }
    if (afterSemantic) {
      const normalized = canonicalizeRemoteCalloutMarkdown({
        markdown: afterRaw.markdown,
        config: input.callouts ?? DEFAULT_CALLOUT_CONFIG,
        typeHints: calloutTypeHints(afterSemantic)
      });
      const after = { ...afterRaw, markdown: normalized.markdown };
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
      const normalized = canonicalizeRemoteCalloutMarkdown({
        markdown: afterRaw.markdown,
        config: input.callouts ?? DEFAULT_CALLOUT_CONFIG
      });
      const after = { ...afterRaw, markdown: normalized.markdown };
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
  dialect?: DialectName;
  dialectConfig?: DialectWorkspaceConfig;
  strategy: 'auto' | PublishStrategy;
  adapter: FeishuAdapter;
  localSource?: string;
  publishContext?: PublishContext;
  syncWhiteboards?: boolean;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  confirmedRemoteWhiteboardOverwrites?: string[];
}): Promise<PublishAnalysis> {
  const publishContext = input.publishContext ?? await buildPublishContext({
    cwd: input.cwd,
    sourcePath: input.file,
    localSource: input.localSource,
    dialect: input.dialect ?? 'gfm',
    dialectConfig: input.dialectConfig ?? {},
    profile: input.profile,
    adapter: input.adapter
  });
  const localSource = publishContext.localSource;
  const transform = {
    markdown: publishContext.publishDraft,
    warnings: publishContext.transformWarnings
  };
  const resolvedDocumentId = input.adapter.resolveDocumentId
    ? await withRateLimitRetry(() => input.adapter.resolveDocumentId!({ target: input.target }))
    : input.target.token;
  const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
  const remoteRaw = await withRateLimitRetry(() => input.adapter.fetchDocMarkdown({ doc: resolvedDocumentId }));
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });

  if (input.strategy === 'document-replace') {
    const normalized = canonicalizeRemoteCalloutMarkdown({ markdown: remoteRaw.markdown, config: callouts });
    const remote = { ...remoteRaw, markdown: normalized.markdown };
    const blockPatchDraft = markdownBodyForBlockPatch(transform.markdown, remote.markdown);
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        ...publishPlanDialectFields(publishContext),
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, ...normalized.warnings],
        forceDocumentReplace: true
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      publishContext,
      blockPatchDraft,
      remote,
      receipt
    };
  }

  if (!input.adapter.fetchDocBlocks) {
    const normalized = canonicalizeRemoteCalloutMarkdown({ markdown: remoteRaw.markdown, config: callouts });
    const remote = { ...remoteRaw, markdown: normalized.markdown };
    const blockPatchDraft = markdownBodyForBlockPatch(transform.markdown, remote.markdown);
    const whiteboards = input.syncWhiteboards
      ? blockedWhiteboardPlan('whiteboard-adapter-unavailable', 'Whiteboard planning requires Docx block reads.')
      : undefined;
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        ...publishPlanDialectFields(publishContext),
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, ...normalized.warnings, 'block-patch planning unavailable: adapter cannot fetch Docx blocks'],
        whiteboards
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      publishContext,
      blockPatchDraft,
      remote,
      receipt,
      whiteboardPlan: whiteboards
    };
  }

  let remoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>;
  try {
    remoteBlocks = await withRateLimitRetry(() => input.adapter.fetchDocBlocks!({ doc: resolvedDocumentId }));
  } catch (error) {
    const normalized = canonicalizeRemoteCalloutMarkdown({ markdown: remoteRaw.markdown, config: callouts });
    const remote = { ...remoteRaw, markdown: normalized.markdown };
    const blockPatchDraft = markdownBodyForBlockPatch(transform.markdown, remote.markdown);
    const message = error instanceof Error ? error.message : String(error);
    const whiteboards = input.syncWhiteboards
      ? blockedWhiteboardPlan('whiteboard-adapter-unavailable', `Whiteboard planning requires Docx block reads: ${message}`)
      : undefined;
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        ...publishPlanDialectFields(publishContext),
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, ...normalized.warnings, `block-patch planning unavailable: ${message}`],
        whiteboards
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      publishContext,
      blockPatchDraft,
      remote,
      receipt,
      whiteboardPlan: whiteboards
    };
  }
  const page = findPageBlock(remoteBlocks.blocks, resolvedDocumentId);
  const remoteCodeMetadata = await fetchRemoteCodeMetadata(input.adapter, resolvedDocumentId, remoteBlocks.blocks);
  const remoteBaseHint = await trackedRemoteSemanticBaseline({ cwd: input.cwd, receipt });
  const remoteCurrent = applyTrackedCalloutTypes(
    remoteSemanticDocument(remoteBlocks.blocks, resolvedDocumentId, callouts, remoteCodeMetadata),
    remoteBaseHint
  );
  const normalized = canonicalizeRemoteCalloutMarkdown({
    markdown: remoteRaw.markdown,
    config: callouts,
    typeHints: calloutTypeHints(remoteCurrent)
  });
  const remote = { ...remoteRaw, markdown: normalized.markdown };
  const blockPatchDraft = markdownBodyForBlockPatch(transform.markdown, remote.markdown);
  const codeBlocks = input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG;
  const localCurrent = localSemanticDocument(blockPatchDraft, codeBlocks);
  const baseline = await loadSemanticBaselines({
    cwd: input.cwd,
    receipt,
    profile: input.profile,
    currentLocalSource: localSource,
    currentRemoteMarkdown: remote.markdown,
    currentRemoteSemantic: remoteCurrent,
    codeBlocks
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
    ...publishPlanDialectFields(publishContext),
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: [...transform.warnings, ...normalized.warnings],
    scopedPatch,
    whiteboards: whiteboardAnalysis.plan
  });
  return {
    plan,
    resolvedDocumentId,
    localSource,
    publishDraft: transform.markdown,
    publishContext,
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
  publishContext: PublishContext;
}): Promise<RunPublishResult> {
  const title = resolvePublishTitle({
    sourcePath: input.file,
    markdown: input.publishContext.publishDraft
  }).title;
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    ...publishPlanDialectFields(input.publishContext),
    localSource: input.publishContext.localSource,
    publishDraft: input.publishContext.publishDraft,
    remoteMarkdown: '',
    receipt: undefined,
    transformWarnings: input.publishContext.transformWarnings,
    createDocument: true
  });
  if (!input.write) return { mode: 'dry-run', plan };

  const created = await input.adapter.createDocument({
    title,
    markdown: input.publishContext.publishDraft,
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
      localSource: input.publishContext.localSource,
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
      localSource: input.publishContext.localSource,
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
  codeBlocks: CodeBlockConfig;
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
  const localBase = localSemanticDocument(
    markdownBodyForBlockPatch(localBaseDraft, input.currentRemoteMarkdown),
    input.codeBlocks
  );
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

async function trackedRemoteSemanticBaseline(input: {
  cwd: string;
  receipt: PublishReceipt | undefined;
}): Promise<SemanticDocument | undefined> {
  if (input.receipt?.version !== 2 && input.receipt?.version !== 3) return undefined;
  return readRemoteSemanticSnapshot({
    cwd: input.cwd,
    snapshot: input.receipt.remoteSemanticSnapshot
  });
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

export function partitionScopedOperations(operations: ScopedPatchOperation[]): {
  updates: ScopedPatchOperation[];
  creates: ScopedPatchOperation[];
  moves: ScopedPatchOperation[];
  tables: ScopedPatchOperation[];
  deletes: ScopedPatchOperation[];
} {
  const result = {
    updates: [] as ScopedPatchOperation[],
    creates: [] as ScopedPatchOperation[],
    moves: [] as ScopedPatchOperation[],
    tables: [] as ScopedPatchOperation[],
    deletes: [] as ScopedPatchOperation[]
  };
  for (const operation of operations) {
    if (operation.kind === 'update' || operation.kind === 'callout-child-update' || operation.kind === 'code-update') {
      result.updates.push(operation);
    } else if (operation.kind === 'create' || operation.kind === 'callout-create' ||
      operation.kind === 'callout-child-create' || operation.kind === 'code-create') {
      result.creates.push(operation);
    } else if (operation.kind === 'code-section-reconcile') {
      result.moves.push({ ...operation, phase: 'place' });
      result.deletes.push({ ...operation, phase: 'delete' });
    } else if (operation.kind === 'code-move') {
      result.moves.push(operation);
    } else if (operation.kind === 'table-replace') result.tables.push(operation);
    else result.deletes.push(operation);
  }
  return result;
}

async function applyScopedOperations(input: {
  adapter: FeishuAdapter;
  doc: string;
  operations: ScopedPatchOperation[];
  callouts: CalloutConfig;
  completedOperations?: PublishWriteOperationSummary[];
  pendingAfter?: PublishWriteOperationSummary[];
}): Promise<PublishWriteOperationSummary[]> {
  if (!input.adapter.replaceBlock || !input.adapter.insertBlocksAfter || !input.adapter.deleteBlocks || !input.adapter.fetchDocBlocks) {
    throw new Error('Configured Feishu adapter does not support scoped block-patch writes');
  }
  const completed = [...(input.completedOperations ?? [])];
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = input.operations[index]!;
    const summary = summarizeScopedOperation(operation);
    let codeMutationCompleted = false;
    try {
      if (operation.kind === 'code-update' || operation.kind === 'code-create' ||
        operation.kind === 'code-move' || operation.kind === 'code-delete' ||
        operation.kind === 'code-section-reconcile') {
        await applyCodeOperation({
          adapter: input.adapter,
          doc: input.doc,
          operation: operation as CodeBlockOperation
        });
        codeMutationCompleted = true;
      } else if (operation.kind === 'update') {
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
          content: operation.desiredMarkdown,
          format: 'markdown'
        });
      } else if (operation.kind === 'delete') {
        await input.adapter.deleteBlocks({ doc: input.doc, blockIds: operation.blockIds });
      } else if (operation.kind === 'table-replace') {
        await input.adapter.replaceBlock({
          doc: input.doc,
          blockId: operation.remoteBlockId,
          content: renderTableXml(operation.desiredTable),
          format: 'xml'
        });
      } else if (operation.kind === 'callout-create') {
        await input.adapter.insertBlocksAfter({
          doc: input.doc,
          blockId: operation.insertAfterBlockId,
          content: renderCalloutXml({ callout: operation.desiredCallout, config: input.callouts }),
          format: 'xml'
        });
      } else if (operation.kind === 'callout-child-update') {
        await input.adapter.replaceBlock({
          doc: input.doc,
          blockId: operation.remoteBlockId,
          content: operation.desiredMarkdown,
          format: 'markdown'
        });
      } else if (operation.kind === 'callout-child-create') {
        await input.adapter.insertBlocksAfter({
          doc: input.doc,
          blockId: operation.insertAfterBlockId,
          content: operation.desiredMarkdown,
          format: 'markdown'
        });
      } else if (operation.kind === 'callout-child-delete' || operation.kind === 'callout-delete') {
        await input.adapter.deleteBlocks({ doc: input.doc, blockIds: operation.blockIds });
      } else {
        const unsupported: never = operation;
        throw new Error(`Unsupported scoped operation: ${String(unsupported)}`);
      }
      if (operation.kind === 'code-update' || operation.kind === 'code-create' ||
        operation.kind === 'code-move' || operation.kind === 'code-delete' ||
        operation.kind === 'code-section-reconcile') {
        verifyCodeOperation(operation, await fetchRemoteSemantic(input.adapter, input.doc, input.callouts));
      } else {
        const blocks = await input.adapter.fetchDocBlocks({ doc: input.doc });
        verifyOperation(operation, blocks.blocks, input.doc, input.callouts);
      }
      completed.push(summary);
    } catch (error) {
      if (error instanceof PartialWriteError) {
        throw new PartialWriteError({
          completedOperations: [...completed, ...error.completedOperations],
          failedOperation: error.failedOperation,
          pendingOperations: [
            ...error.pendingOperations,
            ...input.operations.slice(index + 1).map(summarizeScopedOperation),
            ...(input.pendingAfter ?? [])
          ],
          cause: error
        });
      }
      if (codeMutationCompleted) {
        throw new PartialWriteError({
          completedOperations: [...completed, summary],
          failedOperation: { kind: 'code-readback', locator: operation.locator },
          pendingOperations: [
            ...input.operations.slice(index + 1).map(summarizeScopedOperation),
            ...(input.pendingAfter ?? [])
          ],
          cause: error
        });
      }
      if (completed.length === 0) throw error;
      throw new PartialWriteError({
        completedOperations: completed,
        failedOperation: summary,
        pendingOperations: [
          ...input.operations.slice(index + 1).map(summarizeScopedOperation),
          ...(input.pendingAfter ?? [])
        ],
        cause: error
      });
    }
  }
  return completed;
}

async function applyCodeOperation(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: CodeBlockOperation;
}): Promise<void> {
  const operation = input.operation;
  const replaceBlock = input.adapter.replaceBlock?.bind(input.adapter);
  const insertBlocksAfter = input.adapter.insertBlocksAfter?.bind(input.adapter);
  const deleteBlocks = input.adapter.deleteBlocks?.bind(input.adapter);
  const moveBlocksAfter = input.adapter.moveBlocksAfter?.bind(input.adapter);
  if (!replaceBlock || !insertBlocksAfter || !deleteBlocks || !input.adapter.fetchDocBlocks) {
    throw new Error('Configured Feishu adapter does not support Code block writes.');
  }
  if ((operation.kind === 'code-move' || operation.kind === 'code-section-reconcile') && !moveBlocksAfter) {
    throw new Error('Configured Feishu adapter does not support Code block movement.');
  }

  if (operation.kind === 'code-section-reconcile') {
    await applyCodeSectionReconcile({
      adapter: input.adapter,
      doc: input.doc,
      operation,
      replaceBlock,
      insertBlocksAfter,
      deleteBlocks,
      moveBlocksAfter: moveBlocksAfter!
    });
    return;
  }

  const before = await fetchRemoteSemantic(input.adapter, input.doc);
  if (operation.kind === 'code-create') {
    const anchor = resolveAnchorBlockId(
      before,
      operation.afterLocator,
      input.doc,
      operation.afterCodeFingerprint
    );
    await withRateLimitRetry(() => insertBlocksAfter({
      doc: input.doc,
      blockId: anchor,
      content: renderCodeBlockXml(operation.desiredCode),
      format: 'xml'
    }));
    return;
  }

  const remote = resolveRemoteCode(before, operation);
  if (!remote.remoteBlockId) throw new Error('Code block write cannot resolve a current remote block ID.');
  if (operation.kind === 'code-update') {
    await withRateLimitRetry(() => replaceBlock({
      doc: input.doc,
      blockId: remote.remoteBlockId!,
      content: renderCodeBlockXml({ ...operation.desiredCode, caption: remote.caption }),
      format: 'xml'
    }));
    return;
  }
  if (operation.kind === 'code-move') {
    const anchor = resolveAnchorBlockId(
      before,
      operation.afterLocator,
      input.doc,
      operation.afterCodeFingerprint,
      remote.remoteBlockId
    );
    await withRateLimitRetry(() => moveBlocksAfter!({
      doc: input.doc,
      blockId: anchor,
      sourceBlockIds: [remote.remoteBlockId!]
    }));
    return;
  }
  await withRateLimitRetry(() => deleteBlocks({ doc: input.doc, blockIds: [remote.remoteBlockId!] }));
}

async function applyCodeSectionReconcile(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: CodeSectionReconcileOperation;
  replaceBlock: NonNullable<FeishuAdapter['replaceBlock']>;
  insertBlocksAfter: NonNullable<FeishuAdapter['insertBlocksAfter']>;
  deleteBlocks: NonNullable<FeishuAdapter['deleteBlocks']>;
  moveBlocksAfter: NonNullable<FeishuAdapter['moveBlocksAfter']>;
}): Promise<void> {
  const completed: PublishWriteOperationSummary[] = [];
  try {
    const beforePhase = await fetchRemoteSemantic(input.adapter, input.doc);
    const unrelatedBefore = codeScopeHashOutsideSections(beforePhase, input.operation.sectionPaths);

    if (input.operation.phase === 'delete') {
      const obsoleteIds = findObsoleteCodeIdsForReconcile(
        beforePhase,
        input.operation.desiredCodes.map(({ code }) => code),
        input.operation.sectionPaths
      );
      if (obsoleteIds.length > 0) {
        await withRateLimitRetry(() => input.deleteBlocks({ doc: input.doc, blockIds: obsoleteIds }));
        completed.push({ kind: 'code-reconcile-delete', locator: input.operation.locator });
      }
      const afterDeletion = await fetchRemoteSemantic(input.adapter, input.doc);
      assertUnrelatedCodeScopesUnchanged(unrelatedBefore, afterDeletion, input.operation.sectionPaths);
      return;
    }

    const exactMatches = assignCodeReconcileExactMatches(
      beforePhase,
      input.operation.desiredCodes.map(({ code }) => code),
      input.operation.sectionPaths
    );
    const reservedExactIds = new Set(exactMatches.values());
    const consumedRemoteBlockIds = new Set<string>();
    for (const [desiredIndex, desired] of input.operation.desiredCodes.entries()) {
      let current = await fetchRemoteSemantic(input.adapter, input.doc);
      const exactMatchId = exactMatches.get(desiredIndex);
      const unavailableIds = new Set([...consumedRemoteBlockIds, ...reservedExactIds]);
      if (exactMatchId) unavailableIds.delete(exactMatchId);
      let remote = exactMatchId
        ? codeNodes(current).find((candidate) => candidate.remoteBlockId === exactMatchId)
        : findCodeReconcileCandidate(
          current,
          desired.code,
          input.operation.sectionPaths,
          unavailableIds
        );
      if (!remote) {
        const anchor = resolveAnchorBlockId(
          current,
          desired.afterLocator,
          input.doc,
          desired.afterCodeFingerprint
        );
        await withRateLimitRetry(() => input.insertBlocksAfter({
          doc: input.doc,
          blockId: anchor,
          content: renderCodeBlockXml(desired.code),
          format: 'xml'
        }));
        completed.push({ kind: 'code-reconcile-create', locator: desired.code.locator });
        current = await fetchRemoteSemantic(input.adapter, input.doc);
        remote = findCodeReconcileCandidate(
          current,
          desired.code,
          input.operation.sectionPaths,
          unavailableIds
        );
        if (!remote) throw new Error('Code section reconcile could not resolve the created block.');
      } else if (!codeManagedEqual(remote, desired.code)) {
        if (!remote.remoteBlockId) throw new Error('Code section reconcile cannot replace a block without an ID.');
        await withRateLimitRetry(() => input.replaceBlock({
          doc: input.doc,
          blockId: remote!.remoteBlockId!,
          content: renderCodeBlockXml({ ...desired.code, caption: remote!.caption }),
          format: 'xml'
        }));
        completed.push({ kind: 'code-reconcile-update', locator: desired.code.locator });
        current = await fetchRemoteSemantic(input.adapter, input.doc);
        remote = findCodeReconcileCandidate(
          current,
          desired.code,
          input.operation.sectionPaths,
          unavailableIds
        );
        if (!remote) throw new Error('Code section reconcile could not resolve the replaced block.');
      }

      if (!remote.remoteBlockId) throw new Error('Code section reconcile cannot move a block without an ID.');
      if (remote.caption !== undefined) {
        desired.code = { ...desired.code, caption: remote.caption };
      }
      consumedRemoteBlockIds.add(remote.remoteBlockId);
      if (reconcileCandidateNeedsMove(
        current,
        remote,
        desired.afterLocator,
        desired.afterCodeFingerprint
      )) {
        const anchor = resolveAnchorBlockId(
          current,
          desired.afterLocator,
          input.doc,
          desired.afterCodeFingerprint,
          remote.remoteBlockId
        );
        await withRateLimitRetry(() => input.moveBlocksAfter({
          doc: input.doc,
          blockId: anchor,
          sourceBlockIds: [remote!.remoteBlockId!]
        }));
        completed.push({ kind: 'code-reconcile-move', locator: desired.code.locator });
      }
    }
    const afterPlacement = await fetchRemoteSemantic(input.adapter, input.doc);
    assertUnrelatedCodeScopesUnchanged(unrelatedBefore, afterPlacement, input.operation.sectionPaths);
  } catch (error) {
    if (error instanceof PartialWriteError || completed.length === 0) throw error;
    throw new PartialWriteError({
      completedOperations: completed,
      failedOperation: { kind: 'code-section-reconcile', locator: input.operation.locator },
      cause: error
    });
  }
}

export function findObsoleteCodeIdsForReconcile(
  document: SemanticDocument,
  desiredCodes: SemanticCodeBlock[],
  sectionPaths: string[][]
): string[] {
  return sectionPaths.flatMap((section) => {
    const desiredCounts = fingerprintCounts(desiredCodes.filter((code) => {
      return sameSectionPath(code.locator.sectionPath, section);
    }));
    const seen = new Map<string, number>();
    return codeNodes(document)
      .filter((code) => sameSectionPath(code.locator.sectionPath, section))
      .flatMap((code) => {
        const fingerprint = codeManagedFingerprint(code);
        const count = (seen.get(fingerprint) ?? 0) + 1;
        seen.set(fingerprint, count);
        return count > (desiredCounts.get(fingerprint) ?? 0) && code.remoteBlockId
          ? [code.remoteBlockId]
          : [];
      });
  });
}

function codeScopeHashOutsideSections(document: SemanticDocument, sectionPaths: string[][]): string {
  return semanticHash(codeNodes(document)
    .filter((code) => !sectionPaths.some((section) => sameSectionPath(code.locator.sectionPath, section)))
    .map((code) => stripExecutionMetadata(code)));
}

function assertUnrelatedCodeScopesUnchanged(
  expectedHash: string,
  document: SemanticDocument,
  sectionPaths: string[][]
): void {
  if (codeScopeHashOutsideSections(document, sectionPaths) !== expectedHash) {
    throw new Error('Code section reconcile changed an unrelated Code scope.');
  }
}

const CODE_WRITE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000];

export async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = CODE_WRITE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRateLimitError(error)) throw error;
      await delay(delayMs);
    }
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b429\b|rate.?limit|too many requests)/i.test(message);
}

function resolveRemoteCode(document: SemanticDocument, operation: Exclude<CodeBlockOperation, { kind: 'code-create' | 'code-section-reconcile' }>): SemanticCodeBlock {
  const byId = codeNodes(document).find((code) => code.remoteBlockId && code.remoteBlockId === operation.remoteBlockId);
  const byLocator = findCodeByLocator(document, operation.sourceLocator);
  const matched = byId ?? byLocator;
  if (!matched) throw new Error(`Code block correspondence is no longer resolvable at ${locatorKey(operation.sourceLocator)}.`);
  return matched;
}

function resolveAnchorBlockId(
  document: SemanticDocument,
  locator: SemanticLocator | undefined,
  pageBlockId: string,
  codeFingerprint?: string,
  excludeBlockId?: string
): string {
  if (!locator) return pageBlockId;
  const fingerprintCandidates = codeFingerprint
    ? codeNodes(document).filter((code) => {
      return code.remoteBlockId !== excludeBlockId &&
        codeManagedFingerprint(code) === codeFingerprint &&
        sameSectionPath(code.locator.sectionPath, locator.sectionPath);
    })
    : [];
  const locatorCandidate = document.nodes.find((candidate) => {
    return candidate.remoteBlockId !== excludeBlockId && sameLocator(candidate.locator, locator);
  });
  const node = codeFingerprint
    ? fingerprintCandidates.length === 1
      ? fingerprintCandidates[0]
      : locatorCandidate?.kind === 'code' && codeManagedFingerprint(locatorCandidate) === codeFingerprint
        ? locatorCandidate
        : undefined
    : locatorCandidate;
  if (!node?.remoteBlockId) throw new Error(`Code block anchor is no longer resolvable at ${locatorKey(locator)}.`);
  return node.remoteBlockId;
}

function findUniqueCodeByFingerprint(
  document: SemanticDocument,
  fingerprint: string,
  sectionPath?: string[]
): SemanticCodeBlock | undefined {
  const matches = codeNodes(document).filter((code) => {
    return codeManagedFingerprint(code) === fingerprint &&
      (!sectionPath || sameSectionPath(code.locator.sectionPath, sectionPath));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function codeNodes(document: SemanticDocument): SemanticCodeBlock[] {
  return document.nodes.filter((node): node is SemanticCodeBlock => node.kind === 'code');
}

function findCodeByLocator(document: SemanticDocument, locator: SemanticLocator): SemanticCodeBlock | undefined {
  return codeNodes(document).find((code) => sameLocator(code.locator, locator));
}

function findUniqueCodeByManagedFields(document: SemanticDocument, desired: SemanticCodeBlock): SemanticCodeBlock | undefined {
  const matches = codeNodes(document).filter((code) => codeManagedEqual(code, desired));
  return matches.length === 1 ? matches[0] : undefined;
}

export function findCodeReconcileCandidate(
  document: SemanticDocument,
  desired: SemanticCodeBlock,
  sectionPaths: string[][],
  consumedRemoteBlockIds: ReadonlySet<string> = new Set()
): SemanticCodeBlock | undefined {
  const candidates = codeNodes(document).filter((code) => {
    return sectionPaths.some((section) => sameSectionPath(code.locator.sectionPath, section)) &&
      (!code.remoteBlockId || !consumedRemoteBlockIds.has(code.remoteBlockId));
  });
  const managedMatches = candidates.filter((code) => codeManagedEqual(code, desired));
  if (managedMatches.length === 1) return managedMatches[0];
  const locatorMatches = candidates.filter((code) => sameLocator(code.locator, desired.locator));
  return locatorMatches.length === 1 ? locatorMatches[0] : undefined;
}

export function assignCodeReconcileExactMatches(
  document: SemanticDocument,
  desiredCodes: SemanticCodeBlock[],
  sectionPaths: string[][]
): Map<number, string> {
  const assignments = new Map<number, string>();
  const used = new Set<string>();
  for (const [index, desired] of desiredCodes.entries()) {
    const candidates = codeNodes(document).filter((candidate) => {
      return Boolean(candidate.remoteBlockId) &&
        !used.has(candidate.remoteBlockId!) &&
        sectionPaths.some((section) => sameSectionPath(candidate.locator.sectionPath, section)) &&
        codeManagedEqual(candidate, desired);
    });
    const locatorMatch = candidates.find((candidate) => sameLocator(candidate.locator, desired.locator));
    const match = locatorMatch ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!match?.remoteBlockId) continue;
    assignments.set(index, match.remoteBlockId);
    used.add(match.remoteBlockId);
  }
  return assignments;
}

export function reconcileCandidateNeedsMove(
  document: SemanticDocument,
  code: SemanticCodeBlock,
  afterLocator: SemanticLocator | undefined,
  afterCodeFingerprint?: string
): boolean {
  return !codePlacementMatches(document, code, afterLocator, afterCodeFingerprint);
}

function codeManagedEqual(left: SemanticCodeBlock, right: SemanticCodeBlock): boolean {
  return left.content === right.content && left.resolvedLanguage === right.resolvedLanguage;
}

function codeManagedFingerprint(code: SemanticCodeBlock): string {
  return semanticHash({ content: code.content, language: code.resolvedLanguage });
}

function fingerprintCounts(codes: SemanticCodeBlock[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const code of codes) {
    const fingerprint = codeManagedFingerprint(code);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function sameLocator(left: SemanticLocator, right: SemanticLocator): boolean {
  return locatorKey(left) === locatorKey(right);
}

function sameSectionPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

async function applyWhiteboardPlan(input: {
  adapter: FeishuAdapter;
  doc: string;
  plan: WhiteboardPlan;
  assets: LocalWhiteboardAsset[];
  previousEntries: WhiteboardReceiptEntry[];
  completedOperations: PublishWriteOperationSummary[];
  pendingAfter?: PublishWriteOperationSummary[];
}): Promise<{ entries: WhiteboardReceiptEntry[]; completedOperations: PublishWriteOperationSummary[] }> {
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
  for (let index = 0; index < input.plan.operations.length; index += 1) {
    const operation = input.plan.operations[index]!;
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

      const remote = await queryWhiteboardReadback({ queryWhiteboard, whiteboardToken });
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
        pendingOperations: [
          ...input.plan.operations.slice(index + 1).map(summarizeWhiteboardOperation),
          ...(input.pendingAfter ?? [])
        ],
        cause: error
      });
    }
  }
  return {
    entries: [...entries.values()].sort((left, right) => left.assetKey.localeCompare(right.assetKey)),
    completedOperations: completed
  };
}

async function queryWhiteboardReadback(input: {
  queryWhiteboard: (input: { whiteboardToken: string }) => Promise<RemoteWhiteboard>;
  whiteboardToken: string;
}): Promise<RemoteWhiteboard> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.queryWhiteboard({ whiteboardToken: input.whiteboardToken });
    } catch (error) {
      const delayMs = WHITEBOARD_READBACK_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isWhiteboardApplyingError(error)) throw error;
      await delay(delayMs);
    }
  }
}

function isWhiteboardApplyingError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; cause?: unknown };
    if (record.code === 4003101) return true;
    if (record.cause !== undefined && isWhiteboardApplyingError(record.cause)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:"code"\s*:\s*4003101\b|\b4003101\b)/.test(message) &&
    /(?:doc is applying|doc data is not ready|resource error|whiteboard)/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeWhiteboardOperation(operation: WhiteboardOperation): PublishWriteOperationSummary {
  return {
    kind: operation.kind,
    locator: operation.locator,
    assetKey: operation.assetKey
  };
}

function summarizeScopedOperation(operation: ScopedPatchOperation): PublishWriteOperationSummary {
  return { kind: operation.kind, locator: operation.locator };
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

function verifyOperation(
  operation: ScopedPatchOperation,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig
): void {
  if (operation.kind === 'delete' || operation.kind === 'callout-child-delete' ||
    operation.kind === 'callout-delete' || operation.kind === 'code-delete') {
    const remaining = new Set(blocks.flatMap((block) => block.block_id ? [block.block_id] : []));
    const deletedIds = operation.kind === 'code-delete'
      ? (operation.remoteBlockId ? [operation.remoteBlockId] : [])
      : operation.blockIds;
    if (deletedIds.some((blockId) => remaining.has(blockId))) {
      throw new Error('scoped readback verification failed: deleted block still exists');
    }
    return;
  }

  const remote = remoteSemanticDocument(blocks, documentId, callouts);
  if (operation.kind === 'table-replace') {
    const match = findCorrespondingRemoteTable(operation.desiredTable, remote);
    if (!match.table) throw new Error(`scoped readback verification failed: ${match.blocker}`);
    const diff = diffCorrespondingTable(match.table, operation.desiredTable);
    if (diff.blockers.length > 0 || diff.additions.length > 0 || diff.updates.length > 0) {
      throw new Error('scoped readback verification failed: remote table differs from desired table');
    }
    return;
  }

  if (operation.kind.startsWith('callout-')) {
    verifyCalloutOperation(operation as CalloutOperation, remote, callouts);
    return;
  }

  if (operation.kind.startsWith('code-')) {
    verifyCodeOperation(operation as CodeBlockOperation, remote);
    return;
  }

  if (operation.kind !== 'update' && operation.kind !== 'create') {
    throw new Error('Callout readback verification is not configured.');
  }

  const candidates = remote.nodes.filter((node): node is SemanticTextBlock => {
    return node.kind === 'text' && sameLocator(node.locator, operation.locator);
  });
  const matched = candidates.find((node) => {
    return canonicalMarkdown(node.markdown) === canonicalMarkdown(operation.desiredMarkdown);
  });
  if (!matched) {
    throw new Error('scoped readback verification failed: remote text differs from desired text');
  }
  if (operation.kind === 'create' && (!matched.remoteBlockId || !textCreatePlacementMatches(
    blocks,
    documentId,
    matched.remoteBlockId,
    operation.insertAfterBlockId
  ))) {
    throw new Error('scoped readback verification failed: remote text placement differs from desired order');
  }
}

export function textCreatePlacementMatches(
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  createdBlockId: string,
  insertAfterBlockId: string
): boolean {
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const createdIndex = direct.findIndex((block) => block.block_id === createdBlockId);
  if (createdIndex < 0) return false;
  if (insertAfterBlockId === page.block_id) return createdIndex === 0;
  return createdIndex > 0 && direct[createdIndex - 1]?.block_id === insertAfterBlockId;
}

function verifyCodeOperation(operation: CodeBlockOperation, remote: SemanticDocument): void {
  if (operation.kind === 'code-delete') {
    if (operation.remoteBlockId && codeNodes(remote).some((code) => code.remoteBlockId === operation.remoteBlockId)) {
      throw new Error('Code block readback still contains the deleted block ID.');
    }
    return;
  }
  if (operation.kind === 'code-section-reconcile') {
    if (operation.phase !== 'delete') {
      const consumed = new Set<string>();
      for (const desired of operation.desiredCodes) {
        const matches = codeNodes(remote).filter((candidate) => {
          return codeManagedEqual(candidate, desired.code) &&
            sameSectionPath(candidate.locator.sectionPath, desired.code.locator.sectionPath) &&
            (!candidate.remoteBlockId || !consumed.has(candidate.remoteBlockId)) &&
            codePlacementMatches(remote, candidate, desired.afterLocator, desired.afterCodeFingerprint);
        });
        if (matches.length !== 1) {
          throw new Error('Code section reconcile placement readback differs from the desired Code block.');
        }
        if (desired.code.caption !== undefined && matches[0]!.caption !== desired.code.caption) {
          throw new Error('Code section reconcile readback did not preserve the remote caption.');
        }
        if (matches[0]!.remoteBlockId) consumed.add(matches[0]!.remoteBlockId!);
      }
      return;
    }
    for (const section of operation.sectionPaths) {
      const desired = operation.desiredCodes
        .map(({ code }) => code)
        .filter((code) => sameSectionPath(code.locator.sectionPath, section));
      const actual = codeNodes(remote).filter((code) => sameSectionPath(code.locator.sectionPath, section));
      if (desired.length !== actual.length || desired.some((code, index) => {
        const candidate = actual[index];
        return !candidate || !codeManagedEqual(code, candidate);
      })) {
        throw new Error('Code section reconcile readback differs from the desired Code scope.');
      }
    }
    return;
  }
  const desired = operation.desiredCode;
  const expectedLocator = operation.kind === 'code-update' ? operation.sourceLocator : operation.locator;
  const matched = findCodeByLocator(remote, expectedLocator);
  if (!matched || !codeManagedEqual(matched, desired)) {
    throw new Error('Code block readback differs from the desired content or language.');
  }
  if (desired.caption !== undefined && matched.caption !== desired.caption) {
    throw new Error('Code block readback did not preserve the remote caption.');
  }
  if (operation.kind === 'code-create' || operation.kind === 'code-move') {
    verifyCodePlacement(remote, matched, operation.afterLocator, operation.afterCodeFingerprint);
  }
}

function verifyCodePlacement(
  document: SemanticDocument,
  code: SemanticCodeBlock,
  afterLocator: SemanticLocator | undefined,
  afterCodeFingerprint?: string
): void {
  if (!codePlacementMatches(document, code, afterLocator, afterCodeFingerprint)) {
    throw new Error('Code block placement readback differs from the desired predecessor.');
  }
}

function codePlacementMatches(
  document: SemanticDocument,
  code: SemanticCodeBlock,
  afterLocator: SemanticLocator | undefined,
  afterCodeFingerprint?: string
): boolean {
  const codeIndex = document.nodes.indexOf(code);
  if (codeIndex < 0) return false;
  if (!afterLocator) {
    return codeIndex === 0;
  }
  const anchor = afterCodeFingerprint
    ? (() => {
      const candidates = codeNodes(document).filter((candidate) => {
        return candidate.remoteBlockId !== code.remoteBlockId &&
          codeManagedFingerprint(candidate) === afterCodeFingerprint &&
          sameSectionPath(candidate.locator.sectionPath, afterLocator.sectionPath);
      });
      if (candidates.length === 1) return candidates[0];
      const locatorCandidate = document.nodes.find((candidate) => {
        return candidate.remoteBlockId !== code.remoteBlockId && sameLocator(candidate.locator, afterLocator);
      });
      return locatorCandidate?.kind === 'code' && codeManagedFingerprint(locatorCandidate) === afterCodeFingerprint
        ? locatorCandidate
        : undefined;
    })()
    : document.nodes.find((node) => {
      return node.remoteBlockId !== code.remoteBlockId && sameLocator(node.locator, afterLocator);
    });
  return Boolean(anchor && document.nodes.indexOf(anchor) + 1 === codeIndex);
}

function verifyCalloutOperation(
  operation: CalloutOperation,
  remote: SemanticDocument,
  callouts: CalloutConfig
): void {
  if (operation.kind === 'callout-delete' || operation.kind === 'callout-child-delete') return;
  const match = remote.nodes.find((node) => {
    return node.kind === 'callout' && locatorKey(node.locator) === locatorKey(operation.locator);
  });
  if (!match || match.kind !== 'callout') {
    throw new Error('Callout readback verification failed: Callout is missing');
  }
  if (operation.kind === 'callout-create') {
    const expectedTitle = operation.desiredCallout.calloutType === 'note' ? callouts.noteTitle : callouts.warningTitle;
    if (match.calloutType !== operation.desiredCallout.calloutType || match.title?.markdown !== expectedTitle) {
      throw new Error('Callout readback verification failed: type or presentation title differs');
    }
    if (!calloutChildrenMatch(match.children, operation.desiredCallout.children)) {
      throw new Error('Callout readback verification failed: body differs from desired content');
    }
    return;
  }
  if (match.remoteBlockId !== operation.calloutBlockId) {
    throw new Error('Callout readback verification failed: container identity changed');
  }
  if (operation.kind === 'callout-child-update') {
    const child = match.children[operation.childOrdinal];
    if (!child || canonicalMarkdown(child.markdown) !== canonicalMarkdown(operation.desiredMarkdown)) {
      throw new Error('Callout readback verification failed: updated child differs');
    }
    return;
  }
  const created = match.children.slice(
    operation.childOrdinal,
    operation.childOrdinal + operation.desiredChildren.length
  );
  if (!calloutChildrenMatch(created, operation.desiredChildren)) {
    throw new Error('Callout readback verification failed: created children differ');
  }
}

function calloutChildrenMatch(
  remote: Array<{ blockType: number; markdown: string }>,
  desired: Array<{ blockType: number; markdown: string }>
): boolean {
  return remote.length === desired.length && remote.every((child, index) => {
    const expected = desired[index];
    return Boolean(expected && child.blockType === expected.blockType &&
      canonicalMarkdown(child.markdown) === canonicalMarkdown(expected.markdown));
  });
}

function sameSection(left: SemanticLocator, right: SemanticLocator): boolean {
  return left.sectionPath.length === right.sectionPath.length &&
    left.sectionPath.every((part, index) => part === right.sectionPath[index]);
}

function locatorKey(locator: SemanticLocator): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

export async function fetchRemoteSemantic(
  adapter: FeishuAdapter,
  documentId: string,
  callouts: CalloutConfig = DEFAULT_CALLOUT_CONFIG
): Promise<SemanticDocument> {
  if (!adapter.fetchDocBlocks) throw new Error('Configured Feishu adapter cannot fetch Docx blocks.');
  const blocks = await withRateLimitRetry(() => adapter.fetchDocBlocks!({ doc: documentId }));
  const codeMetadata = await fetchRemoteCodeMetadata(adapter, documentId, blocks.blocks);
  return remoteSemanticDocument(blocks.blocks, documentId, callouts, codeMetadata);
}

async function fetchRemoteCodeMetadata(
  adapter: FeishuAdapter,
  documentId: string,
  blocks: import('../feishu/types.js').FeishuBlock[]
): Promise<import('../adapters/feishu-adapter.js').RemoteCodeMetadata[]> {
  if (!blocks.some((block) => block.block_type === 14) || !adapter.fetchDocCodeMetadata) return [];
  return withRateLimitRetry(() => adapter.fetchDocCodeMetadata!({ doc: documentId }));
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

function publishPlanDialectFields(context: PublishContext): Pick<
  PublishPlan,
  | 'dialect'
  | 'dialectDraftHash'
  | 'dialectBlockers'
  | 'dialectWarnings'
  | 'linkResolution'
  | 'linkResolutionFingerprint'
> {
  return {
    dialect: context.dialect,
    dialectDraftHash: context.dialectDraftHash,
    dialectBlockers: context.dialectBlockers,
    dialectWarnings: context.dialectWarnings,
    linkResolution: context.linkResolution,
    linkResolutionFingerprint: context.linkResolutionFingerprint
  };
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
