import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  readPublishReceipt,
  writePublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { applyZillizPublishTransform } from '../transform/zilliz-publish.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';

export type RunPublishResult = {
  mode: 'dry-run' | 'write';
  plan: PublishPlan;
};

export async function runPublish(input: {
  cwd: string;
  file: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  write: boolean;
  strategy: 'auto' | PublishStrategy;
  confirmDestructive: boolean;
  adapter: FeishuAdapter;
}): Promise<RunPublishResult> {
  if (input.write && input.strategy === 'document-replace' && !input.confirmDestructive) {
    throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
  }

  const localSource = await readFile(input.file, 'utf8');
  const transform = applyPublishTransformForProfile(localSource, input.profile);
  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: transform.warnings
  });

  if (!input.write || plan.strategy === 'no-op') return { mode: 'dry-run', plan };

  if (plan.strategy === 'document-replace') {
    if (input.strategy !== 'document-replace') {
      throw new Error('document-replace requires --strategy document-replace');
    }
    if (!input.confirmDestructive) {
      throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
    }
    await input.adapter.replaceDocument({ doc: input.target.token, markdown: transform.markdown });
    const after = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
    await writePublishReceipt({
      cwd: input.cwd,
      receipt: {
        version: 1,
        target: input.target,
        profile: input.profile,
        localSourceHash: plan.localSourceHash,
        publishDraftHash: plan.publishDraftHash,
        remoteSnapshotHash: hashText(after.markdown),
        remoteRevision: after.revision,
        updatedAt: new Date().toISOString()
      }
    });
    return { mode: 'write', plan };
  }

  throw new Error(`Write strategy ${plan.strategy} is not implemented in the first slice.`);
}

function applyPublishTransformForProfile(markdown: string, profile: PublishProfileName): { markdown: string; warnings: string[] } {
  if (profile === 'zilliz') return applyZillizPublishTransform(markdown);
  return { markdown, warnings: [] };
}
