import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { CalloutConfig } from '../config/sync-config.js';
import { DEFAULT_CALLOUT_CONFIG } from '../config/sync-config.js';
import { calloutTypeHints } from '../callouts/callout-baseline.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { CliFailure, confirmationRequired, validationFailure } from '../core/cli-failure.js';
import { sha256, stableStringify } from '../core/hash.js';
import type { DialectName } from '../dialects/types.js';
import type { DialectWorkspaceConfig } from '../link-resolvers/types.js';
import { findPageBlock } from '../publish/block-state.js';
import { buildPublishContext, type PublishContext } from '../publish/publish-context.js';
import { markdownBodyForBlockPatch } from '../publish/block-patch-markdown.js';
import { planScopedPatch, type ScopedPatchOperation } from '../publish/scoped-patch-plan.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  readLocalBaseSnapshot,
  readPublishBaseSnapshot,
  readPublishReceipt,
  protectedResourceEntries,
  whiteboardEntries,
  type ProtectedResourceReceiptEntry,
  type PublishReceipt,
  type PublishReceiptV4,
  type PublishReceiptV5,
  type PublishReceiptTarget,
  type WhiteboardReceiptEntry
} from '../receipts/publish-receipt.js';
import { writePublishBaselineBundle } from '../receipts/publish-baseline-bundle.js';
import { readRemoteSemanticSnapshot } from '../receipts/semantic-snapshot.js';
import { DEFAULT_CODE_BLOCK_CONFIG, type CodeBlockConfig } from '../code-blocks/code-language.js';
import { localSemanticDocument } from '../semantic/local-document.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type {
  SemanticAssetNode,
  SemanticDocument,
  SemanticLocator,
  SemanticNode
} from '../semantic/types.js';
import { planProtectedResources, type ProtectedResourcePlanBlocker } from '../zdoc/protected-resource-plan.js';
import type { DialectDiagnostic } from '../dialects/types.js';
import type { ScopedPatchBlocker } from '../publish/scoped-patch-plan.js';
import { whiteboardRemoteStateHash } from '../whiteboards/remote-state.js';
import { whiteboardPlacementFingerprint } from '../whiteboards/whiteboard-plan.js';

export type LocalBaselineSource =
  | { kind: 'file'; path: string }
  | { kind: 'git'; ref: string };

export type BaselineAdoptResult = {
  mode: 'dry-run' | 'apply';
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect: DialectName;
  sources: {
    localBaseline: {
      kind: LocalBaselineSource['kind'];
      path?: string;
      ref?: string;
      commit?: string;
      sourceHash: string;
      dialectDraftHash: string;
      publishDraftHash: string;
    };
    localCurrent: {
      path: string;
      sourceHash: string;
      dialectDraftHash: string;
      publishDraftHash: string;
    };
    remote: {
      documentId: string;
      revision?: string;
      markdownHash: string;
      semanticHash: string;
    };
  };
  existingDivergence: {
    matching: number;
    changed: number;
    localOnly: number;
    remoteOnly: number;
  };
  delta: {
    localChanged: SemanticLocator[];
    operations: ScopedPatchOperation[];
    blockers: ScopedPatchBlocker[];
    warnings: string[];
    requiresCollaborationRiskConfirmation: boolean;
  };
  protectedResources: ProtectedResourceReceiptEntry[];
  whiteboards: WhiteboardReceiptEntry[];
  safeToAdopt: boolean;
  blockers: BaselineAdoptBlocker[];
  confirmationFingerprint: string;
  receiptWritten?: true;
  receiptPath?: string;
};

export type BaselineAdoptBlocker = DialectDiagnostic | ScopedPatchBlocker |
  ProtectedResourcePlanBlocker | {
    code: 'public-link-fallback';
    message: string;
    source: 'local-baseline' | 'local-current';
    urls: string[];
  } | {
    code: 'remote-code-metadata-unavailable';
    message: string;
  } | {
    code: 'receipt-document-mismatch';
    message: string;
  } | {
    code: 'whiteboard-adapter-unavailable' | 'tracked-whiteboard-missing' |
      'whiteboard-placement-mismatch' | 'remote-whiteboard-changed' |
      'remote-whiteboard-query-failed';
    message: string;
    assetKey: string;
  };

