import type { CalloutConfig } from '../config/sync-config.js';
import type { FeishuBlock } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import type { SemanticTextChild } from './types.js';

export function semanticTextChildren(
  block: FeishuBlock,
  callouts?: CalloutConfig
): SemanticTextChild[] | undefined {
  const children = Array.isArray(block.children)
    ? block.children.filter(isFeishuBlock)
    : [];
  if (children.length === 0) return undefined;
  return children.map((child) => {
    const nested = semanticTextChildren(child, callouts);
    return {
      blockType: child.block_type,
      markdown: feishuBlocksToMarkdown([child], callouts).trim(),
      ...(child.block_id ? { remoteBlockId: child.block_id } : {}),
      ...(nested ? { children: nested } : {})
    };
  });
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}
