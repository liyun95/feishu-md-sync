import type { CalloutConfig } from '../config/sync-config.js';
import { normalizeWhitespace } from '../semantic/normalize.js';
import type { CalloutType } from '../semantic/types.js';

export function calloutTypeForTitle(title: string, config: CalloutConfig): CalloutType | undefined {
  const normalized = normalizeTitle(title);
  if (normalized === normalizeTitle(config.noteTitle)) return 'note';
  if (normalized === normalizeTitle(config.warningTitle)) return 'warning';
  if (normalized === 'notes' || normalized === 'note') return 'note';
  if (normalized === 'warning') return 'warning';
  return undefined;
}

export function calloutTypeForEmojiId(emojiId: string | undefined): CalloutType | undefined {
  if (!emojiId) return undefined;
  if (emojiId === '📘' || emojiId === 'blue_book') return 'note';
  if (emojiId === '❗' || emojiId === 'heavy_exclamation_mark') return 'warning';
  return undefined;
}

function normalizeTitle(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase('en-US');
}
