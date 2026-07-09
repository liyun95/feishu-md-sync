import type { PublishProfileName } from '../profiles/publish-profile.js';
import { hashText, type PublishReceipt, type PublishReceiptTarget } from '../receipts/publish-receipt.js';

export type PublishStrategy = 'no-op' | 'block-patch' | 'section-replace' | 'document-replace';

export type PublishPlan = {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  strategy: PublishStrategy;
  safeToWrite: boolean;
  remoteChanged: boolean;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
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
}): PublishPlan {
  const localSourceHash = hashText(input.localSource);
  const publishDraftHash = hashText(input.publishDraft);
  const remoteSnapshotHash = hashText(input.remoteMarkdown);
  const remoteChanged = input.receipt ? input.receipt.remoteSnapshotHash !== remoteSnapshotHash : false;
  const risks: string[] = [];

  if (!input.receipt) risks.push('untracked remote: no publish receipt exists for this target');
  if (remoteChanged) risks.push('remote changed since last publish receipt');

  const strategy: PublishStrategy = publishDraftHash === remoteSnapshotHash ? 'no-op' : 'document-replace';
  if (strategy === 'document-replace') {
    risks.push('document replace can affect comments, anchors, block identity, and collaboration context');
  }

  return {
    target: input.target,
    profile: input.profile,
    strategy,
    safeToWrite: strategy === 'no-op',
    remoteChanged,
    localSourceHash,
    publishDraftHash,
    remoteSnapshotHash,
    risks,
    warnings: input.transformWarnings
  };
}
