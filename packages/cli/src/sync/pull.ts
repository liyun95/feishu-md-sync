import type { FeishuDocClient } from '../feishu/types.js';
import { hashBlocks } from '../core/hash.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { comparableDirectChildBlocks, findPageBlock, renderableDirectChildBlocks } from './block-state.js';

export type PulledRemoteMarkdown = {
  markdown: string;
  remoteHash: string;
  remoteBlockCount: number;
};

export async function pullRemoteMarkdownWithState(
  client: FeishuDocClient,
  documentId: string,
  engine: MarkdownEngine = createMarkdownEngine({ mode: 'local' })
): Promise<PulledRemoteMarkdown> {
  const existingBlocks = await client.getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(existingBlocks, documentId);
  const renderableChildren = renderableDirectChildBlocks(existingBlocks, pageBlock);
  const comparableChildren = comparableDirectChildBlocks(existingBlocks, pageBlock);
  const exported = await engine.exportMarkdown({ documentId, fallbackBlocks: renderableChildren });

  return {
    markdown: exported.markdown,
    remoteHash: hashBlocks(comparableChildren),
    remoteBlockCount: comparableChildren.length
  };
}

export async function pullRemoteMarkdown(
  client: FeishuDocClient,
  documentId: string,
  engine: MarkdownEngine = createMarkdownEngine({ mode: 'local' })
): Promise<string> {
  return (await pullRemoteMarkdownWithState(client, documentId, engine)).markdown;
}
