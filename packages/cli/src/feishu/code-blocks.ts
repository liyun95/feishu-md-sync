import type { FeishuBlock } from './types.js';

export type CodeBlockTargetLanguage = 'java' | 'nodejs' | 'restful' | 'go';
export type CanonicalCodeBlockLanguage = 'python' | 'java' | 'javascript' | 'go' | 'restful';

export const CANONICAL_LANGUAGE_ORDER: CanonicalCodeBlockLanguage[] = [
  'python',
  'java',
  'javascript',
  'go',
  'restful'
];

export type CodeBlockInventoryBlock = {
  blockId: string;
  parentBlockId: string;
  childIndex: number;
  documentIndex: number;
  language: string;
  canonicalLanguage: CanonicalCodeBlockLanguage;
  text: string;
  isPlaceholder: boolean;
  heading: string | null;
  groupId: string;
  pythonAnchorBlockId: string;
};

export type CodeBlockInventoryGroup = {
  groupId: string;
  heading: string | null;
  pythonAnchorBlockId: string;
  parentBlockId: string;
  startIndex: number;
  endIndex: number;
  languages: CanonicalCodeBlockLanguage[];
  missingLanguages: CanonicalCodeBlockLanguage[];
  blocks: CodeBlockInventoryBlock[];
};

export type CodeBlockInventory = {
  documentId: string;
  languageOrder: CanonicalCodeBlockLanguage[];
  groups: CodeBlockInventoryGroup[];
  blocks: CodeBlockInventoryBlock[];
};

export type TargetCodeBlock = {
  language: CodeBlockTargetLanguage;
  blockId: string;
  languageId: number | null;
  text: string;
};

const PLACEHOLDERS_BY_LANGUAGE: Record<CodeBlockTargetLanguage, string[]> = {
  java: ['// java'],
  nodejs: ['// nodejs', '// js'],
  restful: ['# restful'],
  go: ['// go']
};

const LANGUAGE_BY_ID: Record<number, string> = {
  7: 'bash',
  9: 'cpp',
  22: 'go',
  28: 'json',
  29: 'java',
  30: 'javascript',
  40: 'markdown',
  49: 'python',
  50: 'python',
  57: 'sql',
  64: 'typescript',
  67: 'yaml'
};

export function findTargetCodeBlocks(blocks: FeishuBlock[]): TargetCodeBlock[] {
  const targets: TargetCodeBlock[] = [];

  for (const block of blocks) {
    if (block.block_type !== 14 || !block.block_id) continue;

    const text = codeBlockText(block).trim();
    const language = targetLanguageForPlaceholder(text);
    if (!language) continue;

    targets.push({
      language,
      blockId: block.block_id,
      languageId: codeBlockLanguageId(block),
      text
    });
  }

  return targets;
}

export function buildCodeBlockInventory(documentId: string, blocks: FeishuBlock[]): CodeBlockInventory {
  const inventoryBlocks: CodeBlockInventoryBlock[] = [];
  const groups: CodeBlockInventoryGroup[] = [];
  const parentCounters = new Map<string, number>();
  let currentHeading: string | null = null;
  let currentGroup: CodeBlockInventoryGroup | null = null;

  for (let documentIndex = 0; documentIndex < blocks.length; documentIndex += 1) {
    const block = blocks[documentIndex];

    if (isHeadingBlock(block)) {
      currentHeading = headingText(block);
      currentGroup = null;
    }

    const parentBlockId = parentId(block) ?? documentId;
    const childIndex = childIndexForBlock(block, blocks, parentBlockId, parentCounters);

    if (block.block_type !== 14 || !block.block_id) continue;

    const text = codeBlockText(block);
    const language = codeBlockLanguageName(block, text);
    const canonicalLanguage = normalizeCodeBlockLanguage(language);
    if (!canonicalLanguage) continue;

    if (canonicalLanguage === 'python') {
      currentGroup = {
        groupId: `group-${String(groups.length + 1).padStart(3, '0')}`,
        heading: currentHeading,
        pythonAnchorBlockId: block.block_id,
        parentBlockId,
        startIndex: childIndex,
        endIndex: childIndex,
        languages: [],
        missingLanguages: [],
        blocks: []
      };
      groups.push(currentGroup);
    }

    if (!currentGroup) continue;

    const inventoryBlock: CodeBlockInventoryBlock = {
      blockId: block.block_id,
      parentBlockId,
      childIndex,
      documentIndex,
      language,
      canonicalLanguage,
      text,
      isPlaceholder: isPlaceholderCodeBlock(text, canonicalLanguage),
      heading: currentGroup.heading,
      groupId: currentGroup.groupId,
      pythonAnchorBlockId: currentGroup.pythonAnchorBlockId
    };

    currentGroup.blocks.push(inventoryBlock);
    currentGroup.endIndex = Math.max(currentGroup.endIndex, childIndex);
    if (!currentGroup.languages.includes(canonicalLanguage)) {
      currentGroup.languages.push(canonicalLanguage);
    }
    inventoryBlocks.push(inventoryBlock);
  }

  for (const group of groups) {
    group.missingLanguages = CANONICAL_LANGUAGE_ORDER.filter((language) => !group.languages.includes(language));
  }

  return {
    documentId,
    languageOrder: CANONICAL_LANGUAGE_ORDER,
    groups,
    blocks: inventoryBlocks
  };
}

