import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from '../core/hash.js';
import {
  codeBlockText,
  isPlaceholderCodeBlock,
  type CanonicalCodeBlockLanguage
} from '../feishu/code-blocks.js';
import type { FeishuBlock } from '../feishu/types.js';
import { loadCodeBlockManifest } from './code-block-export.js';
import type { CodeBlockManifestItem } from './code-block-plan.js';
import { unifiedDiff } from './diff.js';

export type CodeBlockDiffClient = {
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
};

export type CodeBlockDiffReport = {
  documentId: string;
  items: CodeBlockDiffItem[];
};

export type CodeBlockDiffItem = {
  action: CodeBlockManifestItem['action'];
  groupId: string;
  language: CanonicalCodeBlockLanguage;
  file: string;
  blockId?: string;
  anchorBlockId?: string;
  insertAfterBlockId?: string;
  parentBlockId?: string;
  currentHash?: string;
  desiredHash: string;
  isPlaceholder?: boolean;
  currentPreview?: string;
  desiredPreview: string;
  diff: string;
};

export async function buildCodeBlockDiffReport(
  client: CodeBlockDiffClient,
  input: {
    manifestPath: string;
    expectedDocumentId?: string;
  }
): Promise<CodeBlockDiffReport> {
  const manifest = await loadCodeBlockManifest(input.manifestPath);
  if (input.expectedDocumentId && manifest.documentId !== input.expectedDocumentId) {
    throw new Error(`Code block manifest documentId ${manifest.documentId} does not match expected document ${input.expectedDocumentId}.`);
  }

  const manifestDir = dirname(resolve(input.manifestPath));
  const remoteBlocks = await client.getDocumentBlocks(manifest.documentId);
  const remoteBlockById = new Map(remoteBlocks
    .filter((block): block is FeishuBlock & { block_id: string } => typeof block.block_id === 'string')
    .map((block) => [block.block_id, block]));
  const items: CodeBlockDiffItem[] = [];

  for (const item of manifest.items) {
    const desired = await readFile(resolve(manifestDir, item.file), 'utf8');
    const desiredHash = `sha256:${sha256(desired)}`;
    if (item.action === 'update') {
      const remoteBlock = remoteBlockById.get(item.blockId);
      if (!remoteBlock) {
        throw new Error(`Code block diff missing remote block ${item.blockId}. Re-export the multisdk task before approving this diff.`);
      }
      const current = codeBlockText(remoteBlock);
      items.push({
        action: item.action,
        groupId: item.groupId,
        language: item.language,
        file: item.file,
        blockId: item.blockId,
        currentHash: `sha256:${sha256(current)}`,
        desiredHash,
        isPlaceholder: isPlaceholderCodeBlock(current, item.language),
        currentPreview: preview(current),
        desiredPreview: preview(desired),
        diff: unifiedDiff(
          `remote:${item.groupId}:${item.language}:${item.blockId}`,
          `local:${item.file}`,
          current,
          desired
        )
      });
      continue;
    }

    items.push({
      action: item.action,
      groupId: item.groupId,
      language: item.language,
      file: item.file,
      anchorBlockId: item.anchorBlockId,
      insertAfterBlockId: item.insertAfterBlockId,
      parentBlockId: item.parentBlockId,
      currentHash: undefined,
      desiredHash,
      isPlaceholder: undefined,
      currentPreview: undefined,
      desiredPreview: preview(desired),
      diff: unifiedDiff(
        `remote:${item.groupId}:${item.language}:new`,
        `local:${item.file}`,
        '',
        desired
      )
    });
  }

  return {
    documentId: manifest.documentId,
    items
  };
}

export function renderCodeBlockDiffReport(report: CodeBlockDiffReport): string {
  const lines = [
    `document: ${report.documentId}`,
    `items: ${report.items.length}`
  ];

  for (const item of report.items) {
    lines.push('', `## ${item.groupId} ${item.language} ${item.action}`);
    if (item.blockId) lines.push(`block: ${item.blockId}`);
    if (item.anchorBlockId) lines.push(`anchor: ${item.anchorBlockId}`);
    if (item.insertAfterBlockId) lines.push(`insert after: ${item.insertAfterBlockId}`);
    if (item.parentBlockId) lines.push(`parent: ${item.parentBlockId}`);
    lines.push(`file: ${item.file}`);
    if (item.currentHash) lines.push(`current hash: ${item.currentHash}`);
    lines.push(`desired hash: ${item.desiredHash}`);
    if (item.isPlaceholder !== undefined) {
      lines.push(`placeholder: ${item.isPlaceholder ? 'yes' : 'no'}`);
    }
    lines.push('', item.diff.trimEnd());
  }

  return `${lines.join('\n')}\n`;
}

function preview(content: string): string {
  const normalized = content.trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}