export async function runBaselineAdopt(input: {
  cwd: string;
  sourcePath: string;
  baseline: LocalBaselineSource;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect: DialectName;
  dialectConfig: DialectWorkspaceConfig;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  apply: boolean;
  confirmationFingerprint?: string;
  adapter: FeishuAdapter;
}): Promise<BaselineAdoptResult> {
  const existingReceipt = await validateExistingReceipt(input.cwd, input.target);
  const baselineSource = await readBaselineSource(input);
  const baselineContext = await buildPublishContext({
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    localSource: baselineSource.markdown,
    dialect: input.dialect,
    dialectConfig: input.dialectConfig,
    profile: input.profile,
    adapter: input.adapter
  });
  const currentContext = await buildPublishContext({
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    dialect: input.dialect,
    dialectConfig: input.dialectConfig,
    profile: input.profile,
    adapter: input.adapter
  });
  const documentId = await resolveDocumentId(input.adapter, input.target);
  if (!input.adapter.fetchDocBlocks) {
    throw validationFailure({
      subtype: 'adapter_capability_missing',
      message: 'Baseline adoption requires Docx block reads.'
    });
  }
  const remoteMarkdown = await input.adapter.fetchDocMarkdown({ doc: documentId });
  const remoteBlocks = await input.adapter.fetchDocBlocks({ doc: documentId });
  const capabilityBlockers: BaselineAdoptBlocker[] = remoteBlocks.blocks.some((block) => block.block_type === 14) &&
    !input.adapter.fetchDocCodeMetadata
    ? [{
        code: 'remote-code-metadata-unavailable',
        message: 'Baseline adoption requires remote Code metadata when the document contains Code blocks.'
      }]
    : [];
  const receiptBlockers: BaselineAdoptBlocker[] = existingReceipt?.resolvedDocumentId &&
    existingReceipt.resolvedDocumentId !== documentId
    ? [{
        code: 'receipt-document-mismatch',
        message: `Existing receipt resolves to ${existingReceipt.resolvedDocumentId}, but the target now resolves to ${documentId}.`
      }]
    : [];
  const codeMetadata = input.adapter.fetchDocCodeMetadata
    ? await input.adapter.fetchDocCodeMetadata({ doc: documentId })
    : [];
  const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
  const codeBlocks = input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG;
  const remote = remoteSemanticDocument(remoteBlocks.blocks, documentId, callouts, codeMetadata);
  const canonicalRemoteMarkdown = canonicalizeRemoteCalloutMarkdown({
    markdown: remoteMarkdown.markdown,
    config: callouts,
    typeHints: calloutTypeHints(remote)
  }).markdown;
  const localBase = localSemanticDocument(
    markdownBodyForBlockPatch(
      baselineContext.publishDraft,
      remoteMarkdown.markdown,
      baselineContext.documentTitle
    ),
    codeBlocks,
    baselineContext.zdoc?.inventory
  );
  const localCurrent = localSemanticDocument(
    markdownBodyForBlockPatch(
      currentContext.publishDraft,
      remoteMarkdown.markdown,
      currentContext.documentTitle
    ),
    codeBlocks,
    currentContext.zdoc?.inventory
  );
  const page = findPageBlock(remoteBlocks.blocks, documentId);
  const deltaPlan = planScopedPatch({
    parentBlockId: page.block_id,
    localBase,
    localCurrent,
    remoteBase: stripExecutionMetadata(remote),
    remoteCurrent: remote,
    tracked: true,
    supportsBlockMove: Boolean(input.adapter.moveBlocksAfter)
  });
  const baselineProtected = baselineContext.zdoc || protectedResourceEntries(existingReceipt).length > 0
    ? planProtectedResources({
        local: localBase,
        remote,
        receiptEntries: protectedResourceEntries(existingReceipt)
      })
    : undefined;
  const prospectiveProtected = currentContext.zdoc || baselineProtected
    ? planProtectedResources({
        local: localCurrent,
        remote,
        receiptEntries: baselineProtected?.entries ?? []
      })
    : undefined;
  const existingWhiteboards = whiteboardEntries(existingReceipt);
  const whiteboardBlockers = await validateTrackedWhiteboards({
    entries: existingWhiteboards,
    remote,
    adapter: input.adapter
  });
  const linkBlockers = [
    publicFallbackBlocker('local-baseline', baselineContext),
    publicFallbackBlocker('local-current', currentContext)
  ].filter((blocker): blocker is NonNullable<typeof blocker> => Boolean(blocker));
  const blockers = dedupeBlockers([
    ...baselineContext.dialectBlockers,
    ...currentContext.dialectBlockers,
    ...receiptBlockers,
    ...capabilityBlockers,
    ...linkBlockers,
    ...whiteboardBlockers,
    ...(baselineProtected?.blockers ?? []),
    ...(prospectiveProtected?.blockers ?? []),
    ...deltaPlan.blockers
  ]);
  const resultWithoutFingerprint = {
    mode: input.apply ? 'apply' as const : 'dry-run' as const,
    target: input.target,
    profile: input.profile,
    dialect: input.dialect,
    sources: {
      localBaseline: {
        ...baselineSource.description,
        sourceHash: hashText(baselineSource.markdown),
        dialectDraftHash: baselineContext.dialectDraftHash,
        publishDraftHash: baselineContext.publishDraftHash
      },
      localCurrent: {
        path: input.sourcePath,
        sourceHash: hashText(currentContext.localSource),
        dialectDraftHash: currentContext.dialectDraftHash,
        publishDraftHash: currentContext.publishDraftHash
      },
      remote: {
        documentId,
        ...(remoteMarkdown.revision ? { revision: remoteMarkdown.revision } : {}),
        markdownHash: hashText(remoteMarkdown.markdown),
        semanticHash: semanticHash(stripExecutionMetadata(remote))
      }
    },
    existingDivergence: summarizeDivergence(localBase, remote),
    delta: {
      localChanged: deltaPlan.scopeSummary.localChanged,
      operations: deltaPlan.operations,
      blockers: deltaPlan.blockers,
      warnings: deltaPlan.warnings,
      requiresCollaborationRiskConfirmation: deltaPlan.requiresCollaborationRiskConfirmation
    },
    protectedResources: prospectiveProtected?.entries ?? [],
    whiteboards: existingWhiteboards,
    safeToAdopt: blockers.length === 0,
    blockers
  };
  const { mode: _mode, ...reviewedState } = resultWithoutFingerprint;
  const confirmationFingerprint = sha256(stableStringify(reviewedState));
  if (!input.apply) return {
    ...resultWithoutFingerprint,
    confirmationFingerprint
  };
  if (!input.confirmationFingerprint) {
    throw confirmationRequired({
      subtype: 'baseline_adoption',
      message: 'Baseline adoption apply requires --confirm-baseline-adoption <fingerprint>.',
      hint: 'review the baseline adopt dry-run and pass its exact confirmation fingerprint',
      requiredFlags: ['--confirm-baseline-adoption <fingerprint>']
    });
  }
  if (input.confirmationFingerprint !== confirmationFingerprint) {
    throw new CliFailure({
      type: 'conflict',
      subtype: 'baseline_confirmation_mismatch',
      message: 'Baseline adoption confirmation fingerprint does not match the current L0/L1/R0 state.',
      hint: 'rerun the dry-run and review the current baseline adoption state',
      retryable: false
    });
  }
  if (!resultWithoutFingerprint.safeToAdopt) {
    throw new CliFailure({
      type: 'conflict',
      subtype: 'baseline_adoption_blocked',
      message: 'Baseline adoption is blocked by the prospective delta plan.',
      hint: 'resolve every reported blocker before adopting the baseline',
      retryable: false
    });
  }
  const verifiedRemote = await input.adapter.fetchDocMarkdown({ doc: documentId });
  if (verifiedRemote.revision !== remoteMarkdown.revision ||
    hashText(verifiedRemote.markdown) !== hashText(remoteMarkdown.markdown)) {
    throw new CliFailure({
      type: 'verification',
      subtype: 'remote_changed_before_baseline_adoption',
      message: 'Remote changed before baseline adoption commit. Rerun the dry-run and review the new R0.',
      hint: 'rerun baseline adopt dry-run against the new remote revision',
      retryable: false
    });
  }
  const written = await writePublishBaselineBundle({
    cwd: input.cwd,
    target: input.target,
    localBaseline: baselineSource.markdown,
    publishBaseline: baselineContext.publishDraft,
    remoteSemantic: remote,
    receipt: {
      resolvedDocumentId: documentId,
      profile: input.profile,
      dialect: input.dialect,
      dialectDraftHash: baselineContext.dialectDraftHash,
      dialectDependencies: baselineContext.dialectDependencies,
      linkResolutionFingerprint: baselineContext.linkResolutionFingerprint,
      resolvedLinks: baselineContext.resolvedLinks,
      localSourceHash: hashText(baselineSource.markdown),
      publishDraftHash: baselineContext.publishDraftHash,
      remoteSnapshotHash: hashText(canonicalRemoteMarkdown),
      ...(remoteMarkdown.revision ? { remoteRevision: remoteMarkdown.revision } : {}),
      whiteboards: existingWhiteboards,
      protectedResources: prospectiveProtected?.entries,
      updatedAt: new Date().toISOString()
    }
  });
  return {
    ...resultWithoutFingerprint,
    confirmationFingerprint,
    receiptWritten: true,
    receiptPath: written.receiptPath
  };
}

