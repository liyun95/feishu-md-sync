import { confirmationRequired, validationFailure } from '../core/cli-failure.js';
import {
  createFeishuDocxEngine,
  EngineExecutionError,
  PartialMutationError,
  type DocumentSnapshot,
  type MutationIntent,
  type MutationJournal,
} from 'feishu-docx-engine';
import type { FeishuAdapter, RemoteMarkdown } from '../adapters/feishu-adapter.js';
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
import { calloutTypeForEmojiId } from '../callouts/callout-presentation.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import { canonicalMarkdown } from '../core/markdown-canonical.js';
import type { FeishuBlock } from '../feishu/types.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { DialectName } from '../dialects/types.js';
import type { DialectWorkspaceConfig } from '../link-resolvers/types.js';
import {
  canUpgradeLegacyReceipt,
  hasRemoteSemanticSnapshot,
  hashText,
  readLocalBaseSnapshot,
  readPublishBaseSnapshot,
  readPublishReceipt,
  protectedResourceEntries,
  whiteboardEntries,
  writeLocalBaseSnapshot,
  writePublishBaseSnapshot,
  writePublishReceipt,
  type PublishReceipt,
  type PublishReceiptTarget,
  type ProtectedResourceReceiptEntry,
  type WhiteboardReceiptEntry
} from '../receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot, writeRemoteSemanticSnapshot } from '../receipts/semantic-snapshot.js';
import { writePublishRemoteCheckpoint } from '../receipts/publish-baseline-bundle.js';
import { localSemanticDocument } from '../semantic/local-document.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type {
  SemanticCodeBlock,
  SemanticDocument,
  SemanticLocator,
  SemanticNode,
  SemanticTable,
  SemanticTextBlock,
  SemanticTextChild
} from '../semantic/types.js';
import { discoverLocalWhiteboardAssets, normalizeAssetKey, type LocalWhiteboardAsset } from '../whiteboards/local-assets.js';
import { verifyWhiteboardReadback, whiteboardRemoteStateHash } from '../whiteboards/remote-state.js';
import {
  planWhiteboardPublish,
  type WhiteboardOperation,
  type WhiteboardPlan
} from '../whiteboards/whiteboard-plan.js';
import {
  findPageBlock,
  renderableDirectChildBlocks,
  resolvedChildBlocks
} from './block-state.js';
import { PartialWriteError, type PublishWriteOperationSummary } from './partial-write-error.js';
import {
  bridgeEngineCause,
  docxTransportForAdapter,
  enginePartialWriteError,
  lastDocxEngineProviderRevision,
  operationIdForScopedOperation,
  scopedOperationToMutationIntents,
  whiteboardOperationToMutationIntent,
} from './docx-engine-operations.js';
import { createDocxEngineJournal } from './docx-engine-journal.js';
import type { CalloutOperation } from './callout-plan.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';
import { buildPublishContext, type PublishContext } from './publish-context.js';
import { markdownBodyForBlockPatch } from './block-patch-markdown.js';
import { applyPublishTransformForProfile } from './profile-transform.js';
import { planScopedPatch, type ScopedPatchOperation, type ScopedPatchPlan } from './scoped-patch-plan.js';
import { diffCorrespondingTable, findCorrespondingRemoteTable } from './table-diff.js';
import { renderTableXml } from './table-xml.js';
import { resolvePublishTitle } from './title.js';
import type { ZdocComponentInventory } from '../zdoc/types.js';
import { buildZdocRoundTripReport } from '../zdoc/round-trip-report.js';
import { planProtectedResources } from '../zdoc/protected-resource-plan.js';
import { planProceduresChanges } from '../zdoc/procedures-plan.js';

export type RunPublishResult = {
  mode: 'dry-run' | 'write';
  plan: PublishPlan;
  document?: {
    documentId: string;
    url?: string;
  };
};

