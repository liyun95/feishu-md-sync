import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { hashBlocks, hashSource } from '../core/hash.js';
import type { FeishuBlock, FeishuDocClient, WriteResult } from '../feishu/types.js';
import { writeReceipt, type SyncReceipt, type SyncReceiptRunContext } from '../receipts/receipt.js';
import { buildMarkdownPreflightReport, type MarkdownPreflightReport } from '../services/markdown/preflight.js';
import { comparableDirectChildBlocks, findPageBlock } from './block-state.js';
import type { PatchPlan } from './patch.js';

export type ImageDimensions = {
  width: number;
  height: number;
};

export type DocxV2OverwriteOptions = {
  sourcePath: string;
  documentId: string;
  rootDir: string;
  statePath: string;
  receiptSourcePath: string;
  sourceMarkdown: string;
  sourceHash: string;
  currentChildren: FeishuBlock[];
  currentHash: string;
  dryRun: boolean;
  warnings: string[];
  receiptWritten: boolean;
  runContext?: SyncReceiptRunContext;
  imageRootDir?: string;
  imageDimensions?: Record<string, ImageDimensions>;
};

export type DocxV2Verification = {
  tablesExpected: number;
  tablesReadback: number;
  mediaExpected: number;
  mediaReadback: number;
};

export type DocxV2OverwriteResult = {
  mode: 'dry-run' | 'write';
  receiptPath: string;
  patchPlan: PatchPlan;
  receipt: SyncReceipt;
  warnings: string[];
  receiptWritten: boolean;
  preflight: MarkdownPreflightReport;
  docxV2: {
    images: PreparedMarkdownImage[];
    verification: DocxV2Verification;
  };
};

type PreparedMarkdownImage = {
  alt: string;
  src: string;
  filePath: string;
  dimensions: ImageDimensions;
  insertAfter: TextSelection;
};

type TextSelection = {
  text: string;
  prefix: string;
  suffix: string;
};

type PreparedMarkdown = {
  markdown: string;
  images: PreparedMarkdownImage[];
};

export async function runDocxV2Overwrite(
  client: FeishuDocClient,
  options: DocxV2OverwriteOptions
): Promise<DocxV2OverwriteResult> {
  assertDocxV2Client(client);

  const prepared = await prepareDocxV2Markdown({
    markdown: options.sourceMarkdown,
    sourcePath: options.sourcePath,
    rootDir: options.rootDir,
    imageRootDir: options.imageRootDir,
    imageDimensions: options.imageDimensions
  });
  const preflight = buildMarkdownPreflightReport(prepared.markdown);
  const desiredHash = hashSource([
    prepared.markdown,
    ...prepared.images.map((image) => `${image.src}:${image.filePath}:${image.dimensions.width}x${image.dimensions.height}`)
  ].join('\n'));
  const estimatedCreateCount = estimateMarkdownTopLevelBlocks(prepared.markdown) + prepared.images.length;
  const patchPlan: PatchPlan = {
    operation: options.currentChildren.length === 0 && estimatedCreateCount === 0 ? 'noop' : 'replace-document',
    deleteCount: options.currentChildren.length,
    createCount: estimatedCreateCount,
    currentHash: options.currentHash,
    desiredHash
  };

  let writeResult: WriteResult = {
    deleted: 0,
    created: 0,
    skipped: patchPlan.operation === 'noop'
  };
  let afterChildren = options.currentChildren;
  let verification: DocxV2Verification = {
    tablesExpected: countMarkdownTables(prepared.markdown),
    tablesReadback: countBlocks(options.currentChildren, 31),
    mediaExpected: prepared.images.length,
    mediaReadback: countBlocks(options.currentChildren, 27)
  };

  if (!options.dryRun) {
    await client.overwriteDocumentMarkdown(options.documentId, prepared.markdown);
    let readbackBlocks = await client.getDocumentBlocks(options.documentId);
    let pageBlock = findPageBlock(readbackBlocks, options.documentId);
    afterChildren = comparableDirectChildBlocks(readbackBlocks, pageBlock);

    const mediaTokens: string[] = [];
    for (const image of prepared.images) {
      const index = insertionIndexForSelection(afterChildren, image.insertAfter);
      const created = await client.createChildren(options.documentId, pageBlock.block_id, [{ block_type: 27, image: {} }], { index });
      const imageBlockId = created[0]?.block_id;
      if (!imageBlockId) {
        throw new Error(`Feishu did not return a block id for inserted image ${image.src}.`);
      }
      const media = await client.uploadMediaFile({
        filePath: image.filePath,
        parentNode: imageBlockId,
        parentType: 'docx_image'
      });
      mediaTokens.push(media.token);
      await client.batchUpdateBlocks?.(options.documentId, [{
        block_id: imageBlockId,
        replace_image: {
          token: media.token,
          width: image.dimensions.width,
          height: image.dimensions.height
        }
      }]);

      readbackBlocks = await client.getDocumentBlocks(options.documentId);
      pageBlock = findPageBlock(readbackBlocks, options.documentId);
      afterChildren = comparableDirectChildBlocks(readbackBlocks, pageBlock);
    }

    verification = verifyDocxV2Readback({
      markdown: prepared.markdown,
      images: prepared.images,
      mediaTokens,
      blocks: afterChildren
    });
    writeResult = {
      deleted: options.currentChildren.length,
      created: afterChildren.length,
      skipped: false
    };
    options.warnings.push('Push used docs v2 Markdown overwrite with explicit media upload/bind.');
  }

  const afterHash = hashBlocks(afterChildren);
  const receipt: SyncReceipt = {
    sourcePath: options.receiptSourcePath,
    sourceHash: options.sourceHash,
    sourceSnapshot: options.sourceMarkdown,
    feishuDocId: options.documentId,
    feishuStateHash: options.dryRun ? options.currentHash : afterHash,
    feishuMarkdownSnapshot: prepared.markdown,
    timestamp: new Date().toISOString(),
    blockCounts: {
      source: estimatedCreateCount,
      feishuBefore: options.currentChildren.length,
      feishuAfter: options.dryRun ? estimatedCreateCount : afterChildren.length
    },
    warnings: options.warnings,
    writeResult: {
      mode: options.dryRun ? 'dry-run' : 'write',
      ...writeResult
    },
    verificationResult: {
      ok: true,
      expectedHash: options.dryRun ? desiredHash : afterHash,
      actualHash: options.dryRun ? options.currentHash : afterHash
    },
    ...(options.runContext ? { runContext: options.runContext } : {})
  };

  if (!options.dryRun && options.receiptWritten) {
    await writeReceipt(options.statePath, receipt);
  }

  return {
    mode: options.dryRun ? 'dry-run' : 'write',
    receiptPath: options.statePath,
    patchPlan,
    receipt,
    warnings: options.warnings,
    receiptWritten: !options.dryRun && options.receiptWritten,
    preflight,
    docxV2: {
      images: prepared.images,
      verification
    }
  };
}