async function validateExistingReceipt(
  cwd: string,
  target: PublishReceiptTarget
): Promise<PublishReceiptV4 | PublishReceiptV5 | undefined> {
  let receipt: PublishReceipt | undefined;
  try {
    receipt = await readPublishReceipt({ cwd, target });
  } catch (error) {
    throw receiptIntegrityFailure('Existing publish receipt cannot be read.', error);
  }
  if (!receipt) return undefined;
  if (receipt.version !== 4 && receipt.version !== 5) {
    throw validationFailure({
      subtype: 'baseline_receipt_version_unsupported',
      message: 'Baseline adoption can repair only version 4 or 5 publish receipts.'
    });
  }
  try {
    const local = await readLocalBaseSnapshot({ cwd, snapshot: receipt.localBaseSnapshot });
    if (local === undefined) throw new Error('Existing local base snapshot is missing.');
    const publish = await readPublishBaseSnapshot({ cwd, snapshot: receipt.publishBaseSnapshot });
    if (publish === undefined) throw new Error('Existing publish base snapshot is missing.');
    if (!receipt.remoteSemanticSnapshot) {
      throw new Error('Existing remote semantic snapshot is missing.');
    }
    const remote = await readRemoteSemanticSnapshot({ cwd, snapshot: receipt.remoteSemanticSnapshot });
    if (!remote) throw new Error('Existing remote semantic snapshot is missing.');
  } catch (error) {
    throw receiptIntegrityFailure(
      error instanceof Error ? error.message : 'Existing baseline sidecar integrity check failed.',
      error
    );
  }
  return receipt;
}

