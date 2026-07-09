import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  readPublishReceipt,
  writePublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { applyZillizPublishTransform } from '../transform/zilliz-publish.js';
import { findPageBlock, renderableDirectChildBlocks } from '../sync/block-state.js';
import { planPublishBlockPatch, type PublishBlockPatchPlan } from './block-patch-plan.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';
import { resolvePublishTitle } from '../sync/publish-new-plan.js';

export type RunPublishResult = {
  mode: 'dry-run' | 'write';
  plan: PublishPlan;
  document?: {
    documentId: string;
    url?: string;
  };
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
    const title = resolvePublishTitle({
      sourcePath: input.file,
      markdown: transform.markdown
    }).title;
    const plan = buildPublishPlan({
      target: input.target,
      profile: input.profile,
      localSource,
      publishDraft: transform.markdown,
      remoteMarkdown: '',
      receipt: undefined,
      transformWarnings: transform.warnings,
      createDocument: true
    });

    if (!input.write) return { mode: 'dry-run', plan };

    const created = await input.adapter.createDocument({
      title,
      markdown: transform.markdown,
      parentToken: input.target.token
    });
    const createdTarget = { kind: 'docx' as const, token: created.documentId };
    const after = await input.adapter.fetchDocMarkdown({ doc: created.documentId });
    await writePublishReceipt({
      cwd: input.cwd,
      receipt: {
        version: 1,
        target: createdTarget,
        profile: input.profile,
        localSourceHash: plan.localSourceHash,
        publishDraftHash: plan.publishDraftHash,
        remoteSnapshotHash: hashText(after.markdown),
        remoteRevision: after.revision ?? created.revision,
        updatedAt: new Date().toISOString()
      }
    });
    return {
      mode: 'write',
      plan,
      document: {
        documentId: created.documentId,
        url: created.url
      }
    };
  }

  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
  const blockPatch = input.strategy === 'document-replace'
    ? undefined
    : await planBlockPatchIfAvailable({
      adapter: input.adapter,
      target: input.target,
      publishDraft: transform.markdown,
      warnings: transform.warnings
    });
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: transform.warnings,
    blockPatch
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

async function planBlockPatchIfAvailable(input: {
  adapter: FeishuAdapter;
  target: PublishReceiptTarget;
  publishDraft: string;
  warnings: string[];
}): Promise<PublishBlockPatchPlan | undefined> {
  if (input.target.kind !== 'docx' || !input.adapter.fetchDocBlocks) {
    return undefined;
  }

  try {
    const remote = await input.adapter.fetchDocBlocks({ doc: input.target.token });
    const pageBlock = findPageBlock(remote.blocks, input.target.token);
    return planPublishBlockPatch({
      parentBlockId: pageBlock.block_id,
      remoteBlocks: renderableDirectChildBlocks(remote.blocks, pageBlock),
      desiredBlocks: markdownToFeishuBlocks(input.publishDraft)
    });
  } catch (error) {
    input.warnings.push(`block-patch planning unavailable: ${(error as Error).message}`);
    return undefined;
  }
}
