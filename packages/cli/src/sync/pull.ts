import type { FeishuDocClient } from '../feishu/types.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { findPageBlock, renderableDirectChildBlocks } from './block-state.js';

export async function pullRemoteMarkdown(
  client: FeishuDocClient,
  documentId: string,
  engine: MarkdownEngine = createMarkdownEngine({ mode: 'local' })
): Promise<string> {
  const existingBlocks = await client.getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(existingBlocks, documentId);
  const currentChildren = renderableDirectChildBlocks(existingBlocks, pageBlock);
  return (await engine.exportMarkdown({ documentId, fallbackBlocks: currentChildren })).markdown;
}