async function readBaselineSource(input: {
  cwd: string;
  sourcePath: string;
  baseline: LocalBaselineSource;
}): Promise<{
  markdown: string;
  description: { kind: 'file'; path: string } | { kind: 'git'; ref: string; commit: string };
}> {
  if (input.baseline.kind === 'file') {
    let markdown: string;
    try {
      markdown = await readFile(input.baseline.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw validationFailure({
          subtype: 'baseline_source_missing',
          message: `Local baseline file does not exist: ${input.baseline.path}`
        });
      }
      throw error;
    }
    return {
      markdown,
      description: { kind: 'file', path: input.baseline.path }
    };
  }
  const git = promisify(execFile);
  let rootResult: { stdout: string; stderr: string };
  try {
    rootResult = await git('git', ['rev-parse', '--show-toplevel'], { cwd: input.cwd, encoding: 'utf8' });
  } catch (error) {
    throw validationFailure({
      subtype: 'baseline_git_repository_unavailable',
      message: `Cannot resolve a Git repository for baseline adoption from ${input.cwd}.`,
      hint: error instanceof Error ? error.message.split('\n', 1)[0] : undefined
    });
  }
  const root = await realpath(rootResult.stdout.trim());
  let sourcePath: string;
  try {
    sourcePath = await realpath(input.sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw validationFailure({
        subtype: 'baseline_source_missing',
        message: `Current Markdown source does not exist: ${input.sourcePath}`
      });
    }
    throw error;
  }
  const relativePath = path.relative(root, sourcePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error('The Markdown source is outside the selected Git repository.');
  }
  let commitResult: { stdout: string; stderr: string };
  try {
    commitResult = await git('git', ['rev-parse', `${input.baseline.ref}^{commit}`], { cwd: root, encoding: 'utf8' });
  } catch {
    throw validationFailure({
      subtype: 'baseline_git_ref_invalid',
      message: `Git baseline ref does not resolve to a commit: ${input.baseline.ref}`
    });
  }
  const commit = commitResult.stdout.trim();
  const gitPath = relativePath.split(path.sep).join('/');
  let sourceResult: { stdout: string; stderr: string };
  try {
    sourceResult = await git('git', ['show', `${commit}:${gitPath}`], { cwd: root, encoding: 'utf8' });
  } catch {
    throw validationFailure({
      subtype: 'baseline_source_missing_at_git_ref',
      message: `Markdown source ${gitPath} does not exist at ${input.baseline.ref} (${commit}).`
    });
  }
  return {
    markdown: sourceResult.stdout,
    description: { kind: 'git', ref: input.baseline.ref, commit }
  };
}

