import { readFile } from 'node:fs/promises';
import type { FeishuAdapter, RemoteMarkdown } from '../adapters/feishu-adapter.js';
import { canonicalMarkdown } from '../core/markdown-canonical.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  canUpgradeLegacyReceipt,
  hashText,
  readLocalBaseSnapshot,
  readPublishReceipt,
  writeLocalBaseSnapshot,
  writePublishReceipt,
  type PublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot, writeRemoteSemanticSnapshot } from '../receipts/semantic-snapshot.js';
import { localSemanticDocument } from '../semantic/local-document.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';
import { semanticHash, stripExecutionMetadata } from '../semantic/normalize.js';
import type { SemanticDocument, SemanticLocator, SemanticNode, SemanticTable, SemanticTextBlock } from '../semantic/types.js';
import { findPageBlock } from './block-state.js';
import { PartialWriteError } from './partial-write-error.js';
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
  adapter: FeishuAdapter;
}): Promise<RunPublishResult> {
  if (input.write && input.strategy === 'document-replace' && !input.confirmDestructive) {
    throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
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
    localSource
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
    await recordPublishReceiptV2({
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
    });
    return { mode: 'write', plan };
  }

  if (plan.strategy === 'block-patch') {
    if (!plan.scopedPatch) throw new Error('block-patch write is missing a scoped patch plan');
    if (!analysis.localCurrent) throw new Error('block-patch write is missing local semantic state');
    await applyScopedPatch({
      adapter: input.adapter,
      doc: analysis.resolvedDocumentId,
      plan: plan.scopedPatch
    });
    const afterMarkdown = await input.adapter.fetchDocMarkdown({ doc: analysis.resolvedDocumentId });
    const afterSemantic = await fetchRemoteSemantic(input.adapter, analysis.resolvedDocumentId);
    await recordPublishReceiptV2({
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
    });
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
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, 'block-patch planning unavailable: adapter cannot fetch Docx blocks']
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      blockPatchDraft,
      remote,
      receipt
    };
  }

  let remoteBlocks: Awaited<ReturnType<Required<FeishuAdapter>['fetchDocBlocks']>>;
  try {
    remoteBlocks = await input.adapter.fetchDocBlocks({ doc: resolvedDocumentId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      plan: buildPublishPlan({
        target: input.target,
        profile: input.profile,
        localSource,
        publishDraft: transform.markdown,
        remoteMarkdown: remote.markdown,
        receipt,
        transformWarnings: [...transform.warnings, `block-patch planning unavailable: ${message}`]
      }),
      resolvedDocumentId,
      localSource,
      publishDraft: transform.markdown,
      blockPatchDraft,
      remote,
      receipt
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
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: transform.warnings,
    scopedPatch
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
    remoteCurrent
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
  if (input.receipt.version === 2) {
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
    requiresCollaborationRiskConfirmation: false
  };
}

async function applyScopedPatch(input: {
  adapter: FeishuAdapter;
  doc: string;
  plan: ScopedPatchPlan;
}): Promise<void> {
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
  const normalized = markdown.replace(/\r\n/g, '\n').trimStart();
  const match = normalized.match(/^#\s+(.+?)(?:\n|$)/);
  return match?.[1]?.trim();
}

function stripLeadingH1(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .trimStart()
    .replace(/^#\s+.+?(?:\n{1,2}|$)/, '')
    .trimStart();
}

function semanticNodeHash(node: SemanticNode): string {
  return semanticHash(stripExecutionMetadata(node));
}