async function prepareDocxV2Markdown(input: {
  markdown: string;
  sourcePath: string;
  rootDir: string;
  imageRootDir?: string;
  imageDimensions?: Record<string, ImageDimensions>;
}): Promise<PreparedMarkdown> {
  const withoutFrontmatter = stripYamlFrontmatter(input.markdown).replace(/\r\n/g, '\n');
  const lines = withoutFrontmatter.split('\n');
  const output: string[] = [];
  const images: PreparedMarkdownImage[] = [];

  for (const line of lines) {
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (!image) {
      output.push(line);
      continue;
    }

    const src = image[2].trim();
    const filePath = await resolveMarkdownImagePath({
      src,
      sourcePath: input.sourcePath,
      rootDir: input.rootDir,
      imageRootDir: input.imageRootDir
    });
    images.push({
      alt: image[1],
      src,
      filePath,
      dimensions: await dimensionsForImage(filePath, src, input.imageDimensions),
      insertAfter: selectionForPreviousParagraph(output)
    });
  }

  return {
    markdown: output.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '') + '\n',
    images
  };
}

function stripYamlFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return markdown;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return markdown;
  const bodyStart = normalized[end + '\n---'.length] === '\n' ? end + '\n---\n'.length : end + '\n---'.length;
  return normalized.slice(bodyStart).replace(/^\n+/, '');
}

