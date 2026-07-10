import type { FeishuBlock, FeishuBlockUpdateRequest, TextElement } from '../feishu/types.js';

const TEXT_LIKE_KEYS: Record<number, string> = {
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  12: 'bullet',
  13: 'ordered',
  14: 'code'
};

export function isTextLikeBlockPairUpdateable(remote: FeishuBlock, desired: FeishuBlock): boolean {
  if (!remote.block_id) return false;
  if (remote.block_type !== desired.block_type) return false;
  return Boolean(TEXT_LIKE_KEYS[remote.block_type] && elementsForBlock(desired));
}

export function buildTextLikeBlockUpdateRequest(remote: FeishuBlock, desired: FeishuBlock): FeishuBlockUpdateRequest {
  if (!remote.block_id || !isTextLikeBlockPairUpdateable(remote, desired)) {
    throw new Error(`Block ${remote.block_id ?? '<missing id>'} cannot be updated in place.`);
  }

  return {
    block_id: remote.block_id,
    update_text_elements: {
      elements: elementsForBlock(desired) ?? []
    }
  };
}

export function elementsForBlock(block: FeishuBlock): TextElement[] | null {
  const key = TEXT_LIKE_KEYS[block.block_type];
  if (!key) return null;
  const value = block[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const elements = (value as { elements?: unknown }).elements;
  return Array.isArray(elements) ? elements as TextElement[] : null;
}
