import type {
  CanonicalCodeBlockLanguage,
  CodeBlockInventory,
  CodeBlockInventoryBlock
} from '../feishu/code-blocks.js';
import { CANONICAL_LANGUAGE_ORDER, normalizeCodeBlockLanguage } from '../feishu/code-blocks.js';

export type CodeBlockManifestItem =
  | {
    action: 'update';
    groupId: string;
    blockId: string;
    language: CanonicalCodeBlockLanguage;
    file: string;
    evidence?: string;
  }
  | {
    action: 'insert';
    groupId: string;
    anchorBlockId: string;
    insertAfterBlockId: string;
    parentBlockId: string;
    language: CanonicalCodeBlockLanguage;
    file: string;
    evidence?: string;
  };

export type CodeBlockManifest = {
  document: string;
  documentId: string;
  languageOrder: CanonicalCodeBlockLanguage[];
  items: CodeBlockManifestItem[];
};

export type CodeBlockPlanSummary = {
  documentId: string;
  manifestPath?: string;
  planned: {
    updates: number;
    inserts: number;
    skippedPythonAnchors: number;
  };
  groups: Array<{
    groupId: string;
    pythonAnchorBlockId: string;
    actions: string[];
  }>;
};

export type PlanCodeBlockManifestOptions = {
  document: string;
  inventory: CodeBlockInventory;
  expectLanguages: string[];
  snippetsDir?: string;
};

const EXTENSION_BY_LANGUAGE: Record<CanonicalCodeBlockLanguage, string> = {
  python: 'py',
  java: 'java',
  javascript: 'js',
  go: 'go',
  restful: 'sh'
};

export function planCodeBlockManifest(options: PlanCodeBlockManifestOptions): CodeBlockManifest {
  const expected = normalizeExpectedLanguages(options.expectLanguages);
  const snippetsDir = options.snippetsDir ?? 'snippets';
  const items: CodeBlockManifestItem[] = [];

  for (let groupIndex = 0; groupIndex < options.inventory.groups.length; groupIndex += 1) {
    const group = options.inventory.groups[groupIndex];

    for (const language of expected) {
      const existing = group.blocks.find((block) => block.canonicalLanguage === language);
      if (existing) {
        items.push({
          action: 'update',
          groupId: group.groupId,
          blockId: existing.blockId,
          language,
          file: snippetPath(snippetsDir, language, groupIndex, group.heading)
        });
        continue;
      }

      items.push({
        action: 'insert',
        groupId: group.groupId,
        anchorBlockId: group.pythonAnchorBlockId,
        insertAfterBlockId: nearestPrecedingBlockId(group.blocks, language) ?? group.pythonAnchorBlockId,
        parentBlockId: group.parentBlockId,
        language,
        file: snippetPath(snippetsDir, language, groupIndex, group.heading)
      });
    }
  }

  return {
    document: options.document,
    documentId: options.inventory.documentId,
    languageOrder: CANONICAL_LANGUAGE_ORDER,
    items
  };
}

export function summarizeCodeBlockManifest(
  manifest: CodeBlockManifest,
  manifestPath?: string
): CodeBlockPlanSummary {
  const groups = new Map<string, { groupId: string; pythonAnchorBlockId: string; actions: string[] }>();

  for (const item of manifest.items) {
    const group = groups.get(item.groupId) ?? {
      groupId: item.groupId,
      pythonAnchorBlockId: item.action === 'insert' ? item.anchorBlockId : '',
      actions: []
    };
    if (item.action === 'insert') {
      group.pythonAnchorBlockId = item.anchorBlockId;
    }
    group.actions.push(`${item.action}:${item.language}`);
    groups.set(item.groupId, group);
  }

  return {
    documentId: manifest.documentId,
    manifestPath,
    planned: {
      updates: manifest.items.filter((item) => item.action === 'update').length,
      inserts: manifest.items.filter((item) => item.action === 'insert').length,
      skippedPythonAnchors: 0
    },
    groups: Array.from(groups.values())
  };
}

export function normalizeExpectedLanguages(values: string[]): CanonicalCodeBlockLanguage[] {
  const seen = new Set<CanonicalCodeBlockLanguage>();
  const normalized: CanonicalCodeBlockLanguage[] = [];

  for (const value of values) {
    const language = normalizeCodeBlockLanguage(value);
    if (!language || language === 'python') continue;
    if (seen.has(language)) continue;
    seen.add(language);
    normalized.push(language);
  }

  return CANONICAL_LANGUAGE_ORDER.filter((language) => seen.has(language));
}

export function snippetPath(
  snippetsDir: string,
  language: CanonicalCodeBlockLanguage,
  groupIndex: number,
  heading: string | null
): string {
  const slug = slugify(heading ?? `group-${groupIndex + 1}`);
  return `${trimTrailingSlash(snippetsDir)}/${language}-${String(groupIndex + 1).padStart(2, '0')}-${slug}.${EXTENSION_BY_LANGUAGE[language]}`;
}

function nearestPrecedingBlockId(
  blocks: CodeBlockInventoryBlock[],
  language: CanonicalCodeBlockLanguage
): string | null {
  const languageIndex = CANONICAL_LANGUAGE_ORDER.indexOf(language);

  for (let index = languageIndex - 1; index >= 0; index -= 1) {
    const precedingLanguage = CANONICAL_LANGUAGE_ORDER[index];
    const block = blocks.find((candidate) => candidate.canonicalLanguage === precedingLanguage);
    if (block) return block.blockId;
  }

  return null;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'code-block';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}
