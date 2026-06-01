import { hashBlocks } from '../core/hash.js';
import type { FeishuBlock, TextElement } from '../feishu/types.js';
import type { PatchPlan } from './patch.js';

export type SectionRange = {
  title: string;
  level: number;
  startIndex: number;
  endIndex: number;
  blocks: FeishuBlock[];
};

export type SectionPatchPlan = {
  patchPlan: PatchPlan;
  replacementBlocks: FeishuBlock[];
  expectedChildren: FeishuBlock[];
  localRange: SectionRange;
  remoteRange: SectionRange;
};

export type InsertSectionOptions = {
  insertSection: string;
  relative: 'before' | 'after';
  targetHeading: string;
};

export function planSectionPatch(
  currentChildren: FeishuBlock[],
  desiredChildren: FeishuBlock[],
  sectionTitle: string
): SectionPatchPlan {
  const remoteRange = findUniqueSectionRange(currentChildren, sectionTitle, 'remote');
  const localRange = findUniqueSectionRange(desiredChildren, sectionTitle, 'local');
  const expectedChildren = [
    ...currentChildren.slice(0, remoteRange.startIndex),
    ...localRange.blocks,
    ...currentChildren.slice(remoteRange.endIndex)
  ];
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(expectedChildren);
  const basePlan = {
    deleteCount: remoteRange.blocks.length,
    createCount: localRange.blocks.length,
    currentHash,
    desiredHash,
    section: {
      title: remoteRange.title,
      remoteStartIndex: remoteRange.startIndex,
      remoteEndIndex: remoteRange.endIndex,
      localStartIndex: localRange.startIndex,
      localEndIndex: localRange.endIndex
    }
  };

  return {
    patchPlan: currentHash === desiredHash
      ? { ...basePlan, operation: 'noop' }
      : { ...basePlan, operation: 'replace-section' },
    replacementBlocks: localRange.blocks,
    expectedChildren,
    localRange,
    remoteRange
  };
}

export function planInsertSectionPatch(
  currentChildren: FeishuBlock[],
  desiredChildren: FeishuBlock[],
  options: InsertSectionOptions
): SectionPatchPlan {
  const localRange = findUniqueSectionRange(desiredChildren, options.insertSection, 'local');
  const targetRange = findUniqueSectionRange(currentChildren, options.targetHeading, 'remote');
  const insertionIndex = options.relative === 'before' ? targetRange.startIndex : targetRange.endIndex;
  const expectedChildren = [
    ...currentChildren.slice(0, insertionIndex),
    ...localRange.blocks,
    ...currentChildren.slice(insertionIndex)
  ];
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(expectedChildren);
  const basePlan = {
    deleteCount: 0,
    createCount: localRange.blocks.length,
    currentHash,
    desiredHash,
    section: {
      title: localRange.title,
      remoteStartIndex: insertionIndex,
      remoteEndIndex: insertionIndex,
      localStartIndex: localRange.startIndex,
      localEndIndex: localRange.endIndex
    }
  };

  return {
    patchPlan: currentHash === desiredHash
      ? { ...basePlan, operation: 'noop' }
      : { ...basePlan, operation: 'replace-section' },
    replacementBlocks: localRange.blocks,
    expectedChildren,
    localRange,
    remoteRange: {
      title: localRange.title,
      level: localRange.level,
      startIndex: insertionIndex,
      endIndex: insertionIndex,
      blocks: []
    }
  };
}

export function planBeforeHeadingPatch(
  currentChildren: FeishuBlock[],
  desiredChildren: FeishuBlock[],
  headingTitle: string
): SectionPatchPlan {
  const remoteTarget = findUniqueSectionRange(currentChildren, headingTitle, 'remote');
  const localTarget = findUniqueSectionRange(desiredChildren, headingTitle, 'local');
  const replacementBlocks = desiredChildren.slice(0, localTarget.startIndex);
  const expectedChildren = [
    ...replacementBlocks,
    ...currentChildren.slice(remoteTarget.startIndex)
  ];
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(expectedChildren);
  const basePlan = {
    deleteCount: remoteTarget.startIndex,
    createCount: replacementBlocks.length,
    currentHash,
    desiredHash,
    section: {
      title: `before heading: ${remoteTarget.title}`,
      remoteStartIndex: 0,
      remoteEndIndex: remoteTarget.startIndex,
      localStartIndex: 0,
      localEndIndex: localTarget.startIndex
    }
  };

  return {
    patchPlan: currentHash === desiredHash
      ? { ...basePlan, operation: 'noop' }
      : { ...basePlan, operation: 'replace-section' },
    replacementBlocks,
    expectedChildren,
    localRange: {
      title: `before heading: ${localTarget.title}`,
      level: localTarget.level,
      startIndex: 0,
      endIndex: localTarget.startIndex,
      blocks: replacementBlocks
    },
    remoteRange: {
      title: `before heading: ${remoteTarget.title}`,
      level: remoteTarget.level,
      startIndex: 0,
      endIndex: remoteTarget.startIndex,
      blocks: currentChildren.slice(0, remoteTarget.startIndex)
    }
  };
}

export function findUniqueSectionRange(
  blocks: FeishuBlock[],
  sectionTitle: string,
  sourceLabel: 'local' | 'remote'
): SectionRange {
  const normalizedTarget = normalizeHeadingText(sectionTitle);
  const matches = blocks
    .map((block, index) => ({ block, index, heading: headingInfo(block) }))
    .filter((item) => item.heading && normalizeHeadingText(item.heading.title) === normalizedTarget);

  if (matches.length === 0) {
    throw new Error(`Could not find ${sourceLabel} section "${sectionTitle}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} ${sourceLabel} sections named "${sectionTitle}". Scoped push requires a unique heading.`);
  }

  const match = matches[0];
  const level = match.heading?.level ?? 1;
  let endIndex = blocks.length;
  for (let index = match.index + 1; index < blocks.length; index += 1) {
    const heading = headingInfo(blocks[index]);
    if (heading && heading.level <= level) {
      endIndex = index;
      break;
    }
  }

  return {
    title: match.heading?.title ?? sectionTitle,
    level,
    startIndex: match.index,
    endIndex,
    blocks: blocks.slice(match.index, endIndex)
  };
}

function headingInfo(block: FeishuBlock): { level: number; title: string } | null {
  if (block.block_type < 3 || block.block_type > 8) return null;
  const level = block.block_type - 2;
  const heading = block[`heading${level}`] as { elements?: TextElement[] } | undefined;
  return {
    level,
    title: renderPlainText(heading?.elements)
  };
}

function renderPlainText(elements: TextElement[] = []): string {
  return elements.map((element) => {
    if (element.text_run) return element.text_run.content;
    if (element.mention_doc?.title) return element.mention_doc.title;
    return '';
  }).join('');
}

function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
