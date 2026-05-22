import type {
  CanonicalCodeBlockLanguage,
  CodeBlockInventory,
  CodeBlockInventoryBlock
} from '../feishu/code-blocks.js';
import { CANONICAL_LANGUAGE_ORDER } from '../feishu/code-blocks.js';
import { normalizeExpectedLanguages } from './code-block-plan.js';

export type CodeBlockAuditOptions = {
  expectLanguages: string[];
  allowPlaceholders?: string[];
};

export type CodeBlockAuditReport = {
  passed: boolean;
  checked: {
    groups: number;
    blocks: number;
  };
  missingLanguages: Array<{
    groupId: string;
    pythonAnchorBlockId: string;
    heading: string | null;
    language: CanonicalCodeBlockLanguage;
  }>;
  orderIssues: Array<{
    groupId: string;
    pythonAnchorBlockId: string;
    heading: string | null;
    languages: CanonicalCodeBlockLanguage[];
    expectedOrder: CanonicalCodeBlockLanguage[];
  }>;
  placeholderIssues: Array<PlaceholderReportItem>;
  allowedPlaceholders: Array<PlaceholderReportItem>;
};

type PlaceholderReportItem = {
  groupId: string;
  blockId: string;
  language: CanonicalCodeBlockLanguage;
  heading: string | null;
};

export function auditCodeBlockInventory(
  inventory: CodeBlockInventory,
  options: CodeBlockAuditOptions
): CodeBlockAuditReport {
  const expected = normalizeExpectedLanguages(options.expectLanguages);
  const allowedPlaceholders = new Set(normalizeExpectedLanguages(options.allowPlaceholders ?? []));
  const report: CodeBlockAuditReport = {
    passed: true,
    checked: {
      groups: inventory.groups.length,
      blocks: inventory.blocks.length
    },
    missingLanguages: [],
    orderIssues: [],
    placeholderIssues: [],
    allowedPlaceholders: []
  };

  for (const group of inventory.groups) {
    for (const language of expected) {
      if (!group.blocks.some((block) => block.canonicalLanguage === language)) {
        report.missingLanguages.push({
          groupId: group.groupId,
          pythonAnchorBlockId: group.pythonAnchorBlockId,
          heading: group.heading,
          language
        });
      }
    }

    const languages = group.blocks.map((block) => block.canonicalLanguage);
    const sorted = canonicalSort(languages);
    if (languages.join('\0') !== sorted.join('\0')) {
      report.orderIssues.push({
        groupId: group.groupId,
        pythonAnchorBlockId: group.pythonAnchorBlockId,
        heading: group.heading,
        languages,
        expectedOrder: sorted
      });
    }

    for (const block of group.blocks) {
      if (!block.isPlaceholder || block.canonicalLanguage === 'python') continue;
      const item = placeholderItem(block);
      if (allowedPlaceholders.has(block.canonicalLanguage)) {
        report.allowedPlaceholders.push(item);
      } else {
        report.placeholderIssues.push(item);
      }
    }
  }

  report.passed = report.missingLanguages.length === 0 &&
    report.orderIssues.length === 0 &&
    report.placeholderIssues.length === 0;

  return report;
}

function canonicalSort(languages: CanonicalCodeBlockLanguage[]): CanonicalCodeBlockLanguage[] {
  return [...languages].sort((left, right) => {
    return CANONICAL_LANGUAGE_ORDER.indexOf(left) - CANONICAL_LANGUAGE_ORDER.indexOf(right);
  });
}

function placeholderItem(block: CodeBlockInventoryBlock): PlaceholderReportItem {
  return {
    groupId: block.groupId,
    blockId: block.blockId,
    language: block.canonicalLanguage,
    heading: block.heading
  };
}