function publicFallbackBlocker(
  source: 'local-baseline' | 'local-current',
  context: PublishContext
): Extract<BaselineAdoptBlocker, { code: 'public-link-fallback' }> | undefined {
  const urls = context.resolvedLinks
    .filter((link) => link.source === 'public-site')
    .map((link) => link.resolvedUrl);
  if (context.linkResolution.resolvedToPublicSite === 0 && urls.length === 0) return undefined;
  return {
    code: 'public-link-fallback',
    message: `${source} resolves ${Math.max(context.linkResolution.resolvedToPublicSite, urls.length)} link(s) to the public site.`,
    source,
    urls
  };
}

function receiptIntegrityFailure(message: string, cause: unknown): CliFailure {
  return new CliFailure({
    type: 'verification',
    subtype: 'baseline_receipt_integrity',
    message,
    hint: 'restore the original receipt bundle from a trusted backup, then rerun baseline adopt; do not edit or delete receipt/sidecar files manually',
    retryable: false
  }, { cause: cause instanceof Error ? cause : undefined });
}

function dedupeBlockers(blockers: BaselineAdoptBlocker[]): BaselineAdoptBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = stableStringify(blocker);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function validateTrackedWhiteboards(input: {
  entries: WhiteboardReceiptEntry[];
  remote: SemanticDocument;
  adapter: FeishuAdapter;
}): Promise<BaselineAdoptBlocker[]> {
  if (input.entries.length === 0) return [];
  if (!input.adapter.queryWhiteboard) {
    return input.entries.map((entry) => ({
      code: 'whiteboard-adapter-unavailable' as const,
      assetKey: entry.assetKey,
      message: `Cannot verify tracked Whiteboard ${entry.assetKey}: adapter query support is unavailable.`
    }));
  }

  const blockers: BaselineAdoptBlocker[] = [];
  for (const entry of input.entries) {
    const remote = input.remote.nodes.find((node): node is SemanticAssetNode => {
      return node.kind === 'asset' && node.representation === 'whiteboard' &&
        node.remoteBlockId === entry.blockId && node.remoteToken === entry.whiteboardToken;
    });
    if (!remote) {
      blockers.push({
        code: 'tracked-whiteboard-missing',
        assetKey: entry.assetKey,
        message: `Tracked Whiteboard identity is missing remotely: ${entry.assetKey}.`
      });
      continue;
    }
    if (whiteboardPlacementFingerprint(input.remote, remote.locator) !== entry.placementFingerprint) {
      blockers.push({
        code: 'whiteboard-placement-mismatch',
        assetKey: entry.assetKey,
        message: `Tracked Whiteboard placement changed remotely: ${entry.assetKey}.`
      });
      continue;
    }
    try {
      const state = await input.adapter.queryWhiteboard({ whiteboardToken: entry.whiteboardToken });
      if (whiteboardRemoteStateHash(state.raw) !== entry.remoteStateHash) {
        blockers.push({
          code: 'remote-whiteboard-changed',
          assetKey: entry.assetKey,
          message: `Tracked Whiteboard changed remotely: ${entry.assetKey}.`
        });
      }
    } catch (error) {
      blockers.push({
        code: 'remote-whiteboard-query-failed',
        assetKey: entry.assetKey,
        message: `Failed to verify tracked Whiteboard ${entry.assetKey}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  return blockers;
}

async function resolveDocumentId(
  adapter: FeishuAdapter,
  target: PublishReceiptTarget
): Promise<string> {
  if (target.kind === 'docx') return target.token;
  if (!adapter.resolveDocumentId) throw new Error('Baseline adoption requires target resolution.');
  return adapter.resolveDocumentId({ target });
}

function summarizeDivergence(
  local: SemanticDocument,
  remote: SemanticDocument
): BaselineAdoptResult['existingDivergence'] {
  const localByKey = new Map(local.nodes.map((node) => [locatorKey(node), node]));
  const remoteByKey = new Map(remote.nodes.map((node) => [locatorKey(node), node]));
  const shared = [...localByKey.keys()].filter((key) => remoteByKey.has(key));
  const matching = shared.filter((key) => {
    return comparableNodeHash(localByKey.get(key)!) === comparableNodeHash(remoteByKey.get(key)!);
  }).length;
  return {
    matching,
    changed: shared.length - matching,
    localOnly: [...localByKey.keys()].filter((key) => !remoteByKey.has(key)).length,
    remoteOnly: [...remoteByKey.keys()].filter((key) => !localByKey.has(key)).length
  };
}

function locatorKey(node: SemanticNode): string {
  return `${node.locator.kind}:${JSON.stringify(node.locator.sectionPath)}:${node.locator.ordinal}`;
}

function comparableNodeHash(node: SemanticNode): string {
  return semanticHash(stripExecutionMetadata(node));
}
