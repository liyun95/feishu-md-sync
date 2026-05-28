import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBlocks, hashSource } from '../core/hash.js';
import type { FeishuBlock, FeishuDocClient } from '../feishu/types.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions } from '../markdown/publish-transform.js';
import { findActiveMultisdkTasks, formatActiveMultisdkTaskWarning } from '../multisdk/guard.js';
import { readReceipt, receiptPath, type SyncReceipt, writeReceipt } from '../receipts/receipt.js';
import { buildMarkdownPreflightReport, type MarkdownPreflightReport } from '../services/markdown/preflight.js';
import { comparableDirectChildBlocks, findPageBlock } from './block-state.js';
import { detectConflict } from './conflict.js';
import { defaultMergedPath, threeWayMerge } from './merge.js';
import { applyPatch, planSmartPatch, type PatchPlan } from './patch.js';
import { assertFeishuBlocksWritable } from './preflight.js';
import { planSectionPatch } from './section.js';

export type SyncOptions = {
  sourcePath: string;
  documentId: string;
  rootDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  strategy?: SyncStrategy;
  forceInitialOverwrite?: boolean;
  forceWholeDocumentSync?: boolean;
  publishTransform?: PublishTransformOptions;
  section?: string;
  markdownEngine?: MarkdownEngine;
  confirm?: (question: string) => Promise<boolean>;
};

export type SyncStrategy = 'fail' | 'local-wins' | 'merge';

export type SyncRunResult = {
  mode: 'dry-run' | 'write';
  receiptPath: string;
  patchPlan: PatchPlan;
  receipt: SyncReceipt;
  warnings: string[];
  receiptWritten: boolean;
  preflight: MarkdownPreflightReport;
};

export async function runSync(client: FeishuDocClient, options: SyncOptions): Promise<SyncRunResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const absoluteSourcePath = path.resolve(options.sourcePath);
  const sourceContent = await readFile(absoluteSourcePath, 'utf8');
  const transformedSourceContent = applyPublishTransform(sourceContent, options.publishTransform);
  const markdownEngine = options.markdownEngine ?? createMarkdownEngine({ mode: 'local' });
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
  const mode = options.dryRun === false ? 'write' : 'dry-run';

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
  const strategy = options.strategy ?? 'fail';
  let effectiveSourceContent = transformedSourceContent;
  let shouldWriteMergedSource = false;
  let preflight = buildMarkdownPreflightReport(effectiveSourceContent);

  const activeMultisdkTasks = (await Promise.all(
    multisdkGuardRoots(rootDir, absoluteSourcePath).map((guardRoot) => findActiveMultisdkTasks(guardRoot, options.documentId))
  )).flat();
  if (activeMultisdkTasks.length > 0) {
    const warning = formatActiveMultisdkTaskWarning(activeMultisdkTasks);
    warnings.push(warning);
    if (mode === 'write' && !options.forceWholeDocumentSync && !options.section) {
      throw new Error(
        `Refusing whole-document sync because this document has an active multisdk task. ` +
        `${warning} Pass --force-whole-document-sync only if a whole-document write is intentional.`
      );
    }
  }

  if (options.section && !conflict.ok) {
    warnings.push(
      `Feishu changed since the last receipt; section sync will replace only section "${options.section}" in the current remote document.`
    );
  } else if (!conflict.ok && strategy === 'merge') {
    if (!previousReceipt?.sourceSnapshot) {
      throw new Error('Cannot merge because the previous receipt has no source snapshot. Run a successful baseline sync first, then retry with --strategy merge.');
    }

    const remoteMarkdown = (await markdownEngine.exportMarkdown({
      documentId: options.documentId,
      fallbackBlocks: currentChildren
    })).markdown;
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
    preflight = buildMarkdownPreflightReport(effectiveSourceContent);
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

  const desiredImport = await markdownEngine.importMarkdown({ markdown: effectiveSourceContent });
  warnings.push(...desiredImport.warnings);
  const desiredBlocks = desiredImport.blocks;
  const sourceHash = hashSource(effectiveSourceContent);
  const sectionPatch = options.section ? planSectionPatch(currentChildren, desiredBlocks, options.section) : null;
  const patchPlan = sectionPatch?.patchPlan ?? planSmartPatch(currentChildren, desiredBlocks);
  const patchBlocks = sectionPatch?.replacementBlocks ?? replacementBlocksForPlan(patchPlan, desiredBlocks);
  assertFeishuBlocksWritable(patchBlocks);

  if (conflict.reason === 'no-receipt' && mode === 'write' && currentChildren.length > 0 && !options.forceInitialOverwrite && !options.section) {
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
    const target = options.section
      ? `section "${options.section}" (${patchPlan.createCount} blocks)`
      : `${patchPlan.createCount} blocks`;
    const accepted = await confirm(`Write ${target} to Feishu document ${options.documentId}?`);
    if (!accepted) {
      throw new Error('Sync cancelled.');
    }
  }

  let writeResult = { deleted: 0, created: 0, skipped: patchPlan.operation === 'noop' };
  let afterChildren = currentChildren;
  let afterHash = currentHash;

  if (mode === 'write') {
    writeResult = await applyPatch(client, options.documentId, pageBlock.block_id, patchPlan, patchBlocks);
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
    if (options.section) {
      warnings.push('Section sync does not update the whole-document receipt.');
    }
  }

  const receipt: SyncReceipt = {
    sourcePath: receiptSourcePath,
    sourceHash,
    sourceSnapshot: effectiveSourceContent,
    feishuDocId: options.documentId,
    feishuStateHash: mode === 'write' ? afterHash : currentHash,
    feishuMarkdownSnapshot: (await markdownEngine.exportMarkdown({
      documentId: options.documentId,
      fallbackBlocks: mode === 'write' ? afterChildren : currentChildren
    })).markdown,
    timestamp: new Date().toISOString(),
    blockCounts: {
      source: options.section ? patchPlan.createCount : desiredBlocks.length,
      feishuBefore: currentChildren.length,
      feishuAfter: mode === 'write' ? afterChildren.length : currentChildren.length - patchPlan.deleteCount + patchPlan.createCount
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

  const receiptWritten = mode === 'write' && !options.section;
  if (receiptWritten) {
    await writeReceipt(statePath, receipt);
  }

  return {
    mode,
    receiptPath: statePath,
    patchPlan,
    receipt,
    warnings,
    receiptWritten,
    preflight
  };
}

function originalPathForMergedFile(filePath: string): string | null {
  const parsed = path.parse(filePath);
  if (!parsed.name.endsWith('.merged')) return null;
  const originalName = parsed.name.slice(0, -'.merged'.length);
  if (!originalName) return null;
  return path.join(parsed.dir, `${originalName}${parsed.ext}`);
}

function multisdkGuardRoots(rootDir: string, sourcePath: string): string[] {
  const roots = [path.resolve(rootDir)];
  let current = path.dirname(path.resolve(sourcePath));

  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return Array.from(new Set(roots));
}

function replacementBlocksForPlan(plan: PatchPlan, desiredBlocks: FeishuBlock[]): FeishuBlock[] {
  if (plan.operation !== 'replace-contiguous-blocks') return desiredBlocks;
  if (plan.localStartIndex === undefined || plan.localEndIndex === undefined) {
    throw new Error('Contiguous block patch plan is missing local range metadata.');
  }
  return desiredBlocks.slice(plan.localStartIndex, plan.localEndIndex);
}