const TABLE_READBACK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000];
const CHECKPOINT_READ_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000];

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
  protectedResources?: ReturnType<typeof planProtectedResources>;
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
      publishContext: analysis.publishContext,
      publishDraft: analysis.publishDraft,
      remoteMarkdown: analysis.remote.markdown,
      remoteRevision: analysis.remote.revision,
      remoteSemantic: analysis.remoteCurrent,
      whiteboards: whiteboardEntries(analysis.receipt),
      protectedResources: analysis.protectedResources?.entries ??
        protectedResourceEntries(analysis.receipt)
    };
    await recordPublishReceiptV4(receiptInput);
    return { mode: 'write', plan };
  }

  if (plan.strategy === 'block-patch') {
    if (!plan.scopedPatch) throw new Error('block-patch write is missing a scoped patch plan');
    if (!analysis.localCurrent) throw new Error('block-patch write is missing local semantic state');
    const phases = partitionScopedOperations(plan.scopedPatch.operations);
    const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
    await verifyScopedRecoveryPreflight({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      operations: plan.scopedPatch.operations,
      callouts
    });
    const existingCheckpoint = analysis.receipt?.version === 4 || analysis.receipt?.version === 5
      ? analysis.receipt.partialWriteCheckpoint
      : undefined;
    const recoveryCheckpoint = {
      written: Boolean(existingCheckpoint),
      revision: existingCheckpoint?.remoteRevision
    };
    const checkpointVerifiedOperations: ScopedPatchOperation[] = [];
    const recordCheckpoint = analysis.receipt?.version === 4 || analysis.receipt?.version === 5
      ? async (
          completedOperations: PublishWriteOperationSummary[],
          verifiedOperations: ScopedPatchOperation[]
        ): Promise<void> => {
          const checkpointState = await withCheckpointReadRetry(async () => {
            const remoteBefore = await withRateLimitRetry(() => input.adapter.fetchDocMarkdown({
              doc: analysis.resolvedDocumentId
            }));
            const remoteBlocks = await withRateLimitRetry(() => input.adapter.fetchDocBlocks!({
              doc: analysis.resolvedDocumentId
            }));
            const remoteCodeMetadata = await fetchRemoteCodeMetadata(
              input.adapter,
              analysis.resolvedDocumentId,
              remoteBlocks.blocks
            );
            const remoteSemantic = applyTrackedCalloutTypes(
              remoteSemanticDocument(
                remoteBlocks.blocks,
                analysis.resolvedDocumentId,
                callouts,
                remoteCodeMetadata
              ),
              analysis.localCurrent
            );
            verifyCheckpointOperations({
              operations: verifiedOperations,
              remoteBlocks: remoteBlocks.blocks,
              remoteSemantic,
              documentId: analysis.resolvedDocumentId,
              callouts
            });
            assertCheckpointHasNoUnrelatedChanges(
              analysis.remoteCurrent,
              remoteSemantic,
              verifiedOperations
            );
            const remoteRaw = await withRateLimitRetry(() => input.adapter.fetchDocMarkdown({
              doc: analysis.resolvedDocumentId
            }));
            if (remoteBefore.revision !== remoteRaw.revision ||
              hashText(remoteBefore.markdown) !== hashText(remoteRaw.markdown)) {
              throw new Error('Remote changed while recording the partial-write recovery checkpoint.');
            }
            return {
              remoteRaw,
              remoteSemantic,
              canonicalRemote: canonicalizeRemoteCalloutMarkdown({
                markdown: remoteRaw.markdown,
                config: callouts,
                typeHints: calloutTypeHints(remoteSemantic)
              }).markdown
            };
          });
          const updatedAt = new Date().toISOString();
          await writePublishRemoteCheckpoint({
            cwd: input.cwd,
            receipt: analysis.receipt as Extract<PublishReceipt, { version: 4 | 5 }>,
            remoteMarkdown: checkpointState.canonicalRemote,
            remoteRevision: checkpointState.remoteRaw.revision,
            remoteSemantic: checkpointState.remoteSemantic,
            checkpoint: {
              planFingerprint: semanticHash({
                documentId: analysis.resolvedDocumentId,
                localSourceHash: hashText(analysis.localSource),
                publishDraftHash: hashText(analysis.publishDraft),
                startingRemoteHash: hashText(analysis.remote.markdown),
                startingRemoteRevision: analysis.remote.revision,
                operations: plan.scopedPatch?.operations.map(summarizeScopedOperation) ?? []
              }),
              completedOperations,
              ...(checkpointState.remoteRaw.revision
                ? { remoteRevision: checkpointState.remoteRaw.revision }
                : {}),
              updatedAt
            }
          });
          recoveryCheckpoint.written = true;
          recoveryCheckpoint.revision = checkpointState.remoteRaw.revision;
        }
      : undefined;
    let completedOperations = await applyScopedOperations({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      operations: [...phases.updates, ...phases.creates, ...phases.moves, ...phases.tables],
      callouts,
      recordCheckpoint,
      recoveryCheckpoint,
      verifiedOperations: checkpointVerifiedOperations,
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
      completedOperations,
      recordCheckpoint,
      recoveryCheckpoint,
      verifiedOperations: checkpointVerifiedOperations
    });
    const afterMarkdownRaw = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    const afterSemantic = applyTrackedCalloutTypes(
      await fetchRemoteSemantic(input.adapter, analysis.resolvedDocumentId, callouts),
      analysis.remoteCurrent
    );
    let protectedResources = analysis.protectedResources?.entries ??
      protectedResourceEntries(analysis.receipt);
    if (analysis.protectedResources) {
      const verified = planProtectedResources({
        local: analysis.localCurrent,
        remote: afterSemantic,
        receiptEntries: analysis.protectedResources.entries
      });
      if (verified.blockers.length > 0) {
        throw new Error(
          `Protected Supademo readback failed: ${verified.blockers.map(({ message }) => message).join('; ')}`
        );
      }
      protectedResources = verified.entries;
    }
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
      publishContext: analysis.publishContext,
      publishDraft: analysis.publishDraft,
      remoteMarkdown: afterMarkdown.markdown,
      remoteRevision: afterMarkdown.revision,
      remoteSemantic: afterSemantic,
      whiteboards: input.syncWhiteboards
        ? whiteboardResult.entries
        : whiteboardEntries(analysis.receipt),
      protectedResources
    };
    await recordPublishReceiptV4(receiptInput);
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
      await recordPublishReceiptV4({
        cwd: input.cwd,
        target: input.target,
        resolvedDocumentId: analysis.resolvedDocumentId,
        profile: input.profile,
        publishContext: analysis.publishContext,
        publishDraft: analysis.publishDraft,
        remoteMarkdown: after.markdown,
        remoteRevision: after.revision,
        remoteSemantic: afterSemantic,
        whiteboards: []
      });
    } else {
      const normalized = canonicalizeRemoteCalloutMarkdown({
        markdown: afterRaw.markdown,
        config: input.callouts ?? DEFAULT_CALLOUT_CONFIG
      });
      const after = { ...afterRaw, markdown: normalized.markdown };
      await recordPublishReceiptV4({
        cwd: input.cwd,
        target: input.target,
        resolvedDocumentId: analysis.resolvedDocumentId,
        profile: input.profile,
        publishContext: analysis.publishContext,
        publishDraft: analysis.publishDraft,
        remoteMarkdown: after.markdown,
        remoteRevision: after.revision,
        whiteboards: []
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
  const requiresTrackedWhiteboardProtection = publishContext.dialect === 'zdoc-authoring' &&
    whiteboardEntries(receipt).length > 0;

  if (input.strategy === 'document-replace') {
    const normalized = canonicalizeRemoteCalloutMarkdown({ markdown: remoteRaw.markdown, config: callouts });
    const remote = { ...remoteRaw, markdown: normalized.markdown };
    const blockPatchDraft = markdownBodyForBlockPatch(
      transform.markdown,
      remote.markdown,
      publishContext.documentTitle
    );
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
    const blockPatchDraft = markdownBodyForBlockPatch(
      transform.markdown,
      remote.markdown,
      publishContext.documentTitle
    );
    const whiteboards = input.syncWhiteboards || requiresTrackedWhiteboardProtection
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
    const blockPatchDraft = markdownBodyForBlockPatch(
      transform.markdown,
      remote.markdown,
      publishContext.documentTitle
    );
    const message = error instanceof Error ? error.message : String(error);
    const whiteboards = input.syncWhiteboards || requiresTrackedWhiteboardProtection
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
  const remoteCurrentRaw = applyTrackedCalloutTypes(
    remoteSemanticDocument(remoteBlocks.blocks, resolvedDocumentId, callouts, remoteCodeMetadata),
    remoteBaseHint
  );
  const codeBlocks = input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG;
  const localDraftDocument = localSemanticDocument(
    transform.markdown,
    codeBlocks,
    publishContext.zdoc?.inventory
  );
  const remoteCurrent = applyManagedCalloutMetadata(remoteCurrentRaw, localDraftDocument);
  const localCalloutHints = localDraftDocument.nodes
    .filter((node) => node.kind === 'callout')
    .map((node) => node.titleManaged ? node.calloutType : undefined);
  const remoteCalloutHints = calloutTypeHints(remoteCurrent);
  const normalized = canonicalizeRemoteCalloutMarkdown({
    markdown: remoteRaw.markdown,
    config: callouts,
    typeHints: remoteCalloutHints.map((hint, index) => hint ?? localCalloutHints[index])
  });
  const remote = { ...remoteRaw, markdown: normalized.markdown };
  const blockPatchDraft = markdownBodyForBlockPatch(
    transform.markdown,
    remote.markdown,
    publishContext.documentTitle
  );
  const localCurrent = localSemanticDocument(
    blockPatchDraft,
    codeBlocks,
    publishContext.zdoc?.inventory
  );
  const protectedResources = publishContext.zdoc
    ? planProtectedResources({
        local: localCurrent,
        remote: remoteCurrent,
        receiptEntries: protectedResourceEntries(receipt)
      })
    : undefined;
  const baseline = await loadSemanticBaselines({
    cwd: input.cwd,
    receipt,
    profile: input.profile,
    currentLocalSource: localSource,
    currentRemoteMarkdown: remote.markdown,
    currentRemoteSemantic: remoteCurrent,
    codeBlocks,
    documentTitle: publishContext.documentTitle,
    zdoc: publishContext.zdoc?.inventory
  });
  const scopedPatch = baseline.blocker
    ? blockedScopedPatch(baseline.blocker)
    : planScopedPatch({
      parentBlockId: page.block_id,
      localBase: baseline.localBase,
      localCurrent,
      remoteBase: baseline.remoteBase,
      remoteCurrent,
      tracked: Boolean(receipt),
      supportsBlockMove: Boolean(input.adapter.moveBlocksAfter)
    });
  const zdocRoundTrip = publishContext.zdoc
    ? buildZdocReport(publishContext.zdoc.inventory, scopedPatch, protectedResources)
    : undefined;
  const whiteboardIntent = input.syncWhiteboards
    ? 'sync' as const
    : publishContext.dialect === 'zdoc-authoring'
      ? 'protect' as const
      : undefined;
  const whiteboardAnalysis: { plan?: WhiteboardPlan; assets?: LocalWhiteboardAsset[] } = whiteboardIntent
    ? await analyzeWhiteboards({
      file: input.file,
      localSource,
      localCurrent,
      remoteCurrent,
      receipt,
      adapter: input.adapter,
      intent: whiteboardIntent,
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
    whiteboards: whiteboardAnalysis.plan,
    zdocRoundTrip
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
    whiteboardAssets: whiteboardAnalysis.assets,
    protectedResources
  };
}

async function analyzeWhiteboards(input: {
  file: string;
  localSource: string;
  localCurrent: SemanticDocument;
  remoteCurrent: SemanticDocument;
  receipt: PublishReceipt | undefined;
  adapter: FeishuAdapter;
  intent: 'sync' | 'protect';
  confirmedRemoteWhiteboardOverwrites: string[];
}): Promise<{ plan: WhiteboardPlan; assets: LocalWhiteboardAsset[] }> {
  if (input.intent === 'sync' && !input.adapter.docxTransport &&
    (!input.adapter.queryWhiteboard || !input.adapter.updateWhiteboard || !input.adapter.replaceImageWithWhiteboard)) {
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
    tracked,
    includeDirectSvg: true
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
  for (const token of input.intent === 'sync' ? tokens : []) {
    try {
      const remote = await input.adapter.queryWhiteboard!({ whiteboardToken: token });
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
      intent: input.intent,
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
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
}): Promise<RunPublishResult> {
  const title = resolvePublishTitle({
    sourcePath: input.file,
    markdown: input.publishContext.publishDraft
  }).title;
  const createProcedures = input.publishContext.zdoc
    ? planCreateProcedures({
        publishContext: input.publishContext,
        codeBlocks: input.codeBlocks
      })
    : undefined;
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    ...publishPlanDialectFields(input.publishContext),
    localSource: input.publishContext.localSource,
    publishDraft: input.publishContext.publishDraft,
    remoteMarkdown: '',
    receipt: undefined,
    transformWarnings: input.publishContext.transformWarnings,
    createDocument: true,
    zdocRoundTrip: input.publishContext.zdoc
      ? buildZdocRoundTripReport({
          inventory: input.publishContext.zdoc.inventory,
          procedures: createProcedures ?? { operations: [], blockers: [] }
        })
      : undefined
  });
  if (!input.write) return { mode: 'dry-run', plan };
  if (plan.zdocRoundTrip?.safeToPublish === false) {
    throw new Error(`Scoped publish is blocked: ${plan.risks.join('; ')}`);
  }
  if (input.publishContext.zdoc && !input.adapter.fetchDocBlocks) {
    throw new Error('Zdoc document creation requires Docx block reads for round-trip verification.');
  }

  const created = await input.adapter.createDocument({
    title,
    markdown: input.publishContext.publishDraft,
    parentToken: input.target.token
  });
  const createdTarget = { kind: 'docx' as const, token: created.documentId };
  const createdDocument = {
    documentId: created.documentId,
    ...(created.url ? { url: created.url } : {})
  };
  if (input.publishContext.zdoc) {
    let initial: PublishAnalysis;
    let operations: ScopedPatchOperation[];
    try {
      initial = await analyzeExistingPublish({
        cwd: input.cwd,
        file: input.file,
        target: createdTarget,
        profile: input.profile,
        dialect: input.publishContext.dialect,
        strategy: 'auto',
        adapter: input.adapter,
        publishContext: input.publishContext,
        callouts: input.callouts,
        codeBlocks: input.codeBlocks
      });
      if (initial.plan.zdocRoundTrip?.safeToPublish === false ||
        !initial.plan.scopedPatch?.safeToWrite) {
        throw new Error(`Created Zdoc failed round-trip planning: ${initial.plan.risks.join('; ')}`);
      }
      operations = initial.plan.scopedPatch.operations;
      const unsupportedOperations = operations.filter((operation) => {
        return operation.kind !== 'callout-create' && operation.kind !== 'authoring-token-create';
      });
      if (unsupportedOperations.length > 0) {
        throw new Error(
          `Created Zdoc requires unsupported post-create mutations: ${JSON.stringify(unsupportedOperations)}`
        );
      }
    } catch (error) {
      throw new PartialWriteError({
        completedOperations: [{ kind: 'document-create' }],
        failedOperation: { kind: 'created-document-planning' },
        document: createdDocument,
        cause: error
      });
    }
    let completedOperations: PublishWriteOperationSummary[] = [];
    if (operations.length > 0) {
      try {
        completedOperations = await applyScopedOperations({
          adapter: input.adapter,
          doc: created.documentId,
          operations,
          callouts: input.callouts ?? DEFAULT_CALLOUT_CONFIG
        });
      } catch (error) {
        if (error instanceof PartialWriteError) {
          throw new PartialWriteError({
            completedOperations: [
              { kind: 'document-create' },
              ...error.completedOperations
            ],
            failedOperation: error.failedOperation,
            pendingOperations: error.pendingOperations,
            document: createdDocument,
            cause: error
          });
        }
        throw new PartialWriteError({
          completedOperations: [{ kind: 'document-create' }],
          failedOperation: operations[0]
            ? summarizeScopedOperation(operations[0])
            : { kind: 'created-document-planning' },
          pendingOperations: operations.slice(1).map(summarizeScopedOperation),
          document: createdDocument,
          cause: error
        });
      }
    }
    let verified: PublishAnalysis;
    try {
      verified = await analyzeExistingPublish({
        cwd: input.cwd,
        file: input.file,
        target: createdTarget,
        profile: input.profile,
        dialect: input.publishContext.dialect,
        strategy: 'auto',
        adapter: input.adapter,
        publishContext: input.publishContext,
        callouts: input.callouts,
        codeBlocks: input.codeBlocks
      });
      if (verified.plan.zdocRoundTrip?.safeToPublish !== true ||
        !verified.plan.scopedPatch?.safeToWrite ||
        verified.plan.scopedPatch.operations.length > 0 ||
        !verified.remoteCurrent) {
        throw new Error('Created Zdoc failed final round-trip verification.');
      }
    } catch (error) {
      throw new PartialWriteError({
        completedOperations: [
          { kind: 'document-create' },
          ...completedOperations
        ],
        failedOperation: { kind: 'created-document-readback' },
        document: createdDocument,
        cause: error
      });
    }
    try {
      await recordPublishReceiptV4({
        cwd: input.cwd,
        target: createdTarget,
        resolvedDocumentId: created.documentId,
        profile: input.profile,
        publishContext: input.publishContext,
        publishDraft: input.publishContext.publishDraft,
        remoteMarkdown: verified.remote.markdown,
        remoteRevision: verified.remote.revision ?? created.revision,
        remoteSemantic: verified.remoteCurrent,
        whiteboards: [],
        protectedResources: verified.protectedResources?.entries
      });
    } catch (error) {
      throw new PartialWriteError({
        completedOperations: [
          { kind: 'document-create' },
          ...completedOperations
        ],
        failedOperation: { kind: 'receipt-write' },
        document: createdDocument,
        cause: error
      });
    }
  } else {
    const after = await input.adapter.fetchDocMarkdown({ doc: created.documentId });
    const semantic = input.adapter.fetchDocBlocks
      ? await fetchRemoteSemantic(input.adapter, created.documentId)
      : undefined;
    await recordPublishReceiptV4({
      cwd: input.cwd,
      target: createdTarget,
      resolvedDocumentId: created.documentId,
      profile: input.profile,
      publishContext: input.publishContext,
      publishDraft: input.publishContext.publishDraft,
      remoteMarkdown: after.markdown,
      remoteRevision: after.revision ?? created.revision,
      ...(semantic ? { remoteSemantic: semantic } : {}),
      whiteboards: []
    });
  }
  return {
    mode: 'write',
    plan,
    document: { documentId: created.documentId, url: created.url }
  };
}

function planCreateProcedures(input: {
  publishContext: PublishContext;
  codeBlocks?: CodeBlockConfig;
}) {
  const inventory = input.publishContext.zdoc?.inventory;
  if (!inventory) return { operations: [], blockers: [] };
  const local = localSemanticDocument(
    input.publishContext.publishDraft,
    input.codeBlocks,
    inventory
  );
  const remote: SemanticDocument = {
    nodes: local.nodes.flatMap((node, index) => {
      if (node.kind === 'authoring-token' || node.kind === 'protected-resource') return [];
      return [{ ...node, remoteBlockId: `create-preflight-${index}` }];
    })
  };
  return planProceduresChanges({
    parentBlockId: 'create-preflight-document',
    local,
    remote
  });
}

async function loadSemanticBaselines(input: {
  cwd: string;
  receipt: PublishReceipt | undefined;
  profile: PublishProfileName;
  currentLocalSource: string;
  currentRemoteMarkdown: string;
  currentRemoteSemantic: SemanticDocument;
  codeBlocks: CodeBlockConfig;
  documentTitle?: string;
  zdoc?: ZdocComponentInventory;
}): Promise<{ localBase?: SemanticDocument; remoteBase?: SemanticDocument; blocker?: string }> {
  if (!input.receipt) return {};

  if (input.receipt.version === 4 || input.receipt.version === 5) {
    const publishBase = await readPublishBaseSnapshot({
      cwd: input.cwd,
      snapshot: input.receipt.publishBaseSnapshot
    });
    if (!publishBase) return { blocker: 'publish draft baseline unavailable' };
    const localBase = localSemanticDocument(
      markdownBodyForBlockPatch(publishBase, input.currentRemoteMarkdown, input.documentTitle),
      input.codeBlocks,
      input.zdoc
    );
    const remoteBaseRaw = input.receipt.remoteSemanticSnapshot
      ? await readRemoteSemanticSnapshot({
          cwd: input.cwd,
          snapshot: input.receipt.remoteSemanticSnapshot
        })
      : undefined;
    if (!remoteBaseRaw) return { blocker: 'remote semantic baseline unavailable' };
    const remoteBase = applyManagedCalloutMetadata(remoteBaseRaw, localBase);
    return { localBase, remoteBase };
  }

  let localBaseSource = input.receipt.localBaseSnapshot
    ? await readLocalBaseSnapshot({ cwd: input.cwd, snapshot: input.receipt.localBaseSnapshot })
    : undefined;
  if (!localBaseSource && input.receipt.localSourceHash === hashText(input.currentLocalSource)) {
    localBaseSource = input.currentLocalSource;
  }
  if (!localBaseSource) return { blocker: 'legacy local baseline unavailable' };

  const localBaseDraft = applyPublishTransformForProfile(localBaseSource, input.profile).markdown;
  const localBase = localSemanticDocument(
    markdownBodyForBlockPatch(localBaseDraft, input.currentRemoteMarkdown, input.documentTitle),
    input.codeBlocks,
    input.zdoc
  );
  if (input.receipt.version === 2 || input.receipt.version === 3) {
    const remoteBaseRaw = await readRemoteSemanticSnapshot({
      cwd: input.cwd,
      snapshot: input.receipt.remoteSemanticSnapshot
    });
    if (!remoteBaseRaw) return { blocker: 'remote semantic baseline unavailable' };
    const remoteBase = applyManagedCalloutMetadata(remoteBaseRaw, localBase);
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
  if (!hasRemoteSemanticSnapshot(input.receipt)) return undefined;
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
    roundTripLosses: [],
    requiresCollaborationRiskConfirmation: false,
    scopeSummary: {
      localChanged: [],
      remoteChanged: [],
      overlappingConflicts: [],
      unrelatedRemoteChanges: []
    }
  };
}

function buildZdocReport(
  inventory: ZdocComponentInventory,
  scopedPatch: ScopedPatchPlan,
  protectedResources?: ReturnType<typeof planProtectedResources>
) {
  return buildZdocRoundTripReport({
    inventory,
    roundTripLosses: scopedPatch.roundTripLosses,
    procedures: {
      operations: scopedPatch.operations.filter((operation) =>
        operation.kind === 'authoring-token-create' ||
        operation.kind === 'authoring-token-move' ||
        operation.kind === 'authoring-token-delete'
      ),
      blockers: scopedPatch.blockers.flatMap((blocker) => {
        if (blocker.code !== 'procedures-anchor-missing' &&
          blocker.code !== 'procedures-boundary-ambiguous' &&
          blocker.code !== 'procedures-move-unsupported') return [];
        return [{ code: blocker.code, message: blocker.message }];
      })
    },
    protectedResources
  });
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
    if (operation.kind === 'update' || operation.kind === 'callout-title-update' ||
      operation.kind === 'callout-child-update' || operation.kind === 'code-update') {
      result.updates.push(operation);
    } else if (operation.kind === 'create' || operation.kind === 'callout-create' ||
      operation.kind === 'callout-child-create' || operation.kind === 'code-create' ||
      operation.kind === 'authoring-token-create') {
      result.creates.push(operation);
    } else if (operation.kind === 'code-section-reconcile') {
      result.moves.push({ ...operation, phase: 'place' });
      result.deletes.push({ ...operation, phase: 'delete' });
    } else if (operation.kind === 'code-move' || operation.kind === 'authoring-token-move') {
      result.moves.push(operation);
    } else if (operation.kind === 'table-replace' || operation.kind === 'table-create') result.tables.push(operation);
    else result.deletes.push(operation);
  }
  return result;
}

export async function applyScopedOperations(input: {
  adapter: FeishuAdapter;
  doc: string;
  operations: ScopedPatchOperation[];
  callouts: CalloutConfig;
  completedOperations?: PublishWriteOperationSummary[];
  pendingAfter?: PublishWriteOperationSummary[];
  recordCheckpoint?: (
    completedOperations: PublishWriteOperationSummary[],
    verifiedOperations: ScopedPatchOperation[]
  ) => Promise<void>;
  recoveryCheckpoint?: { written: boolean; revision?: string };
  verifiedOperations?: ScopedPatchOperation[];
}): Promise<PublishWriteOperationSummary[]> {
  if (!input.adapter.fetchDocBlocks || (!input.adapter.docxTransport &&
    (!input.adapter.replaceBlock || !input.adapter.insertBlocksAfter || !input.adapter.deleteBlocks))) {
    throw new Error('Configured Feishu adapter does not support scoped block-patch writes');
  }
  const completed = [...(input.completedOperations ?? [])];
  const verifiedOperations = input.verifiedOperations ?? [];
  for (let index = 0; index < input.operations.length; index += 1) {
    const operation = input.operations[index]!;
    const summary = summarizeScopedOperation(operation);
    try {
      if (operation.kind === 'update') {
        const before = await input.adapter.fetchDocBlocks({ doc: input.doc });
        if (operation.recoveryExpectedRemoteMarkdown) {
          verifyRecoveryUpdatePreflight(operation, before.blocks, input.doc, input.callouts);
        }
      } else if (operation.kind === 'delete') {
        const before = await input.adapter.fetchDocBlocks({ doc: input.doc });
        if (operation.recovery) {
          verifyRecoveryDeletePreflight(operation, before.blocks, input.doc, input.callouts);
        }
      } else if (operation.kind === 'table-create') {
        const before = await input.adapter.fetchDocBlocks({ doc: input.doc });
        verifyTableCreateAnchors(operation, before.blocks, input.doc);
      }

      if (operation.kind === 'code-section-reconcile') {
        await applyCodeSectionReconcileThroughEngine({
          adapter: input.adapter,
          doc: input.doc,
          operation,
          callouts: input.callouts,
          completedOperations: completed,
          verifiedOperations,
          recordCheckpoint: input.recordCheckpoint,
          recoveryCheckpoint: input.recoveryCheckpoint,
          pendingAfter: [
            ...input.operations.slice(index + 1).map(summarizeScopedOperation),
            ...(input.pendingAfter ?? [])
          ]
        });
        verifyCodeOperation(operation, await fetchRemoteSemantic(input.adapter, input.doc, input.callouts));
        completed.push(summary);
        verifiedOperations.push(operation);
        if (input.recordCheckpoint) {
          try {
            await input.recordCheckpoint(completed, verifiedOperations);
          } catch (error) {
            throw new PartialWriteError({
              completedOperations: completed,
              failedOperation: { kind: 'receipt-write' },
              pendingOperations: [
                ...input.operations.slice(index + 1).map(summarizeScopedOperation),
                ...(input.pendingAfter ?? [])
              ],
              recoveryCheckpointWritten: input.recoveryCheckpoint?.written,
              recoveryCheckpointRevision: input.recoveryCheckpoint?.revision,
              cause: error
            });
          }
        }
      } else {
        await applyScopedOperationThroughEngine({
          adapter: input.adapter,
          doc: input.doc,
          operation,
          callouts: input.callouts,
          completedOperations: completed,
          verifiedOperations,
          recordCheckpoint: input.recordCheckpoint,
          recoveryCheckpoint: input.recoveryCheckpoint,
          pendingAfter: [
            ...input.operations.slice(index + 1).map(summarizeScopedOperation),
            ...(input.pendingAfter ?? [])
          ]
        });
      }
    } catch (error) {
      if (error instanceof PartialWriteError) {
        throw error;
      }
      if (completed.length === 0) throw error;
      throw new PartialWriteError({
        completedOperations: completed,
        failedOperation: summary,
        pendingOperations: [
          ...input.operations.slice(index + 1).map(summarizeScopedOperation),
          ...(input.pendingAfter ?? [])
        ],
        recoveryCheckpointWritten: input.recoveryCheckpoint?.written,
        recoveryCheckpointRevision: input.recoveryCheckpoint?.revision,
        cause: error
      });
    }
  }
  return completed;
}

async function applyScopedOperationThroughEngine(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: Exclude<ScopedPatchOperation, { kind: 'code-section-reconcile' }>;
  callouts: CalloutConfig;
  completedOperations: PublishWriteOperationSummary[];
  verifiedOperations: ScopedPatchOperation[];
  recordCheckpoint?: (
    completedOperations: PublishWriteOperationSummary[],
    verifiedOperations: ScopedPatchOperation[]
  ) => Promise<void>;
  recoveryCheckpoint?: { written: boolean; revision?: string };
  pendingAfter: PublishWriteOperationSummary[];
}): Promise<void> {
  const engine = createFeishuDocxEngine({ transport: docxTransportForAdapter(input.adapter) });
  const resolution = await resolveScopedEngineOperation(input);
  const snapshot = await engine.snapshot({ kind: 'docx', token: input.doc });
  const intents = scopedOperationToMutationIntents({
    operation: input.operation,
    snapshot,
    callouts: input.callouts,
    ...resolution
  });
  const operationsById = new Map(intents.map((intent) => [intent.operationId, input.operation] as const));
  const durableJournal = createDocxEngineJournal({
    operationsById,
    completedOperations: input.completedOperations,
    verifiedOperations: input.verifiedOperations,
    recordCheckpoint: input.recordCheckpoint,
    summarize: summarizeScopedOperation
  });
  const tableOperation = input.operation.kind === 'table-replace' || input.operation.kind === 'table-create';
  let bufferedEvidence: import('feishu-docx-engine').VerifiedOperationEvidence | undefined;
  const journal: MutationJournal = tableOperation
    ? { recordVerified: async (evidence) => { bufferedEvidence = evidence; } }
    : durableJournal;
  const batch = engine.prepare({
    snapshot,
    operations: intents,
    idempotencyNamespace: `feishu-md-sync:${input.doc}`
  });
  try {
    await engine.apply({ batch, journal });
    if (tableOperation) {
      if (!bufferedEvidence) throw new Error('Docx engine did not journal verified table evidence.');
      try {
        await verifyScopedOperationReadback({
          adapter: input.adapter,
          doc: input.doc,
          operation: input.operation,
          callouts: input.callouts,
          mutationRevision: lastDocxEngineProviderRevision(input.adapter) ??
            (input.adapter.docxTransport ? bufferedEvidence.revision : undefined)
        });
      } catch (cause) {
        throw tablePostApplyPartialWriteError({ ...input, cause, checkpointFailure: false });
      }
      try {
        await durableJournal.recordVerified(bufferedEvidence);
      } catch (cause) {
        throw tablePostApplyPartialWriteError({ ...input, cause, checkpointFailure: true });
      }
    }
  } catch (error) {
    if (error instanceof PartialMutationError) {
      if ((input.operation.kind === 'table-replace' || input.operation.kind === 'table-create') &&
        error.evidence.failedOperation.kind === 'verification') {
        try {
          await verifyScopedOperationReadback({
            adapter: input.adapter,
            doc: input.doc,
            operation: input.operation,
            callouts: input.callouts,
            mutationRevision: lastDocxEngineProviderRevision(input.adapter) ??
              (input.adapter.docxTransport ? error.evidence.lastObservedRevision : undefined)
          });
        } catch (cause) {
          throw tablePostApplyPartialWriteError({ ...input, cause, checkpointFailure: false });
        }
        const recovered = await engine.snapshot({ kind: 'docx', token: input.doc });
        try {
          await durableJournal.recordVerified({
            operationId: intents[0]!.operationId,
            createdBlockIds: [...error.evidence.createdBlockIds],
            revision: recovered.revision,
            afterSnapshotHash: recovered.canonicalHash,
            verified: true
          });
        } catch (cause) {
          throw tablePostApplyPartialWriteError({ ...input, cause, checkpointFailure: true });
        }
        return;
      }
      throw enginePartialWriteError({
        error,
        operationsById,
        completedOperations: input.completedOperations,
        pendingAfter: input.pendingAfter,
        recoveryCheckpoint: input.recoveryCheckpoint,
        summarize: summarizeScopedOperation,
        readbackSummary: readbackFailureSummary(input.operation),
        unplannedAsCheckpointFailure: input.recordCheckpoint !== undefined
      });
    }
    throw bridgeEngineCause(error);
  }
}

function tablePostApplyPartialWriteError(input: {
  operation: Exclude<ScopedPatchOperation, { kind: 'code-section-reconcile' }>;
  completedOperations: PublishWriteOperationSummary[];
  pendingAfter: PublishWriteOperationSummary[];
  recoveryCheckpoint?: { written: boolean; revision?: string };
  checkpointFailure: boolean;
  cause: unknown;
}): PartialWriteError {
  return new PartialWriteError({
    completedOperations: [
      ...input.completedOperations,
      summarizeScopedOperation(input.operation)
    ],
    failedOperation: input.checkpointFailure
      ? { kind: 'receipt-write' }
      : readbackFailureSummary(input.operation),
    pendingOperations: input.pendingAfter,
    recoveryCheckpointWritten: input.recoveryCheckpoint?.written,
    recoveryCheckpointRevision: input.recoveryCheckpoint?.revision,
    cause: input.cause
  });
}

async function resolveScopedEngineOperation(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: Exclude<ScopedPatchOperation, { kind: 'code-section-reconcile' }>;
  callouts: CalloutConfig;
}): Promise<{
  resolvedParentBlockId?: string;
  resolvedInsertAfterBlockId?: string;
  resolvedRemoteBlockId?: string;
}> {
  const operation = input.operation;
  if (operation.kind === 'create' || operation.kind === 'callout-create') {
    return {
      resolvedInsertAfterBlockId: await resolveCurrentInsertionAnchor({
        adapter: input.adapter,
        doc: input.doc,
        originalBlockId: operation.insertAfterBlockId,
        afterLocator: operation.afterLocator,
        callouts: input.callouts
      })
    };
  }
  if (operation.kind !== 'code-create' && operation.kind !== 'code-update' &&
    operation.kind !== 'code-move' && operation.kind !== 'code-delete') return {};

  const remote = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
  if (operation.kind === 'code-create') {
    const anchor = resolveAnchorBlockId(
      remote,
      operation.afterLocator,
      input.doc,
      operation.afterCodeFingerprint
    );
    return {
      resolvedParentBlockId: parentBlockIdForAnchor(
        await createFeishuDocxEngine({ transport: docxTransportForAdapter(input.adapter) })
          .snapshot({ kind: 'docx', token: input.doc }),
        anchor
      ),
      resolvedInsertAfterBlockId: anchor
    };
  }
  const matched = resolveRemoteCode(remote, operation);
  if (!matched.remoteBlockId) throw new Error('Code block write cannot resolve a current remote block ID.');
  if (operation.kind === 'code-move') {
    return {
      resolvedRemoteBlockId: matched.remoteBlockId,
      resolvedInsertAfterBlockId: resolveAnchorBlockId(
        remote,
        operation.afterLocator,
        input.doc,
        operation.afterCodeFingerprint,
        matched.remoteBlockId
      )
    };
  }
  return { resolvedRemoteBlockId: matched.remoteBlockId };
}

function parentBlockIdForAnchor(snapshot: DocumentSnapshot, anchorBlockId: string): string {
  if (anchorBlockId === snapshot.rootBlockId) return snapshot.rootBlockId;
  const anchor = snapshot.nodes.find((node) => node.blockId === anchorBlockId);
  if (!anchor?.parentBlockId) throw new Error(`Code insertion anchor ${anchorBlockId} has no parent.`);
  return anchor.parentBlockId;
}

async function verifyScopedOperationReadback(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: ScopedPatchOperation;
  callouts: CalloutConfig;
  mutationRevision?: string;
  textUpdateReadback?: TextUpdateReadbackExpectation;
}): Promise<void> {
  const retryDelays = input.operation.kind === 'table-replace'
    ? TABLE_READBACK_RETRY_DELAYS_MS
    : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (input.operation.kind === 'table-replace' && input.mutationRevision) {
        const remote = await withRateLimitRetry(() => input.adapter.fetchDocMarkdown({ doc: input.doc }));
        if (!revisionHasReached(remote.revision, input.mutationRevision)) {
          throw new Error(
            `scoped readback verification is waiting for remote revision ${input.mutationRevision}; ` +
            `observed ${remote.revision ?? 'unknown'}`
          );
        }
      }
      const blocks = await withRateLimitRetry(() => input.adapter.fetchDocBlocks!({ doc: input.doc }));
      verifyOperation(
        input.operation,
        blocks.blocks,
        input.doc,
        input.callouts,
        input.textUpdateReadback
      );
      return;
    } catch (error) {
      const delayMs = retryDelays[attempt];
      if (delayMs === undefined || !isTransientTableReadbackError(error)) throw error;
      await delay(delayMs);
    }
  }
}

