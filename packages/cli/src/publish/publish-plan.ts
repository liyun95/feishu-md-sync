import type { PublishProfileName } from '../profiles/publish-profile.js';
import { hashText, type PublishReceipt, type PublishReceiptTarget } from '../receipts/publish-receipt.js';
import type { PublishBlockPatchPlan } from './block-patch-plan.js';
import type { ScopedPatchPlan } from './scoped-patch-plan.js';

export type PublishStrategy = 'no-op' | 'block-patch' | 'blocked' | 'section-replace' | 'document-replace' | 'create-document';

export type PublishPlan = {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  strategy: PublishStrategy;
  safeToWrite: boolean;
  remoteChanged: boolean;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  requiresCollaborationRiskConfirmation: boolean;
  requiresUntrackedRemoteConfirmation: boolean;
  blockPatch?: {
    operations: PublishBlockPatchPlan['operations'];
    requiresCollaborationRiskConfirmation: boolean;
    fallbackReason?: string;
    warnings: string[];
  };
  scopedPatch?: ScopedPatchPlan;
  risks: string[];
  warnings: string[];
};

export function buildPublishPlan(input: {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSource: string;
  publishDraft: string;
  remoteMarkdown: string;
  receipt: PublishReceipt | undefined;
  transformWarnings: string[];
  createDocument?: boolean;
  forceDocumentReplace?: boolean;
  blockPatch?: PublishBlockPatchPlan;
  scopedPatch?: ScopedPatchPlan;
}): PublishPlan {
  const localSourceHash = hashText(input.localSource);
  const publishDraftHash = hashText(input.publishDraft);
  const remoteSnapshotHash = hashText(input.remoteMarkdown);
  if (input.target.kind === 'folder' || input.createDocument === true) {
    return {
      target: input.target,
      profile: input.profile,
      strategy: 'create-document',
      safeToWrite: true,
      remoteChanged: false,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: false,
      requiresUntrackedRemoteConfirmation: false,
      risks: [],
      warnings: input.transformWarnings
    };
  }

  const remoteChanged = input.receipt ? input.receipt.remoteSnapshotHash !== remoteSnapshotHash : false;
  const risks: string[] = [];

  if (!input.receipt) risks.push('untracked remote: no publish receipt exists for this target');
  if (remoteChanged) risks.push('remote changed since last publish receipt');

  if (input.forceDocumentReplace) {
    risks.push('document replace can affect comments, anchors, block identity, and collaboration context');
    return {
      target: input.target,
      profile: input.profile,
      strategy: 'document-replace',
      safeToWrite: false,
      remoteChanged,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: false,
      requiresUntrackedRemoteConfirmation: false,
      risks,
      warnings: input.transformWarnings
    };
  }

  if (input.scopedPatch) {
    const warnings = [...input.transformWarnings, ...input.scopedPatch.warnings];
    if (input.scopedPatch.blockers.length > 0) {
      risks.push(...input.scopedPatch.blockers.map((blocker) => blocker.message));
      risks.push('scoped publish is blocked; auto will not fall back to document replacement');
      return {
        target: input.target,
        profile: input.profile,
        strategy: 'blocked',
        safeToWrite: false,
        remoteChanged,
        localSourceHash,
        publishDraftHash,
        remoteSnapshotHash,
        requiresCollaborationRiskConfirmation: input.scopedPatch.requiresCollaborationRiskConfirmation,
        requiresUntrackedRemoteConfirmation: !input.receipt,
        scopedPatch: input.scopedPatch,
        risks,
        warnings
      };
    }

    if (input.scopedPatch.operations.length === 0) {
      return {
        target: input.target,
        profile: input.profile,
        strategy: 'no-op',
        safeToWrite: Boolean(input.receipt),
        remoteChanged,
        localSourceHash,
        publishDraftHash,
        remoteSnapshotHash,
        requiresCollaborationRiskConfirmation: false,
        requiresUntrackedRemoteConfirmation: !input.receipt,
        scopedPatch: input.scopedPatch,
        risks,
        warnings
      };
    }

    if (!input.receipt) risks.push('untracked remote block-patch requires explicit confirmation');
    if (input.scopedPatch.requiresCollaborationRiskConfirmation) {
      risks.push('changed blocks may lose comments, anchors, or block identity when replaced');
    }
    return {
      target: input.target,
      profile: input.profile,
      strategy: 'block-patch',
      safeToWrite: Boolean(input.receipt) && !input.scopedPatch.requiresCollaborationRiskConfirmation,
      remoteChanged,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: input.scopedPatch.requiresCollaborationRiskConfirmation,
      requiresUntrackedRemoteConfirmation: !input.receipt,
      scopedPatch: input.scopedPatch,
      risks,
      warnings
    };
  }

  if (publishDraftHash === remoteSnapshotHash) {
    return {
      target: input.target,
      profile: input.profile,
      strategy: 'no-op',
      safeToWrite: true,
      remoteChanged,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: false,
      requiresUntrackedRemoteConfirmation: false,
      risks,
      warnings: input.transformWarnings
    };
  }

  if (input.blockPatch?.safeToWrite === true && !remoteChanged) {
    if (input.blockPatch.operations.length === 0) {
      return {
        target: input.target,
        profile: input.profile,
        strategy: 'no-op',
        safeToWrite: true,
        remoteChanged,
        localSourceHash,
        publishDraftHash,
        remoteSnapshotHash,
        requiresCollaborationRiskConfirmation: false,
        requiresUntrackedRemoteConfirmation: false,
        blockPatch: {
          operations: [],
          requiresCollaborationRiskConfirmation: false,
          fallbackReason: input.blockPatch.fallbackReason,
          warnings: input.blockPatch.warnings
        },
        risks,
        warnings: input.transformWarnings
      };
    }

    if (!input.receipt) {
      risks.push('untracked remote block-patch requires explicit confirmation');
    }
    if (input.blockPatch.requiresCollaborationRiskConfirmation) {
      risks.push('changed blocks may lose comments, anchors, or block identity when replaced');
    }
    return {
      target: input.target,
      profile: input.profile,
      strategy: 'block-patch',
      safeToWrite: Boolean(input.receipt) && !input.blockPatch.requiresCollaborationRiskConfirmation,
      remoteChanged,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: input.blockPatch.requiresCollaborationRiskConfirmation,
      requiresUntrackedRemoteConfirmation: !input.receipt,
      blockPatch: {
        operations: input.blockPatch.operations,
        requiresCollaborationRiskConfirmation: input.blockPatch.requiresCollaborationRiskConfirmation,
        fallbackReason: input.blockPatch.fallbackReason,
        warnings: input.blockPatch.warnings
      },
      risks,
      warnings: input.transformWarnings
    };
  }

  if (input.blockPatch && !input.blockPatch.safeToWrite && input.blockPatch.fallbackReason) {
    risks.push(`block-patch unavailable: ${input.blockPatch.fallbackReason}`);
  }

  const strategy: PublishStrategy = 'blocked';
  risks.push('scoped publish is blocked; auto will not fall back to document replacement');

  return {
    target: input.target,
    profile: input.profile,
    strategy,
    safeToWrite: false,
    remoteChanged,
    localSourceHash,
    publishDraftHash,
    remoteSnapshotHash,
    requiresCollaborationRiskConfirmation: false,
    requiresUntrackedRemoteConfirmation: false,
    risks,
    warnings: input.transformWarnings
  };
}