async function resolveMarkdownImagePath(input: {
  src: string;
  sourcePath: string;
  rootDir: string;
  imageRootDir?: string;
}): Promise<string> {
  const cleanSrc = input.src.split(/[?#]/, 1)[0] ?? input.src;
  const candidates: string[] = [];

  if (path.isAbsolute(cleanSrc) && await exists(cleanSrc)) {
    return cleanSrc;
  }

  if (cleanSrc.startsWith('/')) {
    if (input.imageRootDir) candidates.push(path.join(input.imageRootDir, cleanSrc.slice(1)));
    candidates.push(path.join(input.rootDir, cleanSrc.slice(1)));
    candidates.push(...ancestorStaticCandidates(path.dirname(input.sourcePath), cleanSrc.slice(1)));
  } else {
    candidates.push(path.resolve(path.dirname(input.sourcePath), cleanSrc));
    if (input.imageRootDir) candidates.push(path.join(input.imageRootDir, cleanSrc));
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error(`Could not resolve local image ${input.src} referenced by ${input.sourcePath}.`);
}

function ancestorStaticCandidates(startDir: string, relativeSrc: string): string[] {
  const candidates: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    candidates.push(path.join(current, 'static', relativeSrc));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dimensionsForImage(
  filePath: string,
  src: string,
  overrides: Record<string, ImageDimensions> | undefined
): Promise<ImageDimensions> {
  const override = overrides?.[src] ?? overrides?.[filePath] ?? overrides?.[path.basename(filePath)];
  if (override) return override;
  if (filePath.toLowerCase().endsWith('.svg')) {
    return svgDimensions(await readFile(filePath, 'utf8'), src);
  }
  throw new Error(`Image ${src} requires explicit width and height for docs v2 media insertion.`);
}

function svgDimensions(svg: string, src: string): ImageDimensions {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  const width = numericSvgAttribute(openTag, 'width');
  const height = numericSvgAttribute(openTag, 'height');
  if (width && height) return { width, height };

  const viewBox = openTag.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (viewBox) {
    return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }

  throw new Error(`SVG image ${src} has no width/height or viewBox; pass explicit image dimensions.`);
}

function numericSvgAttribute(tag: string, name: string): number | undefined {
  const match = tag.match(new RegExp(`\\b${name}=["']([\\d.]+)(?:px)?["']`, 'i'));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function selectionForPreviousParagraph(lines: string[]): TextSelection {
  const paragraph: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && paragraph.length > 0) break;
    paragraph.unshift(line);
  }
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new Error('Cannot insert image because no preceding paragraph was found for selection.');
  }
  return {
    text,
    prefix: text.slice(0, 80),
    suffix: text.slice(Math.max(0, text.length - 80))
  };
}

function insertionIndexForSelection(children: FeishuBlock[], selection: TextSelection): number {
  const index = children.findIndex((block) => {
    const text = blockText(block);
    return text === selection.text || (text.includes(selection.prefix) && text.includes(selection.suffix));
  });
  if (index === -1) {
    throw new Error(`Could not find Feishu block matching image insertion selection: ${selection.prefix}...${selection.suffix}`);
  }
  return index + 1;
}

function verifyDocxV2Readback(input: {
  markdown: string;
  images: PreparedMarkdownImage[];
  mediaTokens: string[];
  blocks: FeishuBlock[];
}): DocxV2Verification {
  const verification = {
    tablesExpected: countMarkdownTables(input.markdown),
    tablesReadback: countBlocks(input.blocks, 31),
    mediaExpected: input.images.length,
    mediaReadback: input.mediaTokens.filter((token) => input.blocks.some((block) => imageToken(block) === token)).length
  };

  if (verification.tablesReadback < verification.tablesExpected) {
    throw new Error(`Docs v2 readback verification failed: expected ${verification.tablesExpected} table block(s), found ${verification.tablesReadback}.`);
  }
  if (verification.mediaReadback < verification.mediaExpected) {
    throw new Error(`Docs v2 readback verification failed: expected ${verification.mediaExpected} media block(s), found ${verification.mediaReadback}.`);
  }
  return verification;
}

function estimateMarkdownTopLevelBlocks(markdown: string): number {
  return markdown.split(/\n{2,}/).filter((chunk) => chunk.trim() !== '').length;
}

function countMarkdownTables(markdown: string): number {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let count = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      /^\s*\|.*\|\s*$/.test(lines[index] ?? '') &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? '')
    ) {
      count += 1;
    }
  }
  return count;
}

function countBlocks(blocks: FeishuBlock[], blockType: number): number {
  return blocks.filter((block) => block.block_type === blockType).length;
}

function blockText(block: FeishuBlock): string {
  const textContainer = block.text ?? block.heading1 ?? block.heading2 ?? block.heading3 ?? block.heading4 ?? block.heading5 ?? block.heading6;
  if (!textContainer || typeof textContainer !== 'object' || Array.isArray(textContainer)) return '';
  const elements = (textContainer as { elements?: Array<{ text_run?: { content?: string } }> }).elements ?? [];
  return elements.map((element) => element.text_run?.content ?? '').join('').replace(/\s+/g, ' ').trim();
}

function imageToken(block: FeishuBlock): string | undefined {
  if (!block.image || typeof block.image !== 'object' || Array.isArray(block.image)) return undefined;
  const image = block.image as { token?: string; file_token?: string };
  return image.token ?? image.file_token;
}

function assertDocxV2Client(client: FeishuDocClient): asserts client is FeishuDocClient & {
  overwriteDocumentMarkdown(documentId: string, markdown: string): Promise<void>;
  uploadMediaFile(input: { filePath: string; parentNode: string; parentType: string }): Promise<{ token: string; contentType?: string }>;
} {
  if (!client.overwriteDocumentMarkdown) {
    throw new Error('docs v2 overwrite backend requires a Feishu client with overwriteDocumentMarkdown support.');
  }
  if (!client.uploadMediaFile) {
    throw new Error('docs v2 overwrite backend requires a Feishu client with uploadMediaFile support.');
  }
  if (!client.batchUpdateBlocks) {
    throw new Error('docs v2 overwrite backend requires a Feishu client with batchUpdateBlocks support.');
  }
}