function isTransientTableReadbackError(error: unknown): boolean {
  if (isCheckpointReadTransientError(error)) return true;
  if (error && typeof error === 'object') {
    const details = (error as { details?: { retryable?: unknown } }).details;
    if (details?.retryable === true) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /scoped readback verification failed: remote table differs from desired table/i.test(message) ||
    /scoped readback verification is waiting for remote revision/i.test(message);
}

function revisionHasReached(observed: string | undefined, expected: string): boolean {
  if (!observed) return false;
  if (/^\d+$/.test(observed) && /^\d+$/.test(expected)) {
    return BigInt(observed) >= BigInt(expected);
  }
  return observed === expected;
}

function verifyCheckpointOperations(input: {
  operations: ScopedPatchOperation[];
  remoteBlocks: import('../feishu/types.js').FeishuBlock[];
  remoteSemantic: SemanticDocument;
  documentId: string;
  callouts: CalloutConfig;
}): void {
  for (const operation of input.operations) {
    if (operation.kind === 'code-update' || operation.kind === 'code-create' ||
      operation.kind === 'code-move' || operation.kind === 'code-delete' ||
      operation.kind === 'code-section-reconcile') {
      verifyCodeOperation(operation, input.remoteSemantic);
      continue;
    }
    if (operation.kind === 'update') {
      verifyCheckpointTextUpdate(operation, input.remoteSemantic);
      continue;
    }
    let currentOperation = operation;
    if ((operation.kind === 'create' || operation.kind === 'callout-create') && operation.afterLocator) {
      const anchor = input.remoteSemantic.nodes.find((node) => sameLocator(node.locator, operation.afterLocator!));
      if (!anchor?.remoteBlockId) {
        throw new Error(`checkpoint create anchor is no longer resolvable at ${locatorKey(operation.afterLocator)}`);
      }
      currentOperation = { ...operation, insertAfterBlockId: anchor.remoteBlockId };
    }
    verifyOperation(
      currentOperation,
      input.remoteBlocks,
      input.documentId,
      input.callouts
    );
  }
}

function verifyCheckpointTextUpdate(
  operation: Extract<ScopedPatchOperation, { kind: 'update' }>,
  remote: SemanticDocument
): void {
  const path = operation.locator.textPath ?? [];
  const root = remote.nodes.find((node): node is SemanticTextBlock => {
    return node.kind === 'text' &&
      JSON.stringify(node.locator.sectionPath) === JSON.stringify(operation.locator.sectionPath) &&
      node.locator.ordinal === operation.locator.ordinal;
  });
  if (!root) throw new Error('scoped readback verification failed: checkpoint text locator is missing');
  let target: SemanticTextBlock | SemanticTextChild = root;
  let parentBlockId: string | undefined;
  for (const index of path) {
    parentBlockId = target.remoteBlockId;
    const children = target.children;
    const child = children?.[index];
    if (!child) throw new Error('scoped readback verification failed: checkpoint text path is missing');
    target = child;
  }
  if (path.length > 0 && parentBlockId !== operation.parentBlockId) {
    throw new Error('scoped readback verification failed: checkpoint text parent changed');
  }
  if (!target.remoteBlockId ||
    canonicalMarkdown(target.markdown) !== canonicalMarkdown(operation.desiredMarkdown)) {
    throw new Error('scoped readback verification failed: remote text differs from desired text');
  }
}

export function assertCheckpointHasNoUnrelatedChanges(
  baseline: SemanticDocument | undefined,
  current: SemanticDocument,
  operations: ScopedPatchOperation[]
): void {
  if (!baseline) throw new Error('Partial-write recovery checkpoint requires a remote semantic baseline.');
  const allowedLocators = new Set(operations.flatMap((operation) => {
    if ((operation.kind === 'code-move' || operation.kind === 'code-delete') && operation.remoteBlockId) {
      return [];
    }
    if (operation.kind === 'callout-delete' && operation.blockIds.length > 0) return [];
    if (operation.kind === 'code-section-reconcile') return [];
    return [operation.locator].map(locatorKey);
  }));
  const allowedBlockIds = new Set(operations.flatMap((operation) => {
    const direct = 'remoteBlockId' in operation && operation.remoteBlockId
      ? [operation.remoteBlockId]
      : [];
    const deleted = 'blockIds' in operation ? operation.blockIds : [];
    const reconciled = operation.kind === 'code-section-reconcile'
      ? operation.remoteCodes.flatMap((code) => code.remoteBlockId ? [code.remoteBlockId] : [])
      : [];
    return [...direct, ...deleted, ...reconciled];
  }));
  const reconciledCodeSections = operations.flatMap((operation) => {
    return operation.kind === 'code-section-reconcile' ? operation.sectionPaths : [];
  });
  const structurallyChangedCodeSections = operations.flatMap((operation) => {
    if (operation.kind === 'code-move') {
      return [operation.sourceLocator.sectionPath, operation.locator.sectionPath];
    }
    if (operation.kind === 'code-create') return [operation.locator.sectionPath];
    if (operation.kind === 'code-delete') return [operation.sourceLocator.sectionPath];
    return [];
  });
  const structurallyChangedCalloutSections = operations.flatMap((operation) => {
    return operation.kind === 'callout-create' || operation.kind === 'callout-delete'
      ? [operation.locator.sectionPath]
      : [];
  });
  const outside = (document: SemanticDocument): unknown => {
    const codeOrdinals = new Map<string, number>();
    const calloutOrdinals = new Map<string, number>();
    const nodes = document.nodes.filter((node) => {
      if (allowedLocators.has(locatorKey(node.locator))) return false;
      if (node.remoteBlockId && allowedBlockIds.has(node.remoteBlockId)) return false;
      if (node.kind === 'code' && reconciledCodeSections.some((sectionPath) => {
        return sameSectionPath(node.locator.sectionPath, sectionPath);
      })) return false;
      return true;
    }).map((node) => {
      if (node.kind === 'callout' && structurallyChangedCalloutSections.some((sectionPath) => {
        return sameSectionPath(node.locator.sectionPath, sectionPath);
      })) {
        const sectionKey = JSON.stringify(node.locator.sectionPath);
        const ordinal = calloutOrdinals.get(sectionKey) ?? 0;
        calloutOrdinals.set(sectionKey, ordinal + 1);
        return { ...node, locator: { ...node.locator, ordinal } };
      }
      if (node.kind !== 'code' || !structurallyChangedCodeSections.some((sectionPath) => {
        return sameSectionPath(node.locator.sectionPath, sectionPath);
      })) return node;
      const sectionKey = JSON.stringify(node.locator.sectionPath);
      const ordinal = codeOrdinals.get(sectionKey) ?? 0;
      codeOrdinals.set(sectionKey, ordinal + 1);
      return { ...node, locator: { ...node.locator, ordinal } };
    });
    return stripExecutionMetadata({ nodes });
  };
  if (semanticHash(outside(baseline)) !== semanticHash(outside(current))) {
    throw new Error('Remote changed outside the verified partial-write scopes; recovery checkpoint was not advanced.');
  }
}

async function resolveCurrentInsertionAnchor(input: {
  adapter: FeishuAdapter;
  doc: string;
  originalBlockId: string;
  afterLocator?: SemanticLocator;
  callouts: CalloutConfig;
}): Promise<string> {
  if (!input.afterLocator) return input.originalBlockId;
  const current = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
  const anchor = current.nodes.find((node) => sameLocator(node.locator, input.afterLocator!));
  if (!anchor?.remoteBlockId) {
    throw new Error(`create anchor correspondence is no longer resolvable at ${locatorKey(input.afterLocator)}`);
  }
  return anchor.remoteBlockId;
}

async function verifyScopedRecoveryPreflight(input: {
  adapter: FeishuAdapter;
  doc: string;
  operations: ScopedPatchOperation[];
  callouts: CalloutConfig;
}): Promise<void> {
  const recoveries = input.operations.filter((operation): operation is Extract<ScopedPatchOperation, { kind: 'delete' }> => {
    return operation.kind === 'delete' && Boolean(operation.recovery?.preCreatePrecedingBlockId);
  });
  if (recoveries.length === 0) return;
  if (!input.adapter.fetchDocBlocks) {
    throw new Error('Configured Feishu adapter cannot preflight partial-create recovery.');
  }
  const before = await input.adapter.fetchDocBlocks({ doc: input.doc });
  for (const recovery of recoveries) {
    verifyRecoveryDeletePreCreate(recovery, before.blocks, input.doc, input.callouts);
  }
}

function readbackFailureSummary(operation: ScopedPatchOperation): PublishWriteOperationSummary {
  if (operation.kind === 'authoring-token-create' || operation.kind === 'authoring-token-move' ||
    operation.kind === 'authoring-token-delete') {
    return { kind: 'authoring-token-readback', locator: operation.locator };
  }
  if (operation.kind === 'callout-create' || operation.kind === 'callout-title-update' ||
    operation.kind === 'callout-child-update' || operation.kind === 'callout-child-create' ||
    operation.kind === 'callout-child-delete' || operation.kind === 'callout-delete') {
    return { kind: 'callout-readback', locator: operation.locator };
  }
  if (operation.kind === 'code-update' || operation.kind === 'code-create' ||
    operation.kind === 'code-move' || operation.kind === 'code-delete' ||
    operation.kind === 'code-section-reconcile') {
    return { kind: 'code-readback', locator: operation.locator };
  }
  return { kind: 'scoped-readback', locator: operation.locator };
}

async function applyCodeSectionReconcileThroughEngine(input: {
  adapter: FeishuAdapter;
  doc: string;
  operation: CodeSectionReconcileOperation;
  callouts: CalloutConfig;
  completedOperations: PublishWriteOperationSummary[];
  verifiedOperations: ScopedPatchOperation[];
  recordCheckpoint?: (
    completedOperations: PublishWriteOperationSummary[],
    verifiedOperations: ScopedPatchOperation[]
  ) => Promise<void>;
  recoveryCheckpoint?: { written: boolean; revision?: string };
  pendingAfter: PublishWriteOperationSummary[];
}): Promise<void> {
  let physicalOrdinal = 0;
  let failureSummary: PublishWriteOperationSummary = summarizeScopedOperation(input.operation);
  const execute = async (physical: {
    operation: ScopedPatchOperation;
    summary: PublishWriteOperationSummary;
    build: (snapshot: DocumentSnapshot, operationId: string) => MutationIntent;
  }): Promise<void> => {
    failureSummary = physical.summary;
    const engine = createFeishuDocxEngine({ transport: docxTransportForAdapter(input.adapter) });
    const snapshot = await engine.snapshot({ kind: 'docx', token: input.doc });
    const operationId = `${operationIdForScopedOperation(input.operation)}:${physicalOrdinal}`;
    physicalOrdinal += 1;
    const intent = physical.build(snapshot, operationId);
    const batch = engine.prepare({
      snapshot,
      operations: [intent],
      idempotencyNamespace: `feishu-md-sync:${input.doc}:code-reconcile`
    });
    const operationsById = new Map([[operationId, physical.operation]]);
    const journal = createDocxEngineJournal({
      operationsById,
      completedOperations: input.completedOperations,
      verifiedOperations: input.verifiedOperations,
      recordCheckpoint: input.recordCheckpoint,
      summarize: () => physical.summary,
      onVerified: (operation, evidence) => {
        if (operation.kind === 'code-create' && evidence.createdBlockIds.length === 1) {
          operation.desiredCode = {
            ...operation.desiredCode,
            remoteBlockId: evidence.createdBlockIds[0]
          };
        }
      }
    });
    try {
      await engine.apply({ batch, journal });
    } catch (error) {
      if (error instanceof PartialMutationError) {
        throw enginePartialWriteError({
          error,
          operationsById,
          completedOperations: input.completedOperations,
          pendingAfter: input.pendingAfter,
          recoveryCheckpoint: input.recoveryCheckpoint,
          summarize: () => physical.summary,
          readbackSummary: { kind: 'code-readback', locator: physical.summary.locator },
          unplannedAsCheckpointFailure: input.recordCheckpoint !== undefined,
          ...(physical.operation.kind === 'code-create'
            ? {
                createdSummary: (_operation: ScopedPatchOperation, blockIds: string[]) => ({
                  ...physical.summary,
                  blockIds
                })
              }
            : {})
        });
      }
      throw bridgeEngineCause(error);
    }
  };

  try {
    const beforePhase = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
    const unrelatedBefore = codeScopeHashOutsideSections(beforePhase, input.operation.sectionPaths);

    if (input.operation.phase === 'delete') {
      const obsoleteIds = findObsoleteCodeIdsForReconcile(
        beforePhase,
        input.operation.desiredCodes.map(({ code }) => code),
        input.operation.sectionPaths
      );
      if (obsoleteIds.length > 0) {
        await execute({
          operation: input.operation,
          summary: { kind: 'code-reconcile-delete', locator: input.operation.locator },
          build: (snapshot, operationId) => {
            const parentBlockId = commonSnapshotParent(snapshot, obsoleteIds, 'Code reconcile delete');
            return {
              operationId,
              kind: 'delete',
              parentBlockId,
              blockIds: obsoleteIds,
              expectedHashes: obsoleteIds.map((blockId) => snapshotNodeHash(snapshot, blockId))
            };
          }
        });
      }
      failureSummary = { kind: 'code-readback', locator: input.operation.locator };
      const afterDeletion = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
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
      let current = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
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
        const synthetic: Extract<ScopedPatchOperation, { kind: 'code-create' }> = {
          kind: 'code-create',
          locator: desired.code.locator,
          ...(desired.afterLocator ? { afterLocator: desired.afterLocator } : {}),
          ...(desired.afterCodeFingerprint
            ? { afterCodeFingerprint: desired.afterCodeFingerprint }
            : {}),
          desiredCode: { ...desired.code }
        };
        await execute({
          operation: synthetic,
          summary: { kind: 'code-reconcile-create', locator: desired.code.locator },
          build: (snapshot, operationId) => ({
            operationId,
            kind: 'insert',
            parentBlockId: parentBlockIdForAnchor(snapshot, anchor),
            insertAfterBlockId: anchor,
            desired: [{
              kind: 'code',
              language: desired.code.resolvedLanguage,
              text: desired.code.content,
              ...(desired.code.caption !== undefined ? { caption: desired.code.caption } : {})
            }]
          })
        });
        failureSummary = { kind: 'code-readback', locator: desired.code.locator };
        current = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
        remote = findCodeReconcileCandidate(
          current,
          desired.code,
          input.operation.sectionPaths,
          unavailableIds
        );
        if (!remote) throw new Error('Code section reconcile could not resolve the created block.');
      } else if (!codeManagedEqual(remote, desired.code)) {
        if (!remote.remoteBlockId) throw new Error('Code section reconcile cannot replace a block without an ID.');
        const blockId = remote.remoteBlockId;
        const caption = remote.caption;
        const synthetic: Extract<ScopedPatchOperation, { kind: 'code-update' }> = {
          kind: 'code-update',
          locator: desired.code.locator,
          sourceLocator: remote.locator,
          remoteBlockId: blockId,
          desiredCode: {
            ...desired.code,
            ...(caption !== undefined ? { caption } : {})
          }
        };
        await execute({
          operation: synthetic,
          summary: { kind: 'code-reconcile-update', locator: desired.code.locator },
          build: (snapshot, operationId) => ({
            operationId,
            kind: 'replace',
            targetBlockId: blockId,
            expectedHash: snapshotNodeHash(snapshot, blockId),
            desired: {
              kind: 'code',
              language: desired.code.resolvedLanguage,
              text: desired.code.content,
              ...(caption !== undefined ? { caption } : {})
            }
          })
        });
        failureSummary = { kind: 'code-readback', locator: desired.code.locator };
        current = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
        remote = findCodeReconcileCandidate(
          current,
          desired.code,
          input.operation.sectionPaths,
          unavailableIds
        );
        if (!remote) throw new Error('Code section reconcile could not resolve the replaced block.');
      }

      if (!remote.remoteBlockId) throw new Error('Code section reconcile cannot move a block without an ID.');
      if (remote.caption !== undefined) desired.code = { ...desired.code, caption: remote.caption };
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
        const blockId = remote.remoteBlockId;
        const synthetic: Extract<ScopedPatchOperation, { kind: 'code-move' }> = {
          kind: 'code-move',
          locator: desired.code.locator,
          sourceLocator: remote.locator,
          ...(desired.afterLocator ? { afterLocator: desired.afterLocator } : {}),
          ...(desired.afterCodeFingerprint
            ? { afterCodeFingerprint: desired.afterCodeFingerprint }
            : {}),
          remoteBlockId: blockId,
          desiredCode: { ...desired.code }
        };
        await execute({
          operation: synthetic,
          summary: { kind: 'code-reconcile-move', locator: desired.code.locator },
          build: (snapshot, operationId) => ({
            operationId,
            kind: 'move',
            parentBlockId: commonSnapshotParent(snapshot, [blockId], 'Code reconcile move'),
            blockIds: [blockId],
            insertAfterBlockId: anchor
          })
        });
      }
    }
    failureSummary = { kind: 'code-readback', locator: input.operation.locator };
    const afterPlacement = await fetchRemoteSemantic(input.adapter, input.doc, input.callouts);
    assertUnrelatedCodeScopesUnchanged(unrelatedBefore, afterPlacement, input.operation.sectionPaths);
  } catch (error) {
    if (error instanceof PartialWriteError) throw error;
    const cause = bridgeEngineCause(error);
    if (input.completedOperations.length === 0) throw cause;
    throw new PartialWriteError({
      completedOperations: [...input.completedOperations],
      failedOperation: failureSummary,
      pendingOperations: input.pendingAfter,
      recoveryCheckpointWritten: input.recoveryCheckpoint?.written,
      recoveryCheckpointRevision: input.recoveryCheckpoint?.revision,
      cause
    });
  }
}

