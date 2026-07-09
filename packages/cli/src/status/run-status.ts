import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import { canonicalMarkdown, canonicalMarkdownHash } from '../core/markdown-canonical.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  publishReceiptPath,
  readPublishReceipt,
  type PublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { applyPublishTransformForProfile } from '../publish/profile-transform.js';

export type PublishStatusState = 'untracked' | 'clean' | 'local-changed' | 'remote-changed' | 'diverged';

export type PublishStatusRecommendationAction =
  | 'no-action'
  | 'publish-dry-run'
  | 'pull-review'
  | 'resolve-divergence'
  | 'adopt-or-replace';

export type PublishStatusResult = {
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
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
  recommendation: {
    action: PublishStatusRecommendationAction;
    reason: string;
  };
};

export type PublishStatusContext = {
  cwd: string;
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
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
  adapter: FeishuAdapter;
}): Promise<PublishStatusResult> {
  return statusFromContext(await loadPublishStatusContext(input));
}

export async function loadPublishStatusContext(input: {
  cwd: string;
  sourcePath: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  adapter: FeishuAdapter;
}): Promise<PublishStatusContext> {
  const localSource = await readFile(input.sourcePath, 'utf8');
  const transform = applyPublishTransformForProfile(localSource, input.profile);
  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });

  return {
    cwd: input.cwd,
    target: input.target,
    sourcePath: input.sourcePath,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    publishDraftCanonical: canonicalMarkdown(transform.markdown),
    remoteMarkdown: remote.markdown,
    remoteCanonical: canonicalMarkdown(remote.markdown),
    remoteRevision: remote.revision,
    receipt,
    transformWarnings: transform.warnings
  };
}

export function statusFromContext(context: PublishStatusContext): PublishStatusResult {
  const localSourceHash = hashText(context.localSource);
  const publishDraftHash = hashText(context.publishDraft);
  const publishDraftCanonicalHash = canonicalMarkdownHash(context.publishDraft);
  const remoteSnapshotHash = hashText(context.remoteMarkdown);
  const remoteCanonicalHash = canonicalMarkdownHash(context.remoteMarkdown);
  const contentMatchesRemote = publishDraftCanonicalHash === remoteCanonicalHash;
  const receiptPath = publishReceiptPath({ cwd: context.cwd, target: context.target });

  if (!context.receipt) {
    const state = 'untracked';
    return {
      target: context.target,
      sourcePath: context.sourcePath,
      profile: context.profile,
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
      recommendation: recommendationFor({ state, contentMatchesRemote })
    };
  }

  const localChanged = context.receipt.publishDraftHash !== publishDraftHash;
  const remoteChanged = context.receipt.remoteSnapshotHash !== remoteSnapshotHash;
  const state = statusStateFor({ localChanged, remoteChanged });

  return {
    target: context.target,
    sourcePath: context.sourcePath,
    profile: context.profile,
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
    recommendation: recommendationFor({ state, contentMatchesRemote })
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
}): PublishStatusResult['recommendation'] {
  if (input.state === 'clean') {
    return {
      action: 'no-action',
      reason: 'publish would be a no-op'
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
