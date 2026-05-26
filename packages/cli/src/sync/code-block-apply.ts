import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from '../core/hash.js';
import { CANONICAL_LANGUAGE_ORDER, type CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';
import type { FeishuBlock, FeishuBlockUpdateRequest } from '../feishu/types.js';
import { languageIdForMarkdownLanguage } from '../markdown/blocks.js';
import { updateCodeBlock } from './code-block-update.js';
import { loadCodeBlockManifest } from './code-block-export.js';
import type { CodeBlockManifest, CodeBlockManifestItem } from './code-block-plan.js';

export type CodeBlockApplyClient = {
  batchUpdateBlocks(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
  createChildren(
    documentId: string,
    parentBlockId: string,
    blocks: FeishuBlock[],
    options?: { index?: number }
  ): Promise<FeishuBlock[]>;
  getDocumentBlocks?(documentId: string): Promise<FeishuBlock[]>;
};

export type CodeBlockApplyReport = {
  mode: 'dry-run' | 'write';
  documentId: string;
  updated: Array<{
    blockId: string;
    language: CanonicalCodeBlockLanguage;
    file: string;
    contentHash: string;
    updatedBlocks: number;
  }>;
  inserted: Array<{
    blockId?: string;
    anchorBlockId: string;
    insertAfterBlockId: string;
    parentBlockId: string;
    language: CanonicalCodeBlockLanguage;
    file: string;
    contentHash: string;
  }>;
  failed: Array<{
    action: CodeBlockManifestItem['action'];
    language: CanonicalCodeBlockLanguage;
    file: string;
    message: string;
  }>;
};

export type ApplyCodeBlockManifestOptions = {
  manifestPath: string;
  write: boolean;
  expectedDocumentId?: string;
};

type ResolvedManifestItem = {
  item: CodeBlockManifestItem;
  content: string;
  contentHash: string;
};

export async function applyCodeBlockManifest(
  client: CodeBlockApplyClient,
  options: ApplyCodeBlockManifestOptions
): Promise<CodeBlockApplyReport> {
  const manifest = await loadCodeBlockManifest(options.manifestPath);
  if (options.expectedDocumentId && manifest.documentId !== options.expectedDocumentId) {
    throw new Error(`Code block manifest documentId ${manifest.documentId} does not match expected document ${options.expectedDocumentId}.`);
  }
  const manifestDir = dirname(resolve(options.manifestPath));
  const items = await resolveManifestItems(manifest, manifestDir);
  const report: CodeBlockApplyReport = {
    mode: options.write ? 'write' : 'dry-run',
    documentId: manifest.documentId,
    updated: [],
    inserted: [],
    failed: []
  };
  const blockIdsByGroupLanguage = new Map<string, Map<CanonicalCodeBlockLanguage, string>>();

  for (const resolved of items) {
    const item = resolved.item;
    try {
      if (item.action === 'update') {
        rememberBlockId(blockIdsByGroupLanguage, item.groupId, item.language, item.blockId);
        const result = options.write
          ? await updateCodeBlock(client, {
            documentId: manifest.documentId,
            blockId: item.blockId,
            content: resolved.content,
            language: item.language,
            dryRun: false
          })
          : null;
        report.updated.push({
          blockId: item.blockId,
          language: item.language,
          file: item.file,
          contentHash: resolved.contentHash,
          updatedBlocks: result?.updatedBlocks.length ?? 0
        });
        continue;
      }

      if (!options.write) {
        report.inserted.push({
          anchorBlockId: item.anchorBlockId,
          insertAfterBlockId: item.insertAfterBlockId,
          parentBlockId: item.parentBlockId,
          language: item.language,
          file: item.file,
          contentHash: resolved.contentHash
        });
        continue;
      }

      rememberBlockId(blockIdsByGroupLanguage, item.groupId, 'python', item.anchorBlockId);
      const effectiveInsertAfterBlockId = precedingBlockIdForInsert(blockIdsByGroupLanguage, item) ?? item.insertAfterBlockId;
      const created = await client.createChildren(
        manifest.documentId,
        item.parentBlockId,
        [createCodeBlock(resolved.content, item.language)],
        { index: await insertionIndex(client, manifest.documentId, item.parentBlockId, effectiveInsertAfterBlockId) }
      );
      const blockId = created[0]?.block_id;
      if (blockId) rememberBlockId(blockIdsByGroupLanguage, item.groupId, item.language, blockId);
      report.inserted.push({
        blockId,
        anchorBlockId: item.anchorBlockId,
        insertAfterBlockId: effectiveInsertAfterBlockId,
        parentBlockId: item.parentBlockId,
        language: item.language,
        file: item.file,
        contentHash: resolved.contentHash
      });
    } catch (error) {
      report.failed.push({
        action: item.action,
        language: item.language,
        file: item.file,
        message: (error as Error).message
      });
    }
  }

  return report;
}

async function resolveManifestItems(
  manifest: CodeBlockManifest,
  manifestDir: string
): Promise<ResolvedManifestItem[]> {
  const resolved: ResolvedManifestItem[] = [];

  for (const item of manifest.items) {
    const content = await readFile(resolve(manifestDir, item.file), 'utf8');
    resolved.push({
      item,
      content,
      contentHash: `sha256:${sha256(content)}`
    });
  }

  return resolved;
}

async function insertionIndex(
  client: CodeBlockApplyClient,
  documentId: string,
  parentBlockId: string,
  insertAfterBlockId: string
): Promise<number | undefined> {
  if (!client.getDocumentBlocks) return undefined;
  const blocks = await client.getDocumentBlocks(documentId);
  const parent = blocks.find((block) => block.block_id === parentBlockId);
  const childRefs = Array.isArray(parent?.children) ? parent.children : [];
  const childIndex = childRefs.findIndex((child) => {
    if (typeof child === 'string') return child === insertAfterBlockId;
    return child.block_id === insertAfterBlockId;
  });
  if (childIndex >= 0) return childIndex + 1;

  const target = blocks.find((block) => block.block_id === insertAfterBlockId);
  const targetParentId = target?.parent_id;
  const explicitIndex = target?.index;
  if (targetParentId === parentBlockId && typeof explicitIndex === 'number') return explicitIndex + 1;

  return undefined;
}

function rememberBlockId(
  groups: Map<string, Map<CanonicalCodeBlockLanguage, string>>,
  groupId: string,
  language: CanonicalCodeBlockLanguage,
  blockId: string
): void {
  const group = groups.get(groupId) ?? new Map<CanonicalCodeBlockLanguage, string>();
  group.set(language, blockId);
  groups.set(groupId, group);
}

function precedingBlockIdForInsert(
  groups: Map<string, Map<CanonicalCodeBlockLanguage, string>>,
  item: Extract<CodeBlockManifestItem, { action: 'insert' }>
): string | null {
  const group = groups.get(item.groupId);
  if (!group) return null;
  const languageIndex = CANONICAL_LANGUAGE_ORDER.indexOf(item.language);
  for (let index = languageIndex - 1; index >= 0; index -= 1) {
    const blockId = group.get(CANONICAL_LANGUAGE_ORDER[index]);
    if (blockId) return blockId;
  }
  return null;
}

function createCodeBlock(content: string, language: CanonicalCodeBlockLanguage): FeishuBlock {
  return {
    block_type: 14,
    code: {
      elements: [{
        text_run: {
          content,
          text_element_style: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            inline_code: false
          }
        }
      }],
      style: {
        language: languageIdForMarkdownLanguage(language)
      }
    }
  };
}