function snapshotNodeHash(snapshot: DocumentSnapshot, blockId: string): string {
  const node = snapshot.nodes.find((candidate) => candidate.blockId === blockId);
  if (!node) throw new Error(`Docx engine snapshot does not contain block ${blockId}.`);
  return node.canonicalHash;
}

function commonSnapshotParent(
  snapshot: DocumentSnapshot,
  blockIds: string[],
  label: string
): string {
  const parents = new Set(blockIds.map((blockId) => {
    const node = snapshot.nodes.find((candidate) => candidate.blockId === blockId);
    if (!node?.parentBlockId) throw new Error(`${label} block ${blockId} has no parent.`);
    return node.parentBlockId;
  }));
  if (parents.size !== 1) throw new Error(`${label} blocks do not share one parent.`);
  return [...parents][0]!;
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

async function withCheckpointReadRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = CHECKPOINT_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isCheckpointReadTransientError(error)) throw error;
      await delay(delayMs);
    }
  }
}

function isCheckpointReadTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    message?: unknown;
    details?: { providerCode?: unknown };
    cause?: unknown;
  };
  if (record.code === 12330102 || record.details?.providerCode === 12330102) return true;
  if (record.message === 'Code block readback differs from the desired content or language.') return true;
  return record.cause !== undefined && isCheckpointReadTransientError(record.cause);
}

