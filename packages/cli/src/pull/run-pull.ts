import { readFile, writeFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import { canonicalizeFencedCodeLanguages } from '../code-blocks/code-markdown.js';
import { calloutTypeHints } from '../callouts/callout-baseline.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import { findPageBlock, renderableDirectChildBlocks } from '../publish/block-state.js';
import {
  normalizeReceiptOutputPath,
  pullReceiptPath,
  writePullReceipt
} from '../receipts/pull-receipt.js';
import { hashText, type PublishReceiptTarget } from '../receipts/publish-receipt.js';
import { applyPullTransformForProfile } from '../transform/zilliz-pull.js';
import { remoteSemanticDocument } from '../semantic/remote-document.js';

export type RunPullResult = {
  mode: 'write';
  target: PublishReceiptTarget;
  outputPath: string;
  profile: PublishProfileName;
  remoteRevision?: string;
  remoteRawHash: string;
  outputHash: string;
  receiptPath?: string;
  warnings: string[];
};

export async function runPull(input: {
  cwd: string;
  target: PublishReceiptTarget;
  outputPath: string;
  profile: PublishProfileName;
  overwrite: boolean;
  writeReceipt: boolean;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<RunPullResult> {
  await assertPullOutputWritable(input.outputPath, input.overwrite);

  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const hierarchy = await repairNestedHierarchyFromBlocks({
    adapter: input.adapter,
    target: input.target,
    markdown: remote.markdown,
    callouts: input.callouts ?? DEFAULT_CALLOUT_CONFIG
  });
  const callouts = input.callouts ?? DEFAULT_CALLOUT_CONFIG;
  let normalized: ReturnType<typeof canonicalizeRemoteCalloutMarkdown>;
  try {
    normalized = canonicalizeRemoteCalloutMarkdown({
      markdown: hierarchy.markdown,
      config: callouts,
      normalizeParagraphPayload: true
    });
  } catch (error) {
    if (!isUnidentifiedCalloutTitleError(error) || !hierarchy.calloutTypeHints) throw error;
    normalized = canonicalizeRemoteCalloutMarkdown({
      markdown: hierarchy.markdown,
      config: callouts,
      typeHints: hierarchy.calloutTypeHints,
      normalizeParagraphPayload: true
    });
    normalized.warnings.unshift('remote Callout types were resolved from Docx block metadata');
  }
  const codeCanonical = canonicalizeFencedCodeLanguages(
    normalized.markdown,
    input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG
  );
  const transform = applyPullTransformForProfile(codeCanonical, input.profile);
  await writeFile(input.outputPath, transform.markdown, 'utf8');

  const written = await readFile(input.outputPath, 'utf8');
  const outputHash = hashText(transform.markdown);
  const writtenHash = hashText(written);
  if (writtenHash !== outputHash) {
    throw new Error(`pull local write verification failed: expected ${outputHash}, got ${writtenHash}`);
  }

  const remoteRawHash = hashText(remote.markdown);
  const result: RunPullResult = {
    mode: 'write',
    target: input.target,
    outputPath: input.outputPath,
    profile: input.profile,
    remoteRevision: remote.revision,
    remoteRawHash,
    outputHash,
    warnings: [...hierarchy.warnings, ...normalized.warnings, ...transform.warnings]
  };

  if (input.writeReceipt) {
    const receipt = {
      version: 1 as const,
      kind: 'pull-snapshot' as const,
      target: input.target,
      outputPath: normalizeReceiptOutputPath({ cwd: input.cwd, outputPath: input.outputPath }),
      profile: input.profile,
      remoteRevision: remote.revision,
      remoteRawHash,
      outputHash,
      pulledAt: new Date().toISOString()
    };
    await writePullReceipt({ cwd: input.cwd, receipt });
    result.receiptPath = pullReceiptPath({ cwd: input.cwd, outputPath: receipt.outputPath, target: input.target });
  }

  return result;
}

function isUnidentifiedCalloutTitleError(error: unknown): boolean {
  return error instanceof Error && /^Cannot identify remote Callout type from title /.test(error.message);
}

async function repairNestedHierarchyFromBlocks(input: {
  adapter: FeishuAdapter;
  target: PublishReceiptTarget;
  markdown: string;
  callouts: CalloutConfig;
}): Promise<{
  markdown: string;
  warnings: string[];
  calloutTypeHints?: ReturnType<typeof calloutTypeHints>;
}> {
  if (!input.adapter.fetchDocBlocks) return { markdown: input.markdown, warnings: [] };
  const documentId = input.target.kind === 'docx'
    ? input.target.token
    : input.adapter.resolveDocumentId
      ? await input.adapter.resolveDocumentId({ target: input.target })
      : undefined;
  if (!documentId) return { markdown: input.markdown, warnings: [] };
  const blocks = await input.adapter.fetchDocBlocks({ doc: documentId });
  const typeHints = calloutTypeHints(remoteSemanticDocument(blocks.blocks, documentId, input.callouts));
  const page = findPageBlock(blocks.blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks.blocks, page);
  let markdown = input.markdown;
  let repaired = false;
  for (let index = 0; index < direct.length;) {
    if (!isListBlock(direct[index])) {
      index += 1;
      continue;
    }
    const group: FeishuBlock[] = [];
    while (index < direct.length && isListBlock(direct[index])) {
      group.push(direct[index]!);
      index += 1;
    }
    if (!group.some(hasBlockChildren)) continue;
    const desired = feishuBlocksToMarkdown(group, input.callouts).trim();
    const lossyBlocks = group.map(observedLossyListSerialization);
    if (lossyBlocks.some((block) => !block)) {
      throw new Error('pull nested list hierarchy reconstruction failed: unsupported child block shape');
    }
    const typedLossyBlocks = lossyBlocks as FeishuBlock[];
    const lossyCandidates = [...new Set([
      feishuBlocksToMarkdown(typedLossyBlocks, input.callouts).trim(),
      renderCompactListSerialization(typedLossyBlocks, input.callouts)
    ])];
    const desiredMatches = exactOccurrenceCount(markdown, desired);
    const matchingLossy = lossyCandidates.filter((candidate) => exactOccurrenceCount(markdown, candidate) === 1);
    const totalLossyMatches = lossyCandidates.reduce((total, candidate) => {
      return total + exactOccurrenceCount(markdown, candidate);
    }, 0);
    if (desiredMatches === 1 && totalLossyMatches === 0) continue;
    if (matchingLossy.length === 1 && totalLossyMatches === 1 && desiredMatches === 0) {
      markdown = markdown.replace(matchingLossy[0]!, desired);
      repaired = true;
      continue;
    }
    throw new Error(
      `pull nested list hierarchy reconstruction failed: native block sequence cannot be uniquely matched ` +
      `(desired=${desiredMatches}, lossy=${totalLossyMatches})`
    );
  }
  return {
    markdown,
    warnings: repaired ? ['reconstructed nested list hierarchy from Docx block API'] : [],
    calloutTypeHints: typeHints
  };
}

function renderCompactListSerialization(blocks: FeishuBlock[], callouts: CalloutConfig, depth = 0): string {
  return blocks.map((block) => {
    const { children: _children, ...shell } = block;
    const head = `${'  '.repeat(depth)}${feishuBlocksToMarkdown([shell], callouts).trim()}`;
    const nested = childBlocks(block).filter(isListBlock);
    return nested.length > 0
      ? `${head}\n\n${renderCompactListSerialization(nested, callouts, depth + 1)}`
      : head;
  }).join('\n');
}

function observedLossyListSerialization(block: FeishuBlock): FeishuBlock | undefined {
  if (!isListBlock(block)) return block;
  const key = block.block_type === 12 ? 'bullet' : 'ordered';
  const container = asTextContainer(block[key]);
  if (!container) return undefined;
  const elements = [...container.elements];
  const preservedChildren: FeishuBlock[] = [];
  for (const child of childBlocks(block)) {
    if (child.block_type === 2) {
      const paragraph = asTextContainer(child.text);
      if (!paragraph) return undefined;
      elements.push(...paragraph.elements);
      continue;
    }
    if (isListBlock(child)) {
      const nested = observedLossyListSerialization(child);
      if (!nested) return undefined;
      preservedChildren.push(nested);
      continue;
    }
    return undefined;
  }
  return {
    ...block,
    [key]: { ...container.record, elements },
    ...(preservedChildren.length > 0 ? { children: preservedChildren } : { children: undefined })
  };
}

function exactOccurrenceCount(source: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= source.length - value.length) {
    const index = source.indexOf(value, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + value.length;
  }
  return count;
}

function isListBlock(block: FeishuBlock | undefined): block is FeishuBlock {
  return block?.block_type === 12 || block?.block_type === 13;
}

function hasBlockChildren(block: FeishuBlock): boolean {
  return childBlocks(block).length > 0;
}

function childBlocks(block: FeishuBlock): FeishuBlock[] {
  return Array.isArray(block.children)
    ? block.children.filter((child): child is FeishuBlock => {
      return Boolean(child && typeof child === 'object' && !Array.isArray(child) && 'block_type' in child);
    })
    : [];
}

function asTextContainer(value: unknown): { record: Record<string, unknown>; elements: TextElement[] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.elements)) return undefined;
  return { record, elements: record.elements.filter(isTextElement) };
}

function isTextElement(value: unknown): value is TextElement {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function assertPullOutputWritable(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    await readFile(outputPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!overwrite) {
    throw new Error(
      `Refusing to overwrite existing output without --overwrite: ${outputPath}\n` +
      'Pull writes remote snapshots only; choose a new *.remote.md output or rerun with --overwrite after review.'
    );
  }
}