export function normalizeCodeBlockLanguage(value: string): CanonicalCodeBlockLanguage | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'python' || normalized === 'py') return 'python';
  if (normalized === 'java') return 'java';
  if (normalized === 'javascript' || normalized === 'nodejs' || normalized === 'node' || normalized === 'js') {
    return 'javascript';
  }
  if (normalized === 'go' || normalized === 'golang') return 'go';
  if (normalized === 'restful' || normalized === 'rest') return 'restful';
  return null;
}

export function codeBlockText(block: FeishuBlock): string {
  const code = block.code as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
  return (code?.elements ?? []).map((element) => element.text_run?.content ?? '').join('');
}

function codeBlockLanguageId(block: FeishuBlock): number | null {
  const code = block.code as { style?: { language?: unknown } } | undefined;
  const language = code?.style?.language;
  return typeof language === 'number' ? language : null;
}

function targetLanguageForPlaceholder(text: string): CodeBlockTargetLanguage | null {
  for (const [language, placeholders] of Object.entries(PLACEHOLDERS_BY_LANGUAGE)) {
    if (placeholders.includes(text)) {
      return language as CodeBlockTargetLanguage;
    }
  }
  return null;
}

function codeBlockLanguageName(block: FeishuBlock, text: string): string {
  const placeholderLanguage = targetLanguageForPlaceholder(text.trim());
  if (placeholderLanguage) return placeholderLanguage;

  const languageId = codeBlockLanguageId(block);
  if ((languageId === 7 || languageId === 62) && isLikelyRestfulSnippet(text)) {
    return 'restful';
  }
  if (languageId !== null) return LANGUAGE_BY_ID[languageId] ?? String(languageId);

  return '';
}

function isLikelyRestfulSnippet(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith('curl ') ||
    normalized.includes('\ncurl ')
  ) &&
    (
      normalized.includes('/v2/vectordb/') ||
      normalized.includes('--request ') ||
      normalized.includes(' -x ')
    );
}

export function isPlaceholderCodeBlock(text: string, language: CanonicalCodeBlockLanguage): boolean {
  const trimmed = text.trim();
  if (language === 'javascript') {
    return PLACEHOLDERS_BY_LANGUAGE.nodejs.includes(trimmed);
  }
  if (language === 'python') return false;
  return PLACEHOLDERS_BY_LANGUAGE[language]?.includes(trimmed) ?? false;
}

function parentId(block: FeishuBlock): string | null {
  const parent = block.parent_id;
  return typeof parent === 'string' ? parent : null;
}

function childIndexForBlock(
  block: FeishuBlock,
  blocks: FeishuBlock[],
  parentBlockId: string,
  parentCounters: Map<string, number>
): number {
  const explicitIndex = block.index;
  if (typeof explicitIndex === 'number') return explicitIndex;

  const parent = blocks.find((candidate) => candidate.block_id === parentBlockId);
  if (parent?.children && Array.isArray(parent.children) && block.block_id) {
    const fromChildren = parent.children.findIndex((child) => {
      if (typeof child === 'string') return child === block.block_id;
      return child.block_id === block.block_id;
    });
    if (fromChildren >= 0) return fromChildren;
  }

  const current = parentCounters.get(parentBlockId) ?? 0;
  parentCounters.set(parentBlockId, current + 1);
  return current;
}

function isHeadingBlock(block: FeishuBlock): boolean {
  return block.block_type >= 3 && block.block_type <= 8;
}

function headingText(block: FeishuBlock): string {
  const level = block.block_type - 2;
  const heading = block[`heading${level}`] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined;
  return (heading?.elements ?? []).map((element) => element.text_run?.content ?? '').join('');
}