function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const details = (error as { details?: { type?: unknown; retryable?: unknown } }).details;
    if (details?.type === 'network' && details.retryable === true) return true;
  }
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
  if (!input.adapter.docxTransport &&
    (!input.adapter.replaceBlock || !input.adapter.queryWhiteboard || !input.adapter.updateWhiteboard ||
      !input.adapter.fetchDocBlocks)) {
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
      const whiteboardIdempotencyToken = operation.kind === 'whiteboard-create'
        ? undefined
        : `fms-${semanticHash({
          whiteboardToken: operation.whiteboardToken,
          svgHash: asset.svgHash,
          remoteStateHash: operation.remoteStateHash
        }).slice(0, 32)}`;
      input.adapter.setDocxEngineWhiteboardIdempotencyToken?.(whiteboardIdempotencyToken);
      const engine = createFeishuDocxEngine({
        transport: docxTransportForAdapter(input.adapter, { whiteboardIdempotencyToken })
      });
      const snapshot = await engine.snapshot({ kind: 'docx', token: input.doc });
      const intent = whiteboardOperationToMutationIntent({
        operation,
        snapshot,
        svg: asset.svgSource
      });
      let verifiedEvidence: import('feishu-docx-engine').VerifiedOperationEvidence | undefined;
      const operationsById = new Map([[intent.operationId, operation]] as const);
      const journal = createDocxEngineJournal({
        operationsById,
        completedOperations: completed,
        verifiedOperations: [] as WhiteboardOperation[],
        summarize: summarizeWhiteboardOperation,
        onVerified: (_verifiedOperation, evidence) => {
          verifiedEvidence = evidence;
        }
      });
      const batch = engine.prepare({
        snapshot,
        operations: [intent],
        idempotencyNamespace: `feishu-md-sync:${input.doc}:whiteboard`
      });
      try {
        await engine.apply({ batch, journal });
      } catch (error) {
        if (error instanceof PartialMutationError) {
          throw enginePartialWriteError({
            error,
            operationsById,
            completedOperations: completed,
            pendingAfter: [
              ...input.plan.operations.slice(index + 1).map(summarizeWhiteboardOperation),
              ...(input.pendingAfter ?? [])
            ],
            summarize: summarizeWhiteboardOperation,
            cause: whiteboardEvidenceFailure(error, asset.expectedTexts)
          });
        }
        throw bridgeEngineCause(error);
      }

      const evidence = verifiedEvidence;
      if (!evidence) throw new Error('Docx engine did not journal verified Whiteboard evidence.');
      const blockId = operation.kind === 'whiteboard-create'
        ? evidence.createdBlockIds[0]
        : operation.blockId;
      const whiteboardToken = operation.kind === 'whiteboard-create'
        ? evidence.resourceTokens?.[0]
        : operation.whiteboardToken;
      const raw = evidence.verifiedResourceEvidence?.find((item) => {
        return item.resourceKind === 'whiteboard' && item.token === whiteboardToken;
      })?.raw;
      if (!blockId || !whiteboardToken || raw === undefined) {
        throw new Error('Docx engine Whiteboard evidence is missing block, token, or raw readback state.');
      }
      entries.set(operation.assetKey, {
        assetKey: operation.assetKey,
        pngPath: operation.assetKey,
        svgPath: operation.assetKey.replace(/\.png$/i, '.svg'),
        svgHash: asset.svgHash,
        whiteboardToken,
        blockId,
        remoteStateHash: whiteboardRemoteStateHash(raw),
        placementFingerprint: operation.placementFingerprint
      });
    } catch (error) {
      if (error instanceof PartialWriteError) throw error;
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

function whiteboardEvidenceFailure(
  error: PartialMutationError,
  expectedTexts: string[]
): Error | undefined {
  const message = error.evidence.failedOperation.message;
  if (!/does not contain the prepared SVG evidence/i.test(message)) return undefined;
  const expected = expectedTexts[0];
  return expected ? new Error(`Whiteboard readback is missing expected text: ${expected}`) : undefined;
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

function verifyOperation(
  operation: ScopedPatchOperation,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig,
  textUpdateReadback?: TextUpdateReadbackExpectation
): void {
  if (operation.kind === 'delete' || operation.kind === 'callout-child-delete' ||
    operation.kind === 'callout-delete' || operation.kind === 'code-delete' ||
    operation.kind === 'authoring-token-delete') {
    const remaining = new Set(blocks.flatMap((block) => block.block_id ? [block.block_id] : []));
    const deletedIds = operation.kind === 'code-delete'
      ? (operation.remoteBlockId ? [operation.remoteBlockId] : [])
      : operation.kind === 'authoring-token-delete'
        ? [operation.remoteBlockId]
        : operation.blockIds;
    if (deletedIds.some((blockId) => remaining.has(blockId))) {
      throw new Error('scoped readback verification failed: deleted block still exists');
    }
    return;
  }

  const remote = remoteSemanticDocument(blocks, documentId, callouts);
  if (operation.kind === 'table-replace' || operation.kind === 'table-create') {
    const match = findCorrespondingRemoteTable(operation.desiredTable, remote);
    if (!match.table) throw new Error(`scoped readback verification failed: ${match.blocker}`);
    const diff = diffCorrespondingTable(match.table, operation.desiredTable);
    if (diff.blockers.length > 0 || diff.additions.length > 0 || diff.updates.length > 0) {
      throw new Error('scoped readback verification failed: remote table differs from desired table');
    }
    if (operation.kind === 'table-create') {
      if (!match.table.remoteBlockId) {
        throw new Error('scoped readback verification failed: created table block ID is missing');
      }
      const page = findPageBlock(blocks, documentId);
      const direct = renderableDirectChildBlocks(blocks, page);
      const anchorIndex = operation.insertAfterBlockId === page.block_id
        ? -1
        : direct.findIndex((block) => block.block_id === operation.insertAfterBlockId);
      const tableIndex = direct.findIndex((block) => block.block_id === match.table?.remoteBlockId);
      if ((operation.insertAfterBlockId !== page.block_id && anchorIndex < 0) || tableIndex !== anchorIndex + 1) {
        throw new Error('scoped readback verification failed: created table placement differs from desired order');
      }
      if (operation.insertBeforeBlockId && direct[tableIndex + 1]?.block_id !== operation.insertBeforeBlockId) {
        throw new Error('scoped readback verification failed: created table following anchor differs from desired order');
      }
    }
    return;
  }

  if (operation.kind.startsWith('callout-')) {
    verifyCalloutOperation(operation as CalloutOperation, remote, callouts);
    return;
  }

  if (operation.kind === 'authoring-token-create' || operation.kind === 'authoring-token-move') {
    verifyAuthoringTokenOperation(operation, remote);
    return;
  }

  if (operation.kind.startsWith('code-')) {
    verifyCodeOperation(operation as CodeBlockOperation, remote);
    return;
  }

  if (operation.kind !== 'update' && operation.kind !== 'create') {
    throw new Error('Callout readback verification is not configured.');
  }

  if (operation.kind === 'create') {
    verifyTextCreateOperation(operation, blocks);
    return;
  }
  verifyTextUpdateReadback(operation, blocks, textUpdateReadback);
}

type TextUpdateReadbackExpectation = {
  parentBlockId: string;
  index: number;
  siblingIds: string[];
  blockType: number;
};

function textUpdateReadbackExpectation(
  operation: Extract<ScopedPatchOperation, { kind: 'update' }>,
  blocks: import('../feishu/types.js').FeishuBlock[]
): TextUpdateReadbackExpectation {
  const siblings = resolvedChildBlocks(blocks, operation.parentBlockId);
  const siblingIds = siblings.flatMap((block) => block.block_id ? [block.block_id] : []);
  const index = siblingIds.indexOf(operation.remoteBlockId);
  const source = siblings[index];
  if (siblingIds.length !== siblings.length || index < 0 || !source) {
    throw new Error('scoped write preflight failed: text update slot cannot be verified');
  }
  return {
    parentBlockId: operation.parentBlockId,
    index,
    siblingIds,
    blockType: source.block_type
  };
}

function verifyTextUpdateReadback(
  operation: Extract<ScopedPatchOperation, { kind: 'update' }>,
  blocks: import('../feishu/types.js').FeishuBlock[],
  expected: TextUpdateReadbackExpectation | undefined
): void {
  if (!expected || expected.parentBlockId !== operation.parentBlockId) {
    throw new Error('scoped readback verification failed: text update slot is missing');
  }
  const siblings = resolvedChildBlocks(blocks, expected.parentBlockId);
  const siblingIds = siblings.flatMap((block) => block.block_id ? [block.block_id] : []);
  const matched = siblings[expected.index];
  const stableSiblingsMatch = siblingIds.length === expected.siblingIds.length &&
    siblingIds.length === siblings.length && expected.siblingIds.every((blockId, index) => {
      return index === expected.index || siblingIds[index] === blockId;
    });
  if (!stableSiblingsMatch || !matched?.block_id || matched.block_type !== expected.blockType ||
    canonicalMarkdown(feishuBlocksToMarkdown([matched]).trim()) !== canonicalMarkdown(operation.desiredMarkdown)) {
    throw new Error('scoped readback verification failed: remote text differs from desired text');
  }
}

function verifyTextOperationParent(
  operation: Extract<ScopedPatchOperation, { kind: 'update' | 'create' | 'delete' }>,
  blocks: import('../feishu/types.js').FeishuBlock[]
): void {
  const siblings = resolvedChildBlocks(blocks, operation.parentBlockId);
  const siblingIds = siblings.flatMap((block) => block.block_id ? [block.block_id] : []);
  if (operation.kind === 'update') {
    if (!siblingIds.includes(operation.remoteBlockId)) {
      throw new Error('scoped write preflight failed: text block parent changed');
    }
    return;
  }
  if (operation.kind === 'create') {
    if (operation.insertAfterBlockId !== operation.parentBlockId &&
      !siblingIds.includes(operation.insertAfterBlockId)) {
      throw new Error('scoped write preflight failed: create anchor parent changed');
    }
    return;
  }
  const indexes = operation.blockIds.map((blockId) => siblingIds.indexOf(blockId));
  if (indexes.some((index) => index < 0) || indexes.some((index, offset) => {
    return offset > 0 && index !== indexes[offset - 1]! + 1;
  })) {
    throw new Error('scoped write preflight failed: delete block parent or adjacency changed');
  }
}

function verifyTableCreateAnchors(
  operation: Extract<ScopedPatchOperation, { kind: 'table-create' }>,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string
): void {
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const anchorIndex = operation.insertAfterBlockId === page.block_id
    ? -1
    : direct.findIndex((block) => block.block_id === operation.insertAfterBlockId);
  if (operation.insertAfterBlockId !== page.block_id && anchorIndex < 0) {
    throw new Error('table-create preflight failed: preceding anchor is missing');
  }
  const following = direct[anchorIndex + 1]?.block_id;
  if (operation.insertBeforeBlockId ? following !== operation.insertBeforeBlockId : following !== undefined) {
    throw new Error('table-create preflight failed: adjacent anchors no longer match the reviewed plan');
  }
}

function verifyRecoveryUpdatePreflight(
  operation: Extract<ScopedPatchOperation, { kind: 'update' }>,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig
): void {
  const expected = operation.recoveryExpectedRemoteMarkdown;
  const remote = remoteSemanticDocument(blocks, documentId, callouts);
  const matched = remote.nodes.find((node): node is SemanticTextBlock => {
    return node.kind === 'text' && node.remoteBlockId === operation.remoteBlockId;
  });
  if (!expected || !matched || canonicalMarkdown(matched.markdown) !== canonicalMarkdown(expected)) {
    throw new Error('partial-create recovery preflight failed: update source no longer matches reviewed remote text');
  }
}

function verifyRecoveryDeletePreflight(
  operation: Extract<ScopedPatchOperation, { kind: 'delete' }>,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig
): void {
  const recovery = operation.recovery;
  if (!recovery) return;
  const remote = remoteSemanticDocument(blocks, documentId, callouts);
  const remoteById = new Map(remote.nodes.flatMap((node) => node.remoteBlockId ? [[node.remoteBlockId, node] as const] : []));
  for (const expected of recovery.expectedBlocks) {
    const node = remoteById.get(expected.blockId);
    if (node?.kind !== 'text' || node.blockType !== expected.blockType ||
      canonicalMarkdown(node.markdown) !== canonicalMarkdown(expected.markdown)) {
      throw new Error('partial-create recovery preflight failed: baseline suffix content changed');
    }
  }
  verifyRecoveryDescendantIds(recovery, blocks);
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const directIds = direct
    .flatMap((block) => block.block_id ? [block.block_id] : []);
  const expectedIds = recovery.expectedBlocks.map((block) => block.blockId);
  if (recovery.precedingDesiredMarkdown) {
    const firstIndex = directIds.indexOf(expectedIds[0] ?? '');
    const previous = firstIndex > 0 ? direct[firstIndex - 1] : undefined;
    const actualIds = directIds.slice(firstIndex, firstIndex + expectedIds.length);
    const following = directIds[firstIndex + expectedIds.length];
    if (firstIndex < 0 || !previous ||
      canonicalMarkdown(feishuBlocksToMarkdown([previous]).trim()) !== canonicalMarkdown(recovery.precedingDesiredMarkdown) ||
      actualIds.length !== expectedIds.length || actualIds.some((blockId, index) => blockId !== expectedIds[index]) ||
      (recovery.followingBlockId ? following !== recovery.followingBlockId : following !== undefined)) {
      throw new Error('partial-create recovery preflight failed: flattened sequence anchors changed');
    }
    return;
  }
  if (!recovery.precedingBlockId) {
    throw new Error('partial-create recovery preflight failed: preceding anchor is missing');
  }
  const precedingIndex = directIds.indexOf(recovery.precedingBlockId);
  const actualIds = directIds.slice(precedingIndex + 1, precedingIndex + 1 + expectedIds.length);
  const following = directIds[precedingIndex + 1 + expectedIds.length];
  if (precedingIndex < 0 || actualIds.length !== expectedIds.length ||
    actualIds.some((blockId, index) => blockId !== expectedIds[index]) ||
    (recovery.followingBlockId ? following !== recovery.followingBlockId : following !== undefined)) {
    throw new Error('partial-create recovery preflight failed: baseline suffix anchors changed');
  }
}

function verifyRecoveryDeletePreCreate(
  operation: Extract<ScopedPatchOperation, { kind: 'delete' }>,
  blocks: import('../feishu/types.js').FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig
): void {
  const recovery = operation.recovery;
  const precedingBlockId = recovery?.preCreatePrecedingBlockId;
  if (!recovery || !precedingBlockId) return;
  const remote = remoteSemanticDocument(blocks, documentId, callouts);
  const remoteById = new Map(remote.nodes.flatMap((node) => node.remoteBlockId ? [[node.remoteBlockId, node] as const] : []));
  for (const expected of recovery.expectedBlocks) {
    const node = remoteById.get(expected.blockId);
    if (node?.kind !== 'text' || node.blockType !== expected.blockType ||
      canonicalMarkdown(node.markdown) !== canonicalMarkdown(expected.markdown)) {
      throw new Error('partial-create recovery preflight failed: flattened sequence content changed');
    }
  }
  verifyRecoveryDescendantIds(recovery, blocks);
  const page = findPageBlock(blocks, documentId);
  const directIds = renderableDirectChildBlocks(blocks, page)
    .flatMap((block) => block.block_id ? [block.block_id] : []);
  const precedingIndex = directIds.indexOf(precedingBlockId);
  const expectedIds = recovery.expectedBlocks.map((block) => block.blockId);
  const actualIds = directIds.slice(precedingIndex + 1, precedingIndex + 1 + expectedIds.length);
  const following = directIds[precedingIndex + 1 + expectedIds.length];
  if (precedingIndex < 0 || actualIds.length !== expectedIds.length ||
    actualIds.some((blockId, index) => blockId !== expectedIds[index]) ||
    (recovery.followingBlockId ? following !== recovery.followingBlockId : following !== undefined)) {
    throw new Error('partial-create recovery preflight failed: flattened sequence anchors changed');
  }
}

function verifyRecoveryDescendantIds(
  recovery: NonNullable<Extract<ScopedPatchOperation, { kind: 'delete' }>['recovery']>,
  blocks: import('../feishu/types.js').FeishuBlock[]
): void {
  if (!recovery.expectedDescendantBlockIds) return;
  const descendants: string[] = [];
  const seen = new Set<string>();
  const visit = (blockId: string): void => {
    for (const child of resolvedChildBlocks(blocks, blockId)) {
      if (!child.block_id || seen.has(child.block_id)) {
        throw new Error('partial-create recovery preflight failed: malformed tree child identity changed');
      }
      seen.add(child.block_id);
      descendants.push(child.block_id);
      visit(child.block_id);
    }
  };
  for (const root of recovery.expectedBlocks) visit(root.blockId);
  if (descendants.length !== recovery.expectedDescendantBlockIds.length ||
    descendants.some((blockId, index) => blockId !== recovery.expectedDescendantBlockIds?.[index])) {
    throw new Error('partial-create recovery preflight failed: malformed tree child identity changed');
  }
}

function verifyTextCreateOperation(
  operation: Extract<ScopedPatchOperation, { kind: 'create' }>,
  blocks: import('../feishu/types.js').FeishuBlock[]
): void {
  const siblings = resolvedChildBlocks(blocks, operation.parentBlockId);
  const anchorIsParent = operation.insertAfterBlockId === operation.parentBlockId;
  const anchorIndex = anchorIsParent
    ? -1
    : siblings.findIndex((block) => block.block_id === operation.insertAfterBlockId);
  if (!anchorIsParent && anchorIndex < 0) {
    throw new Error('scoped readback verification failed: create anchor is missing');
  }
  const created = siblings.slice(anchorIndex + 1, anchorIndex + 1 + operation.desiredBlocks.length);
  if (created.length !== operation.desiredBlocks.length || created.some((block, index) => {
    const desired = operation.desiredBlocks[index];
    return !desired || block.block_type !== desired.blockType ||
      canonicalMarkdown(feishuBlocksToMarkdown([block]).trim()) !== canonicalMarkdown(desired.markdown);
  })) {
    throw new Error('scoped readback verification failed: created text sequence differs from desired text');
  }
  if (created.some((block) => !block.block_id)) {
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
  const expectedBlockId = operation.kind === 'code-create'
    ? desired.remoteBlockId
    : operation.remoteBlockId;
  const matched = expectedBlockId
    ? codeNodes(remote).find((code) => code.remoteBlockId === expectedBlockId)
    : findCodeByLocator(remote, expectedLocator);
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

function renderAuthoringTokenXml(token: '<Procedures>' | '</Procedures>'): string {
  return `<p>${token
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</p>`;
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
    const expectedTitle = operation.desiredCallout.titleManaged && operation.desiredCallout.title
      ? operation.desiredCallout.title.markdown
      : operation.desiredCallout.calloutType === 'note'
        ? callouts.noteTitle
        : callouts.warningTitle;
    const readbackType = match.calloutType ?? (operation.desiredCallout.titleManaged
      ? calloutTypeForEmojiId(match.shell?.emojiId)
      : undefined);
    if (readbackType !== operation.desiredCallout.calloutType || match.title?.markdown !== expectedTitle) {
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
  if (operation.kind === 'callout-title-update') {
    if (canonicalMarkdown(match.title?.markdown ?? '') !== canonicalMarkdown(operation.desiredMarkdown)) {
      throw new Error('Callout readback verification failed: managed title differs');
    }
    return;
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

function verifyAuthoringTokenOperation(
  operation: Extract<ScopedPatchOperation, {
    kind: 'authoring-token-create' | 'authoring-token-move';
  }>,
  remote: SemanticDocument
): void {
  const anchorIndex = remote.nodes.findIndex((node) => {
    return node.remoteBlockId === operation.insertAfterBlockId;
  });
  if (anchorIndex < 0) {
    throw new Error('Procedures token readback verification failed: anchor is missing');
  }
  const token = remote.nodes[anchorIndex + 1];
  if (token?.kind !== 'authoring-token' || token.markdown !== operation.token) {
    throw new Error('Procedures token readback verification failed: boundary differs');
  }
  if (operation.kind === 'authoring-token-move' && token.remoteBlockId !== operation.remoteBlockId) {
    throw new Error('Procedures token readback verification failed: moved block identity changed');
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

async function recordPublishReceiptV4(input: {
  cwd: string;
  target: PublishReceiptTarget;
  resolvedDocumentId: string;
  profile: PublishProfileName;
  publishContext: PublishContext;
  publishDraft: string;
  remoteMarkdown: string;
  remoteRevision?: string;
  remoteSemantic?: SemanticDocument;
  whiteboards: WhiteboardReceiptEntry[];
  protectedResources?: ProtectedResourceReceiptEntry[];
}): Promise<void> {
  const localBaseSnapshot = await writeLocalBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.publishContext.localSource
  });
  const publishBaseSnapshot = await writePublishBaseSnapshot({
    cwd: input.cwd,
    target: input.target,
    markdown: input.publishDraft
  });
  const remoteSemanticSnapshot = input.remoteSemantic
    ? await writeRemoteSemanticSnapshot({
        cwd: input.cwd,
        target: input.target,
        document: applyManagedCalloutMetadata(
          input.remoteSemantic,
          localSemanticDocument(
            input.publishDraft,
            DEFAULT_CODE_BLOCK_CONFIG,
            input.publishContext.zdoc?.inventory
          )
        )
      })
    : undefined;
  const common = {
    target: input.target,
    resolvedDocumentId: input.resolvedDocumentId,
    profile: input.profile,
    dialect: input.publishContext.dialect,
    dialectDraftHash: input.publishContext.dialectDraftHash,
    dialectDependencies: input.publishContext.dialectDependencies,
    linkResolutionFingerprint: input.publishContext.linkResolutionFingerprint,
    resolvedLinks: input.publishContext.resolvedLinks,
    localSourceHash: hashText(input.publishContext.localSource),
    publishDraftHash: hashText(input.publishDraft),
    publishBaseSnapshot,
    remoteSnapshotHash: hashText(input.remoteMarkdown),
    remoteRevision: input.remoteRevision,
    localBaseSnapshot,
    remoteSemanticSnapshot,
    whiteboards: input.whiteboards,
    updatedAt: new Date().toISOString()
  };
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: input.protectedResources && input.protectedResources.length > 0
      ? { version: 5, ...common, protectedResources: input.protectedResources }
      : { version: 4, ...common }
  });
}

function applyManagedCalloutMetadata(
  remote: SemanticDocument,
  local: SemanticDocument
): SemanticDocument {
  const localCallouts = local.nodes.filter((node) => node.kind === 'callout');
  let calloutIndex = 0;
  return {
    nodes: remote.nodes.map((node) => {
      if (node.kind !== 'callout') return node;
      const localCallout = localCallouts[calloutIndex];
      calloutIndex += 1;
      if (!localCallout?.titleManaged || !localCallout.calloutType) return node;
      return {
        ...node,
        calloutType: localCallout.calloutType,
        titleManaged: true as const,
        unsupported: node.unsupported.filter((message) =>
          message !== 'remote Callout title is unrecognized'
        )
      };
    })
  };
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

function semanticNodeHash(node: SemanticNode): string {
  return semanticHash(stripExecutionMetadata(node));
}
