import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import { applyTrackedCalloutTypes, calloutTypeHints } from '../callouts/callout-baseline.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import { canonicalMarkdown, canonicalMarkdownHash } from '../core/markdown-canonical.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { DialectDiagnostic, DialectName } from '../dialects/types.js';
import type {
  DialectWorkspaceConfig,
  LinkResolutionSummary
} from '../link-resolvers/types.js';
import {
  hashText,
  hasRemoteSemanticSnapshot,
  publishReceiptPath,
  readPublishReceipt,
  receiptDialect,
  type PublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot } from '../receipts/semantic-snapshot.js';
import { buildPublishContext, type PublishContext } from '../publish/publish-context.js';
import { analyzeExistingPublish, withRateLimitRetry } from '../publish/run-publish.js';
import type { SemanticLocator } from '../semantic/types.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';
import type { WhiteboardAssetPlan, WhiteboardPlanBlocker } from '../whiteboards/whiteboard-plan.js';
import { summarizeCalloutChanges, type CalloutChangeSummary } from '../callouts/callout-summary.js';
import type { ScopedPatchBlocker, ScopedPatchPlan } from '../publish/scoped-patch-plan.js';
import { summarizeCodeBlockChanges, type CodeBlockChangeSummary } from '../code-blocks/code-summary.js';
import { DEFAULT_CODE_BLOCK_CONFIG, type CodeBlockConfig } from '../code-blocks/code-language.js';
import { canonicalizeFencedCodeLanguages } from '../code-blocks/code-markdown.js';
import { canonicalizeMarkdownSemantics } from '../semantic/markdown-equivalence.js';
import type { ZdocRoundTripReport } from '../zdoc/types.js';

export type PublishStatusState = 'untracked' | 'clean' | 'local-changed' | 'remote-changed' | 'diverged';

export type PublishStatusRecommendationAction =
  | 'no-action'
  | 'publish-dry-run'
  | 'pull-review'
  | 'resolve-divergence'
  | 'adopt-or-replace'
  | 'fix-source';

export type PublishStatusResult = {
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
  dialect: DialectName;
  dialectDraftHash: string;
  dialectBlockers: DialectDiagnostic[];
  dialectWarnings: DialectDiagnostic[];
  dialectDiagnostics: DialectDiagnostic[];
  linkResolution: LinkResolutionSummary;
  linkResolutionFingerprint: string;
  state: PublishStatusState;
  localChanged: boolean;
  remoteChanged: boolean;
  contentMatchesRemote: boolean;
  hasReceipt: boolean;
  receiptPath: string;
  localSourceHash: string;
  publishDraftHash: string;
  publishDraftCanonicalHash: string;
  remoteSnapshotHash: string;
  remoteCanonicalHash: string;
  remoteRevision?: string;
  transformWarnings: string[];
  whiteboards: WhiteboardAssetPlan[];
  whiteboardBlockers: WhiteboardPlanBlocker[];
  callouts: CalloutChangeSummary[];
  calloutBlockers: ScopedPatchBlocker[];
  codeBlocks: CodeBlockChangeSummary[];
  codeBlockers: ScopedPatchBlocker[];
  scopeSummary: {
    localChanged: SemanticLocator[];
    remoteChanged: SemanticLocator[];
    overlappingConflicts: SemanticLocator[];
    unrelatedRemoteChanges: SemanticLocator[];
  };
  recommendation: {
    action: PublishStatusRecommendationAction;
    reason: string;
  };
  zdocRoundTrip?: ZdocRoundTripReport;
};

export type PublishStatusContext = {
  cwd: string;
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
  dialect: DialectName;
  publishContext: PublishContext;
  localSource: string;
  publishDraft: string;
  publishDraftCanonical: string;
  remoteMarkdown: string;
  remoteCanonical: string;
  remoteRevision?: string;
  receipt: PublishReceipt | undefined;
  transformWarnings: string[];
};

