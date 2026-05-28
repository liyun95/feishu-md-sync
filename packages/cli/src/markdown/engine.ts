import type { BlockConvertClient } from '../services/feishu/block-convert-client.js';
import type { DocsContentClient } from '../services/feishu/docs-content-client.js';
import type { FeishuBlock } from '../feishu/types.js';
import { markdownToFeishuBlocks } from './blocks.js';
import { feishuBlocksToMarkdown } from './from-blocks.js';
import { normalizeFeishuBlockLinkUrls } from './links.js';

export type MarkdownEngineName = 'local' | 'official' | 'auto';

export type MarkdownExportInput = {
  documentId: string;
  fallbackBlocks: FeishuBlock[];
};

export type MarkdownImportInput = {
  markdown: string;
};

export type MarkdownEngine = {
  name: MarkdownEngineName;
  exportMarkdown(input: MarkdownExportInput): Promise<{
    markdown: string;
    engine: 'local' | 'official';
    warnings: string[];
  }>;
  importMarkdown(input: MarkdownImportInput): Promise<{
    blocks: FeishuBlock[];
    engine: 'local' | 'official';
    warnings: string[];
  }>;
};

export type CreateMarkdownEngineOptions = {
  mode?: MarkdownEngineName;
  official?: Partial<DocsContentClient & BlockConvertClient>;
};

export function createMarkdownEngine(options: CreateMarkdownEngineOptions = {}): MarkdownEngine {
  const mode = options.mode ?? 'local';
  return {
    name: mode,
    exportMarkdown: async (input) => exportMarkdown(input, mode, options.official),
    importMarkdown: async (input) => importMarkdown(input, mode, options.official)
  };
}

async function exportMarkdown(
  input: MarkdownExportInput,
  mode: MarkdownEngineName,
  official: CreateMarkdownEngineOptions['official']
): Promise<{ markdown: string; engine: 'local' | 'official'; warnings: string[] }> {
  if (mode === 'local') return localExport(input);
  if (!official?.getMarkdownContent) {
    if (mode === 'official') throw new Error('Official Markdown export client is not configured.');
    return {
      ...localExport(input),
      warnings: ['official Markdown export unavailable; used local block export fallback.']
    };
  }

  try {
    return {
      markdown: await official.getMarkdownContent(input.documentId),
      engine: 'official',
      warnings: []
    };
  } catch (error) {
    if (mode === 'official') throw error;
    return {
      ...localExport(input),
      warnings: [`official Markdown export failed: ${(error as Error).message}; used local block export fallback.`]
    };
  }
}

async function importMarkdown(
  input: MarkdownImportInput,
  mode: MarkdownEngineName,
  official: CreateMarkdownEngineOptions['official']
): Promise<{ blocks: FeishuBlock[]; engine: 'local' | 'official'; warnings: string[] }> {
  if (mode === 'local') return localImport(input);
  if (!official?.markdownToBlocks) {
    if (mode === 'official') throw new Error('Official Markdown import client is not configured.');
    return {
      ...localImport(input),
      warnings: ['official Markdown import unavailable; used local block renderer fallback.']
    };
  }

  try {
    return {
      blocks: normalizeFeishuBlockLinkUrls(await official.markdownToBlocks(input.markdown)),
      engine: 'official',
      warnings: []
    };
  } catch (error) {
    if (mode === 'official') throw error;
    return {
      ...localImport(input),
      warnings: [`official Markdown import failed: ${(error as Error).message}; used local block renderer fallback.`]
    };
  }
}

function localExport(input: MarkdownExportInput): { markdown: string; engine: 'local'; warnings: string[] } {
  return {
    markdown: feishuBlocksToMarkdown(input.fallbackBlocks),
    engine: 'local',
    warnings: []
  };
}

function localImport(input: MarkdownImportInput): { blocks: FeishuBlock[]; engine: 'local'; warnings: string[] } {
  return {
    blocks: markdownToFeishuBlocks(input.markdown),
    engine: 'local',
    warnings: []
  };
}
