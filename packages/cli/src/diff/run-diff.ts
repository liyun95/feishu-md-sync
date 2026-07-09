import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';
import { unifiedDiff } from '../sync/diff.js';
import { loadPublishStatusContext, statusFromContext, type PublishStatusResult } from '../status/run-status.js';

export type RunDiffResult = {
  mode: 'read-only';
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
  left: 'remote-current';
  right: 'publish-draft';
  hasDiff: boolean;
  diff: string;
  status: PublishStatusResult;
};

export async function runDiff(input: {
  cwd: string;
  sourcePath: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  adapter: FeishuAdapter;
}): Promise<RunDiffResult> {
  const context = await loadPublishStatusContext(input);
  const hasDiff = context.remoteCanonical !== context.publishDraftCanonical;
  return {
    mode: 'read-only',
    target: input.target,
    sourcePath: input.sourcePath,
    profile: input.profile,
    left: 'remote-current',
    right: 'publish-draft',
    hasDiff,
    diff: hasDiff ? unifiedDiff('remote-current', 'publish-draft', context.remoteCanonical, context.publishDraftCanonical) : '',
    status: statusFromContext(context)
  };
}

export function diffSummaryLines(result: RunDiffResult): string[] {
  const lines = [
    `state: ${result.status.state}`,
    `local changed: ${result.status.localChanged}`,
    `remote changed: ${result.status.remoteChanged}`,
    `content matches remote: ${result.status.contentMatchesRemote}`,
    `recommendation: ${result.status.recommendation.action} - ${result.status.recommendation.reason}`,
    ''
  ];

  if (!result.hasDiff) {
    lines.push('no diff');
    return lines;
  }

  lines.push(result.diff.trimEnd());
  return lines;
}