export async function runStatus(input: {
  cwd: string;
  sourcePath: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect?: DialectName;
  dialectConfig?: DialectWorkspaceConfig;
  syncWhiteboards?: boolean;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<PublishStatusResult> {
  const context = await loadPublishStatusContext(input);
  const result = statusFromContext(context);
  if (context.publishContext.dialectBlockers.length > 0) return result;
  if (!input.syncWhiteboards && !shouldAnalyzeScopes(context)) return result;

  try {
    const analysis = await analyzeExistingPublish({
      cwd: input.cwd,
      file: input.sourcePath,
      target: input.target,
      profile: input.profile,
      dialect: context.dialect,
      dialectConfig: input.dialectConfig,
      strategy: 'auto',
      adapter: input.adapter,
      localSource: context.localSource,
      publishContext: context.publishContext,
      syncWhiteboards: input.syncWhiteboards,
      callouts: input.callouts,
      codeBlocks: input.codeBlocks
    });
    const scopeSummary = analysis.plan.scopedPatch?.scopeSummary ?? emptyScopeSummary();
    const withWhiteboards = statusWithWhiteboards(result, analysis.plan.whiteboards?.assets ?? []);
    const withScopes = statusWithScopedSemanticMismatch(withWhiteboards, analysis.plan.scopedPatch);
    const recommendation = withScopes.state === 'diverged' && scopeSummary.overlappingConflicts.length === 0
      ? {
        action: 'publish-dry-run' as const,
        reason: 'local and remote changes are in disjoint scopes'
      }
      : withScopes.recommendation;
    return {
      ...withScopes,
      ...(analysis.plan.zdocRoundTrip ? { zdocRoundTrip: analysis.plan.zdocRoundTrip } : {}),
      whiteboardBlockers: analysis.plan.whiteboards?.blockers ?? [],
      callouts: summarizeCalloutChanges({
        operations: analysis.plan.scopedPatch?.operations ?? [],
        local: analysis.localCurrent,
        remote: analysis.remoteCurrent
      }),
      calloutBlockers: (analysis.plan.scopedPatch?.blockers ?? []).filter((blocker) => blocker.code.startsWith('callout-') || blocker.code === 'remote-callout-conflict'),
      codeBlocks: summarizeCodeBlockChanges({
        operations: analysis.plan.scopedPatch?.operations ?? [],
        local: analysis.localCurrent,
        remote: analysis.remoteCurrent
      }),
      codeBlockers: (analysis.plan.scopedPatch?.blockers ?? []).filter((blocker) => blocker.code.includes('code-')),
      scopeSummary,
      recommendation
    };
  } catch (error) {
    if (input.syncWhiteboards) throw error;
    return result;
  }
}

function statusWithScopedSemanticMismatch(
  status: PublishStatusResult,
  scopedPatch: ScopedPatchPlan | undefined
): PublishStatusResult {
  const hasManagedMismatch = Boolean(scopedPatch && scopedPatch.scopeSummary.localChanged.length > 0 &&
    (scopedPatch.operations.length > 0 || scopedPatch.blockers.length > 0));
  if (!status.hasReceipt || status.state !== 'clean' || !hasManagedMismatch) return status;
  return {
    ...status,
    state: 'local-changed',
    localChanged: true,
    contentMatchesRemote: false,
    recommendation: {
      action: 'publish-dry-run',
      reason: 'managed semantic structure differs from the canonical publish draft'
    }
  };
}

export async function loadPublishStatusContext(input: {
  cwd: string;
  sourcePath: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect?: DialectName;
  dialectConfig?: DialectWorkspaceConfig;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<PublishStatusContext> {
  const publishContext = await buildPublishContext({
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    dialect: input.dialect ?? 'gfm',
    dialectConfig: input.dialectConfig ?? {},
    profile: input.profile,
    adapter: input.adapter
  });
  const localSource = publishContext.localSource;
  const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
  const codeBlocks = input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG;
  const remoteRaw = await withRateLimitRetry(() => input.adapter.fetchDocMarkdown({ doc: input.target.token }));
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
  let typeHints: ReturnType<typeof calloutTypeHints> | undefined;
  if (/<callout\b/i.test(remoteRaw.markdown) && input.adapter.fetchDocBlocks) {
    const documentId = input.adapter.resolveDocumentId
      ? await withRateLimitRetry(() => input.adapter.resolveDocumentId!({ target: input.target }))
      : input.target.token;
    const blocks = await withRateLimitRetry(() => input.adapter.fetchDocBlocks!({ doc: documentId }));
    const codeMetadata = blocks.blocks.some((block) => block.block_type === 14) && input.adapter.fetchDocCodeMetadata
      ? await withRateLimitRetry(() => input.adapter.fetchDocCodeMetadata!({ doc: documentId }))
      : [];
    const baseline = hasRemoteSemanticSnapshot(receipt)
      ? await readRemoteSemanticSnapshot({ cwd: input.cwd, snapshot: receipt.remoteSemanticSnapshot })
      : undefined;
    const current = applyTrackedCalloutTypes(
      remoteSemanticDocument(blocks.blocks, documentId, callouts, codeMetadata),
      baseline
    );
    typeHints = calloutTypeHints(current);
  }
  const normalized = canonicalizeRemoteCalloutMarkdown({
    markdown: remoteRaw.markdown,
    config: callouts,
    typeHints
  });
  const remote = { ...remoteRaw, markdown: normalized.markdown };
  const publishDraftCanonical = canonicalMarkdown(canonicalizeMarkdownSemantics(
    canonicalizeCodeLanguagesForComparison(publishContext.publishDraft, codeBlocks)
  ));
  const remoteCanonical = canonicalMarkdown(canonicalizeMarkdownSemantics(
    canonicalizeCodeLanguagesForComparison(remote.markdown, codeBlocks)
  ));

  return {
    cwd: input.cwd,
    target: input.target,
    sourcePath: input.sourcePath,
    profile: input.profile,
    dialect: publishContext.dialect,
    publishContext,
    localSource,
    publishDraft: publishContext.publishDraft,
    publishDraftCanonical,
    remoteMarkdown: remote.markdown,
    remoteCanonical,
    remoteRevision: remote.revision,
    receipt,
    transformWarnings: [...publishContext.transformWarnings, ...normalized.warnings]
  };
}

function canonicalizeCodeLanguagesForComparison(markdown: string, config: CodeBlockConfig): string {
  try {
    return canonicalizeFencedCodeLanguages(markdown, config);
  } catch {
    return markdown;
  }
}

export function statusFromContext(context: PublishStatusContext): PublishStatusResult {
  const localSourceHash = hashText(context.localSource);
  const publishDraftHash = hashText(context.publishDraft);
  const publishDraftCanonicalHash = canonicalMarkdownHash(context.publishDraftCanonical);
  const remoteSnapshotHash = hashText(context.remoteMarkdown);
  const remoteCanonicalHash = canonicalMarkdownHash(context.remoteCanonical);
  const contentMatchesRemote = publishDraftCanonicalHash === remoteCanonicalHash;
  const receiptPath = publishReceiptPath({ cwd: context.cwd, target: context.target });

  if (!context.receipt) {
    const state = 'untracked';
    return {
      target: context.target,
      sourcePath: context.sourcePath,
      profile: context.profile,
      ...dialectStatusFields(context),
      state,
      localChanged: true,
      remoteChanged: !contentMatchesRemote,
      contentMatchesRemote,
      hasReceipt: false,
      receiptPath,
      localSourceHash,
      publishDraftHash,
      publishDraftCanonicalHash,
      remoteSnapshotHash,
      remoteCanonicalHash,
      remoteRevision: context.remoteRevision,
      transformWarnings: context.transformWarnings,
      whiteboards: [],
      whiteboardBlockers: [],
      callouts: [],
      calloutBlockers: [],
      codeBlocks: [],
      codeBlockers: [],
      scopeSummary: emptyScopeSummary(),
      recommendation: recommendationFor({
        state,
        contentMatchesRemote,
        dialectBlockers: context.publishContext.dialectBlockers
      })
    };
  }

  let localChanged = context.receipt.publishDraftHash !== publishDraftHash ||
    receiptDialect(context.receipt) !== context.dialect;
  const remoteChanged = context.receipt.remoteSnapshotHash !== remoteSnapshotHash;
  if (localChanged && !remoteChanged && contentMatchesRemote) localChanged = false;
  const state = statusStateFor({ localChanged, remoteChanged });

  return {
    target: context.target,
    sourcePath: context.sourcePath,
    profile: context.profile,
    ...dialectStatusFields(context),
    state,
    localChanged,
    remoteChanged,
    contentMatchesRemote,
    hasReceipt: true,
    receiptPath,
    localSourceHash,
    publishDraftHash,
    publishDraftCanonicalHash,
    remoteSnapshotHash,
    remoteCanonicalHash,
    remoteRevision: context.remoteRevision,
    transformWarnings: context.transformWarnings,
    whiteboards: [],
    whiteboardBlockers: [],
    callouts: [],
    calloutBlockers: [],
    codeBlocks: [],
    codeBlockers: [],
    scopeSummary: emptyScopeSummary(),
    recommendation: recommendationFor({
      state,
      contentMatchesRemote,
      dialectBlockers: context.publishContext.dialectBlockers
    })
  };
}

function shouldAnalyzeScopes(context: PublishStatusContext): boolean {
  return context.dialect === 'zdoc-authoring' ||
    context.localSource.includes('<table') ||
    /(^|\n) {0,3}(?:`{3,}|~{3,})/.test(context.localSource) ||
    /<div\s+class=["'][^"']*\balert\b[^"']*\b(?:note|warning)\b/i.test(context.localSource) ||
    hasRemoteSemanticSnapshot(context.receipt);
}

export function statusWithWhiteboards(
  status: PublishStatusResult,
  whiteboards: WhiteboardAssetPlan[]
): PublishStatusResult {
  if (whiteboards.length === 0) return { ...status, whiteboards };
  const whiteboardLocalChanged = whiteboards.some(({ state }) => {
    return state === 'local-changed' || state === 'conflict' || state === 'untracked' || state === 'missing';
  });
  const whiteboardRemoteChanged = whiteboards.some(({ state }) => {
    return state === 'remote-changed' || state === 'conflict' || state === 'missing';
  });
  const localChanged = status.localChanged || whiteboardLocalChanged;
  const remoteChanged = status.remoteChanged || whiteboardRemoteChanged;
  const state = status.hasReceipt ? statusStateFor({ localChanged, remoteChanged }) : 'untracked';
  return {
    ...status,
    state,
    localChanged,
    remoteChanged,
    whiteboards,
    recommendation: recommendationFor({
      state,
      contentMatchesRemote: status.contentMatchesRemote,
      dialectBlockers: status.dialectBlockers
    })
  };
}

function emptyScopeSummary(): PublishStatusResult['scopeSummary'] {
  return {
    localChanged: [],
    remoteChanged: [],
    overlappingConflicts: [],
    unrelatedRemoteChanges: []
  };
}

function statusStateFor(input: { localChanged: boolean; remoteChanged: boolean }): Exclude<PublishStatusState, 'untracked'> {
  if (input.localChanged && input.remoteChanged) return 'diverged';
  if (input.localChanged) return 'local-changed';
  if (input.remoteChanged) return 'remote-changed';
  return 'clean';
}

function recommendationFor(input: {
  state: PublishStatusState;
  contentMatchesRemote: boolean;
  dialectBlockers?: DialectDiagnostic[];
}): PublishStatusResult['recommendation'] {
  if ((input.dialectBlockers?.length ?? 0) > 0) {
    return {
      action: 'fix-source',
      reason: 'source dialect preprocessing is blocked'
    };
  }
  if (input.state === 'clean') {
    return {
      action: 'no-action',
      reason: 'publish would be a no-op'
    };
  }
  if (input.contentMatchesRemote) {
    return {
      action: 'publish-dry-run',
      reason: 'content matches remote, but the publish receipt is stale'
    };
  }
  if (input.state === 'local-changed') {
    return {
      action: 'publish-dry-run',
      reason: 'local publish draft changed and remote still matches the last publish receipt'
    };
  }
  if (input.state === 'remote-changed') {
    return {
      action: 'pull-review',
      reason: 'remote changed since the last publish receipt'
    };
  }
  if (input.state === 'diverged') {
    return {
      action: 'resolve-divergence',
      reason: 'local publish draft and remote both changed since the last publish receipt'
    };
  }
  if (input.contentMatchesRemote) {
    return {
      action: 'publish-dry-run',
      reason: 'content matches remote, but no publish receipt exists for this target'
    };
  }
  return {
    action: 'adopt-or-replace',
    reason: 'remote is untracked and differs from the current publish draft'
  };
}

function dialectStatusFields(context: PublishStatusContext): Pick<
  PublishStatusResult,
  | 'dialect'
  | 'dialectDraftHash'
  | 'dialectBlockers'
  | 'dialectWarnings'
  | 'dialectDiagnostics'
  | 'linkResolution'
  | 'linkResolutionFingerprint'
> {
  return {
    dialect: context.publishContext.dialect,
    dialectDraftHash: context.publishContext.dialectDraftHash,
    dialectBlockers: context.publishContext.dialectBlockers,
    dialectWarnings: context.publishContext.dialectWarnings,
    dialectDiagnostics: [
      ...context.publishContext.dialectBlockers,
      ...context.publishContext.dialectWarnings
    ],
    linkResolution: context.publishContext.linkResolution,
    linkResolutionFingerprint: context.publishContext.linkResolutionFingerprint
  };
}
