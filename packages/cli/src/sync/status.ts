import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashBlocks, hashSource } from '../core/hash.js';
import type { FeishuDocClient } from '../feishu/types.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions } from '../markdown/publish-transform.js';
import { readReceipt, receiptPathFor, type SyncReceipt } from '../receipts/receipt.js';
import { buildMarkdownPreflightReport, type MarkdownPreflightReport } from '../services/markdown/preflight.js';
import { comparableDirectChildBlocks, findPageBlock } from './block-state.js';
import { assertFeishuBlocksWritable } from './preflight.js';

export type SyncState =
  | 'no-receipt'
  | 'clean'
  | 'local-changed'
  | 'remote-changed'
  | 'diverged';

export type StatusInput = {
  sourceHash: string;
  desiredHash: string;
  currentRemoteHash: string;
  receipt: Pick<SyncReceipt, 'sourceHash' | 'feishuStateHash'> | null;
};

export type StatusResult = {
  state: SyncState;
  localChanged: boolean;
  remoteChanged: boolean;
};

export type SyncStatusOptions = {
  sourcePath: string;
  documentId: string;
  rootDir?: string;
  receiptDir?: string;
  publishTransform?: PublishTransformOptions;
  markdownEngine?: MarkdownEngine;
};

export type SyncStatusResult = StatusResult & {
  receiptPath: string;
  sourceHash: string;
  desiredHash: string;
  currentRemoteHash: string;
  preflight: MarkdownPreflightReport;
};

export function computeSyncStatus(input: StatusInput): StatusResult {
  if (!input.receipt) {
    return {
      state: 'no-receipt',
      localChanged: true,
      remoteChanged: input.currentRemoteHash !== input.desiredHash
    };
  }

  const localChanged = input.sourceHash !== input.receipt.sourceHash;
  const remoteChanged = input.currentRemoteHash !== input.receipt.feishuStateHash;

  if (localChanged && remoteChanged) {
    return { state: 'diverged', localChanged, remoteChanged };
  }
  if (localChanged) {
    return { state: 'local-changed', localChanged, remoteChanged };
  }
  if (remoteChanged) {
    return { state: 'remote-changed', localChanged, remoteChanged };
  }
  return { state: 'clean', localChanged, remoteChanged };
}

export async function getSyncStatus(client: FeishuDocClient, options: SyncStatusOptions): Promise<SyncStatusResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const absoluteSourcePath = path.resolve(options.sourcePath);
  const sourceContent = await readFile(absoluteSourcePath, 'utf8');
  const transformedSourceContent = applyPublishTransform(sourceContent, options.publishTransform);
  const preflight = buildMarkdownPreflightReport(transformedSourceContent);
  const engine = options.markdownEngine ?? createMarkdownEngine({ mode: 'local' });
  const desiredBlocks = (await engine.importMarkdown({ markdown: transformedSourceContent })).blocks;
  assertFeishuBlocksWritable(desiredBlocks);
  const sourceHash = hashSource(transformedSourceContent);
  const desiredHash = hashBlocks(desiredBlocks);
  const existingBlocks = await client.getDocumentBlocks(options.documentId);
  const pageBlock = findPageBlock(existingBlocks, options.documentId);
  const currentChildren = comparableDirectChildBlocks(existingBlocks, pageBlock);
  const currentRemoteHash = hashBlocks(currentChildren);
  const statePath = receiptPathFor(rootDir, options.receiptDir, absoluteSourcePath, options.documentId);
  const receipt = await readReceipt(statePath);

  return {
    ...computeSyncStatus({ sourceHash, desiredHash, currentRemoteHash, receipt }),
    receiptPath: statePath,
    sourceHash,
    desiredHash,
    currentRemoteHash,
    preflight
  };
}
