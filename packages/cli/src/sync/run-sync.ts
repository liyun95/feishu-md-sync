import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBlocks, hashSource } from '../core/hash.js';
import type { FeishuDocClient } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { applyPublishTransform, type PublishTransformOptions } from '../markdown/publish-transform.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { readReceipt, receiptPath, type SyncReceipt, writeReceipt } from '../receipts/receipt.js';
import { comparableDirectChildBlocks, directChildBlocks, findPageBlock } from './block-state.js';
import { detectConflict } from './conflict.js';
import { defaultMergedPath, threeWayMerge } from './merge.js';
import { applyPatch, planSmartPatch, type PatchPlan } from './patch.js';

export type SyncOptions = {
  sourcePath: string;
  documentId: string;
  rootDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  strategy?: SyncStrategy;
  forceInitialOverwrite?: boolean;
  publishTransform?: PublishTransformOptions;
  confirm?: (question: string) => Promise<boolean>;
};

export type SyncStrategy = 'fail' | 'local-wins' | 'merge';

export type SyncRunResult = {
  mode: 'dry-run' | 'write';
  receiptPath: string;
  patchPlan: PatchPlan;
  receipt: SyncReceipt;
  warnings: string[];
};

export async function runSync(client: FeishuDocClient, options: SyncOptions): Promise<SyncRunResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const absoluteSourcePath = path.resolve(options.sourcePath);
  const sourceContent = await readFile(absoluteSourcePath, 'utf8');
  const transformedSourceContent = applyPublishTransform(sourceContent, options.publishTransform);
  const existingBlocks = await client.getDocumentBlocks(options.documentId);
  const pageBlock = findPageBlock(existingBlocks, options.documentId);
  const currentChildren = comparableDirectChildBlocks(existingBlocks, pageBlock);
  const currentHash = hashBlocks(currentChildren);
  const initialStatePath = receiptPath(rootDir, absoluteSourcePath, options.documentId);
  let statePath = initialStatePath;
  let receiptSourcePath = absoluteSourcePath;
  let previousReceipt = await readReceipt(initialStatePath);
  let resolvedMergeOriginalPath: string | null = null;
  const warnings: string[] = [];

  if (!previousReceipt) {
    const originalPath = originalPathForMergedFile(absoluteSourcePath);
    if (originalPath) {
      const originalStatePath = receiptPath(rootDir, originalPath, options.documentId);
      const originalReceipt = await readReceipt(originalStatePath);
      if (originalReceipt) {
        statePath = originalStatePath;
        receiptSourcePath = originalPath;
        previousReceipt = originalReceipt;
        resolvedMergeOriginalPath = originalPath;
        warnings.push(`Using baseline receipt from ${originalPath} for resolved merge file ${absoluteSourcePath}.`);
      }
    }
  }

  const conflict = detectConflict(previousReceipt, currentHash);
  const mode = options.dryRun === false ? 'write' : 'dry-run';
  const strategy = options.strategy ?? 'fail';
  let effectiveSourceContent = transformedSourceContent;
  let shouldWriteMergedSource = false;

  if (!conflict.ok && strategy === 'merge') {
    if (!previousReceipt?.sourceSnapshot) {
      throw new Error('Cannot merge because the previous receipt has no source snapshot. Run a successful baseline sync first, then retry with --strategy merge.');
    }

    const remoteMarkdown = feishuBlocksToMarkdown(currentChildren);
    const mergeResult = threeWayMerge({
      base: previousReceipt.sourceSnapshot,
      local: transformedSourceContent,
      remote: remoteMarkdown
    });

    if (!mergeResult.clean) {
      const outputPath = defaultMergedPath(absoluteSourcePath);
      if (mode === 'write') {
        await writeFile(outputPath, mergeResult.content, 'utf8');
        throw new Error(`Merge conflicts written to ${outputPath}. Resolve that file, then sync it with --strategy local-wins.`);
      }
      throw new Error(`Merge conflicts detected. Run with --write --strategy merge to write ${outputPath}, then resolve it and sync with --strategy local-wins.`);
    }

    effectiveSourceContent = mergeResult.content;
    if (mode === 'write') {
      shouldWriteMergedSource = true;
    }
  } else if (!conflict.ok && strategy !== 'local-wins') {
    throw new Error(
      `Refusing to sync because Feishu changed since the last receipt. ` +
      `Expected ${conflict.expectedHash}, got ${conflict.actualHash}. ` +
      `Run status, diff, or merge to inspect the remote change, or retry with --strategy local-wins to overwrite explicitly.`
    );
  }

  if (conflict.reason === 'no-receipt') {
    warnings.push('No previous receipt found; treating this as the first sync baseline.');
  }

  const desiredBlocks = markdownToFeishuBlocks(effectiveSourceContent);
  const sourceHash = hashSource(effectiveSourceContent);
  const patchPlan = planSmartPatch(currentChildren, desiredBlocks);

  if (conflict.reason === 'no-receipt' && mode === 'write' && currentChildren.length > 0 && !options.forceInitialOverwrite) {
    throw new Error(
      `Initial write would replace existing Feishu content (${currentChildren.length} blocks). ` +
      `Run without --write to inspect the plan, or pass --force-initial-overwrite if this is intentional.`
    );
  }

  if (mode === 'write' && !options.yes) {
    const confirm = options.confirm;
    if (!confirm) {
      throw new Error('Write mode requires --yes or an interactive confirmation callback.');
    }
    const accepted = await confirm(`Write ${patchPlan.createCount} blocks to Feishu document ${options.documentId}?`);
    if (!accepted) {
      throw new Error('Sync cancelled.');
    }
  }

  let writeResult = { deleted: 0, created: 0, skipped: patchPlan.operation === 'noop' };
  let afterChildren = currentChildren;
  let afterHash = currentHash;

  if (mode === 'write') {
    writeResult = await applyPatch(client, options.documentId, pageBlock.block_id, patchPlan, desiredBlocks);
    const readbackBlocks = await client.getDocumentBlocks(options.documentId);
    const readbackPage = findPageBlock(readbackBlocks, options.documentId);
    afterChildren = comparableDirectChildBlocks(readbackBlocks, readbackPage);
    afterHash = hashBlocks(afterChildren);
    if (afterHash !== patchPlan.desiredHash) {
      throw new Error(`Verification mismatch after write. Expected ${patchPlan.desiredHash}, got ${afterHash}.`);
    }
    if (shouldWriteMergedSource) {
      await writeFile(absoluteSourcePath, effectiveSourceContent, 'utf8');
    }
    if (resolvedMergeOriginalPath) {
      await writeFile(resolvedMergeOriginalPath, effectiveSourceContent, 'utf8');
      warnings.push(`Updated original source file from resolved merge output: ${resolvedMergeOriginalPath}.`);
    }
  }

  const receipt: SyncReceipt = {
    sourcePath: receiptSourcePath,
    sourceHash,
    sourceSnapshot: effectiveSourceContent,
    feishuDocId: options.documentId,
    feishuStateHash: mode === 'write' ? afterHash : currentHash,
    feishuMarkdownSnapshot: feishuBlocksToMarkdown(mode === 'write' ? afterChildren : currentChildren),
    timestamp: new Date().toISOString(),
    blockCounts: {
      source: desiredBlocks.length,
      feishuBefore: currentChildren.length,
      feishuAfter: afterChildren.length
    },
    warnings,
    writeResult: {
      mode,
      ...writeResult
    },
    verificationResult: {
      ok: mode === 'dry-run' ? true : afterHash === patchPlan.desiredHash,
      expectedHash: patchPlan.desiredHash,
      actualHash: mode === 'write' ? afterHash : patchPlan.currentHash
    }
  };

  if (mode === 'write') {
    await writeReceipt(statePath, receipt);
  }

  return {
    mode,
    receiptPath: statePath,
    patchPlan,
    receipt,
    warnings
  };
}

function originalPathForMergedFile(filePath: string): string | null {
  const parsed = path.parse(filePath);
  if (!parsed.name.endsWith('.merged')) return null;
  const originalName = parsed.name.slice(0, -'.merged'.length);
  if (!originalName) return null;
  return path.join(parsed.dir, `${originalName}${parsed.ext}`);
}
