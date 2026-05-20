import type { FeishuDocClient } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { comparableDirectChildBlocks, findPageBlock } from './block-state.js';

export async function pullRemoteMarkdown(client: FeishuDocClient, documentId: string): Promise<string> {
  const existingBlocks = await client.getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(existingBlocks, documentId);
  const currentChildren = comparableDirectChildBlocks(existingBlocks, pageBlock);
  return feishuBlocksToMarkdown(currentChildren);
}
