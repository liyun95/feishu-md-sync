import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { FeishuBlock } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  readPublishReceipt,
  writeLocalBaseSnapshot,
  writePublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { canonicalMarkdownHash } from '../core/markdown-canonical.js';
import { findPageBlock, renderableDirectChildBlocks } from '../sync/block-state.js';
import { planPublishBlockPatch, type PublishBlockPatchPlan } from './block-patch-plan.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';
import { resolvePublishTitle } from '../sync/publish-new-plan.js';
import { applyPublishTransformForProfile } from './profile-transform.js';

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
    const localBaseSnapshot = await writeLocalBaseSnapshot({
      cwd: input.cwd,
      target: createdTarget,
      markdown: localSource
    });
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
        localBaseSnapshot,
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
  const blockPatchDraftMarkdown = markdownBodyForBlockPatch(transform.markdown, remote.markdown);
  const blockPatch = input.strategy === 'document-replace'
    ? undefined
    : await planBlockPatchIfAvailable({
      adapter: input.adapter,
      target: input.target,
      publishDraft: blockPatchDraftMarkdown,
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

  if (plan.strategy === 'block-patch') {
    if (input.strategy !== 'auto' && input.strategy !== 'block-patch') {
      throw new Error('block-patch requires --strategy auto or --strategy block-patch');
    }
    if (plan.requiresUntrackedRemoteConfirmation && !input.confirmUntrackedRemote) {
      throw new Error('block-patch for an untracked remote requires --confirm-untracked-remote');
    }
    if (plan.requiresCollaborationRiskConfirmation && !input.confirmCollaborationRisk) {
      throw new Error('block-patch replacing or deleting existing blocks requires --confirm-collaboration-risk');
    }
    await applyBlockPatch({
      adapter: input.adapter,
      doc: input.target.token,
      plan,
      desiredBlocks: markdownToFeishuBlocks(blockPatchDraftMarkdown)
    });
    const after = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
    if (canonicalMarkdownHash(after.markdown) !== canonicalMarkdownHash(transform.markdown)) {
      throw new Error('block-patch readback verification failed: remote Markdown differs from publish draft');
    }
    const localBaseSnapshot = await writeLocalBaseSnapshot({
      cwd: input.cwd,
      target: input.target,
      markdown: localSource
    });
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
        localBaseSnapshot,
        updatedAt: new Date().toISOString()
      }
    });
    return { mode: 'write', plan };
  }

  if (plan.strategy === 'document-replace') {
    if (plan.remoteChanged && input.strategy !== 'document-replace') {
      throw new Error('remote changed since last publish receipt; refusing to write without --strategy document-replace --confirm-destructive');
    }
    if (input.strategy !== 'document-replace') {
      throw new Error('document-replace requires --strategy document-replace');
    }
    if (!input.confirmDestructive) {
      throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
    }
    await input.adapter.replaceDocument({ doc: input.target.token, markdown: transform.markdown });
    const after = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
    const localBaseSnapshot = await writeLocalBaseSnapshot({
      cwd: input.cwd,
      target: input.target,
      markdown: localSource
    });
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
        localBaseSnapshot,
        updatedAt: new Date().toISOString()
      }
    });
    return { mode: 'write', plan };
  }

  throw new Error(`Write strategy ${plan.strategy} is not implemented in the first slice.`);
}

async function applyBlockPatch(input: {
  adapter: FeishuAdapter;
  doc: string;
  plan: PublishPlan;
  desiredBlocks: FeishuBlock[];
}): Promise<void> {
  if (!input.plan.blockPatch) {
    throw new Error('block-patch write is missing a block patch plan');
  }
  if (!input.adapter.replaceBlock || !input.adapter.insertBlocksAfter || !input.adapter.deleteBlocks) {
    throw new Error('Configured Feishu adapter does not support block-patch writes');
  }

  for (const operation of input.plan.blockPatch.operations) {
    if (operation.kind === 'update') {
      const block = blockAtPath(input.desiredBlocks, operation.path);
      if (!block) throw new Error(`block-patch update missing desired block at ${operation.path.join('.')}`);
      await input.adapter.replaceBlock({
        doc: input.doc,
        blockId: operation.remoteBlockId,
        markdown: markdownForWritableBlocks([block])
      });
      continue;
    }

    if (operation.kind === 'create') {
      await input.adapter.insertBlocksAfter({
        doc: input.doc,
        blockId: operation.insertAfterBlockId,
        markdown: markdownForWritableBlocks(operation.blocks)
      });
      continue;
    }

    await input.adapter.deleteBlocks({
      doc: input.doc,
      blockIds: operation.blockIds
    });
  }
}

function blockAtPath(blocks: FeishuBlock[], path: number[]): FeishuBlock | undefined {
  let currentBlocks = blocks;
  let current: FeishuBlock | undefined;
  for (const index of path) {
    current = currentBlocks[index];
    if (!current) return undefined;
    currentBlocks = Array.isArray(current.children) && current.children.every(isFeishuBlock)
      ? current.children
      : [];
  }
  return current;
}

function markdownForWritableBlocks(blocks: FeishuBlock[]): string {
  for (const block of blocks) {
    assertWritableMarkdownBlock(block);
  }
  return feishuBlocksToMarkdown(blocks).trim();
}

function assertWritableMarkdownBlock(block: FeishuBlock): void {
  if (!isWritableMarkdownBlockType(block.block_type)) {
    throw new Error(`block-patch write does not support block_type ${block.block_type}`);
  }
  if (Array.isArray(block.children) && block.children.length > 0) {
    throw new Error(`block-patch write does not support nested children for block_type ${block.block_type}`);
  }
  if (block.block_type === 31) {
    const cells = (block.table as { cells?: unknown[] } | undefined)?.cells ?? [];
    if (!cells.every(isSimpleTableCellBlock)) {
      throw new Error('block-patch write only supports simple Markdown table cells');
    }
  }
}

function isWritableMarkdownBlockType(blockType: number): boolean {
  return blockType === 2 || (blockType >= 3 && blockType <= 8) || blockType === 12 || blockType === 13 || blockType === 14 || blockType === 31;
}

function isSimpleTableCellBlock(value: unknown): boolean {
  if (!isFeishuBlock(value)) return false;
  return value.block_type === 2 && (!Array.isArray(value.children) || value.children.length === 0);
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

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}
