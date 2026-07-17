import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { DialectDiagnostic, DialectName } from '../dialects/types.js';
import type { LinkResolutionSummary } from '../link-resolvers/types.js';
import {
  hashText,
  whiteboardEntries,
  type PublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import type { PublishBlockPatchPlan } from './block-patch-plan.js';
import type { ScopedPatchPlan } from './scoped-patch-plan.js';
import type { WhiteboardPlan } from '../whiteboards/whiteboard-plan.js';
import type { ZdocRoundTripReport } from '../zdoc/types.js';

export type PublishStrategy = 'no-op' | 'block-patch' | 'blocked' | 'section-replace' | 'document-replace' | 'create-document';

export type PublishPlan = {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect: DialectName;
  dialectDraftHash: string;
  dialectBlockers: DialectDiagnostic[];
  dialectWarnings: DialectDiagnostic[];
  dialectDiagnostics: DialectDiagnostic[];
  linkResolution: LinkResolutionSummary;
  linkResolutionFingerprint: string;
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
  whiteboards?: WhiteboardPlan;
  requiredRemoteWhiteboardOverwrites?: string[];
  risks: string[];
  warnings: string[];
  zdocRoundTrip?: ZdocRoundTripReport;
};

export function buildPublishPlan(input: {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  dialect?: DialectName;
  dialectDraftHash?: string;
  dialectBlockers?: DialectDiagnostic[];
  dialectWarnings?: DialectDiagnostic[];
  linkResolution?: LinkResolutionSummary;
  linkResolutionFingerprint?: string;
  localSource: string;
  publishDraft: string;
  remoteMarkdown: string;
  receipt: PublishReceipt | undefined;
  transformWarnings: string[];
  createDocument?: boolean;
  forceDocumentReplace?: boolean;
  blockPatch?: PublishBlockPatchPlan;
  scopedPatch?: ScopedPatchPlan;
  whiteboards?: WhiteboardPlan;
  zdocRoundTrip?: ZdocRoundTripReport;
}): PublishPlan {
  const localSourceHash = hashText(input.localSource);
  const publishDraftHash = hashText(input.publishDraft);
  const remoteSnapshotHash = hashText(input.remoteMarkdown);
  const dialectFields = {
    dialect: input.dialect ?? 'gfm' as const,
    dialectDraftHash: input.dialectDraftHash ?? publishDraftHash,
    dialectBlockers: input.dialectBlockers ?? [],
    dialectWarnings: input.dialectWarnings ?? [],
    dialectDiagnostics: [
      ...(input.dialectBlockers ?? []),
      ...(input.dialectWarnings ?? [])
    ],
    linkResolution: input.linkResolution ?? {
      resolvedToFeishu: 0,
      resolvedFromFreshCache: 0,
      resolvedFromStaleCache: 0,
      resolvedToPublicSite: 0,
      unresolved: 0
    },
    linkResolutionFingerprint: input.linkResolutionFingerprint ?? hashText('[]'),
    ...(input.zdocRoundTrip ? { zdocRoundTrip: input.zdocRoundTrip } : {})
  };
  if (dialectFields.dialectBlockers.length > 0) {
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
      strategy: 'blocked',
      safeToWrite: false,
      remoteChanged: false,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: false,
      requiresUntrackedRemoteConfirmation: false,
      risks: [
        ...dialectFields.dialectBlockers.map(({ message }) => message),
        'dialect preprocessing is blocked; no remote operation was planned'
      ],
      warnings: input.transformWarnings
    };
  }
  if (input.zdocRoundTrip && !input.zdocRoundTrip.safeToPublish) {
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
      strategy: 'blocked',
      safeToWrite: false,
      remoteChanged: false,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation: false,
      requiresUntrackedRemoteConfirmation: false,
      risks: input.zdocRoundTrip.items
        .filter((item) => item.severity === 'blocker')
        .map((item) => item.message),
      warnings: input.transformWarnings
    };
  }
  if (input.target.kind === 'folder' || input.createDocument === true) {
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
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

  const markdownRemoteChanged = input.receipt ? input.receipt.remoteSnapshotHash !== remoteSnapshotHash : false;
  const whiteboardRemoteChanged = input.whiteboards?.assets.some((asset) => {
    return asset.state === 'remote-changed' || asset.state === 'conflict';
  }) ?? false;
  const remoteChanged = markdownRemoteChanged || whiteboardRemoteChanged;
  const risks: string[] = [];

  if (!input.receipt) risks.push('untracked remote: no publish receipt exists for this target');
  if (remoteChanged) risks.push('remote changed since last publish receipt');

  if (input.forceDocumentReplace) {
    const protectedWhiteboards = dialectFields.dialect === 'zdoc-authoring' &&
      whiteboardEntries(input.receipt).length > 0;
    if (protectedWhiteboards) {
      risks.push('document replacement cannot preserve tracked Whiteboard block and token identity');
      return {
        target: input.target,
        profile: input.profile,
        ...dialectFields,
        strategy: 'blocked',
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
    const protectedSupademo = input.zdocRoundTrip?.items.some((item) => {
      return item.code === 'supademo-adopt' || item.code === 'supademo-protected';
    }) ?? false;
    if (protectedSupademo) {
      risks.push('document replacement cannot preserve protected Supademo block identity');
      return {
        target: input.target,
        profile: input.profile,
        ...dialectFields,
        strategy: 'blocked',
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
    risks.push('document replace can affect comments, anchors, block identity, and collaboration context');
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
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

  if (input.scopedPatch || input.whiteboards) {
    const scopedOperations = input.scopedPatch?.operations ?? [];
    const whiteboardOperations = input.whiteboards?.operations ?? [];
    const scopedBlockers = input.scopedPatch?.blockers ?? [];
    const whiteboardBlockers = input.whiteboards?.blockers ?? [];
    const warnings = [
      ...input.transformWarnings,
      ...(input.scopedPatch?.warnings ?? []),
      ...(input.whiteboards?.warnings ?? [])
    ];
    const requiresCollaborationRiskConfirmation =
      (input.scopedPatch?.requiresCollaborationRiskConfirmation ?? false) ||
      (input.whiteboards?.requiresCollaborationRiskConfirmation ?? false);
    const requiresUntrackedRemoteConfirmation =
      (!input.receipt && Boolean(input.scopedPatch)) ||
      (input.whiteboards?.requiresUntrackedRemoteConfirmation ?? false);
    const requiredRemoteWhiteboardOverwrites = whiteboardOperations.flatMap((operation) => {
      return operation.kind === 'whiteboard-update' &&
        (operation.reason === 'confirmed-remote-overwrite' || operation.reason === 'confirmed-protected-overwrite')
        ? [operation.assetKey]
        : [];
    });

    if (scopedBlockers.length > 0 || whiteboardBlockers.length > 0) {
      risks.push(...scopedBlockers.map((blocker) => blocker.message));
      risks.push(...whiteboardBlockers.map((blocker) => blocker.message));
      risks.push('scoped publish is blocked; auto will not fall back to document replacement');
      return {
        target: input.target,
        profile: input.profile,
        ...dialectFields,
        strategy: 'blocked',
        safeToWrite: false,
        remoteChanged,
        localSourceHash,
        publishDraftHash,
        remoteSnapshotHash,
        requiresCollaborationRiskConfirmation,
        requiresUntrackedRemoteConfirmation,
        scopedPatch: input.scopedPatch,
        whiteboards: input.whiteboards,
        requiredRemoteWhiteboardOverwrites,
        risks,
        warnings
      };
    }

    if (scopedOperations.length === 0 && whiteboardOperations.length === 0) {
      if (requiresUntrackedRemoteConfirmation) risks.push('untracked remote block-patch requires explicit confirmation');
      if (requiresCollaborationRiskConfirmation) {
        risks.push('untracked Callout adoption requires collaboration-risk confirmation');
      }
      return {
        target: input.target,
        profile: input.profile,
        ...dialectFields,
        strategy: 'no-op',
        safeToWrite: !requiresUntrackedRemoteConfirmation && !requiresCollaborationRiskConfirmation,
        remoteChanged,
        localSourceHash,
        publishDraftHash,
        remoteSnapshotHash,
        requiresCollaborationRiskConfirmation,
        requiresUntrackedRemoteConfirmation,
        scopedPatch: input.scopedPatch,
        whiteboards: input.whiteboards,
        requiredRemoteWhiteboardOverwrites,
        risks,
        warnings
      };
    }

    if (requiresUntrackedRemoteConfirmation) risks.push('untracked remote block-patch requires explicit confirmation');
    if (requiresCollaborationRiskConfirmation) {
      risks.push('changed blocks may lose comments, anchors, or block identity when replaced');
    }
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
      strategy: 'block-patch',
      safeToWrite: !requiresCollaborationRiskConfirmation && !requiresUntrackedRemoteConfirmation,
      remoteChanged,
      localSourceHash,
      publishDraftHash,
      remoteSnapshotHash,
      requiresCollaborationRiskConfirmation,
      requiresUntrackedRemoteConfirmation,
      scopedPatch: input.scopedPatch,
      whiteboards: input.whiteboards,
      requiredRemoteWhiteboardOverwrites,
      risks,
      warnings
    };
  }

  if (publishDraftHash === remoteSnapshotHash) {
    return {
      target: input.target,
      profile: input.profile,
      ...dialectFields,
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
        ...dialectFields,
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
      ...dialectFields,
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
    ...dialectFields,
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
