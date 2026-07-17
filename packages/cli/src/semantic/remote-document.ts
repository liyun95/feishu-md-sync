import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { codeLanguageForId, resolveCodeLanguage } from '../code-blocks/code-language.js';
import type { RemoteCodeMetadata } from '../adapters/feishu-adapter.js';
import {
  calloutTypeForEmojiId,
  calloutTypeForTitle
} from '../callouts/callout-presentation.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import { feishuBlocksToMarkdown } from '../markdown/from-blocks.js';
import { findPageBlock, renderableDirectChildBlocks } from '../publish/block-state.js';
import { semanticHash } from './normalize.js';
import { semanticTableFromFeishuBlock } from './feishu-table.js';
import type {
  SemanticCallout,
  SemanticCodeBlock,
  SemanticDocument,
  SemanticLocator,
  SemanticNode,
  SemanticProtectedResource
} from './types.js';
import { semanticTextChildren } from './text-tree.js';

const TEXT_KEY_BY_TYPE: Record<number, string> = {
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

export function remoteSemanticDocument(
  blocks: FeishuBlock[],
  documentId: string,
  callouts: CalloutConfig = DEFAULT_CALLOUT_CONFIG,
  codeMetadata: RemoteCodeMetadata[] = []
): SemanticDocument {
  const page = findPageBlock(blocks, documentId);
  const direct = renderableDirectChildBlocks(blocks, page);
  const nodes: SemanticNode[] = [];
  const headingPath: string[] = [];
  const ordinals = new Map<string, number>();
  const codeMetadataById = new Map(codeMetadata.map((metadata) => [metadata.blockId, metadata]));

  for (const block of direct) {
    if (block.block_type === 14) {
      nodes.push(remoteCodeBlock(
        block,
        nextLocator(headingPath, 'code', ordinals),
        block.block_id ? codeMetadataById.get(block.block_id) : undefined
      ));
      continue;
    }
    if (isSupportedTextBlock(block)) {
      const markdown = feishuBlocksToMarkdown([block]).trim();
      if (!markdown) continue;
      if (markdown === '<Procedures>' || markdown === '</Procedures>') {
        nodes.push({
          kind: 'authoring-token',
          locator: nextLocator(headingPath, 'authoring-token', ordinals),
          component: 'Procedures',
          token: markdown === '<Procedures>' ? 'open' : 'close',
          markdown,
          remoteBlockId: block.block_id
        });
        continue;
      }
      if (block.block_type >= 3 && block.block_type <= 8) {
        const level = block.block_type - 2;
        const title = markdown.replace(/^#{1,6}\s+/, '').trim();
        headingPath.length = level - 1;
        headingPath[level - 1] = title;
      }
      const children = semanticTextChildren(block, callouts);
      nodes.push({
        kind: 'text',
        locator: nextLocator(headingPath, 'text', ordinals),
        blockType: block.block_type,
        markdown,
        remoteBlockId: block.block_id,
        ...(children ? { children } : {})
      });
      continue;
    }

    if (block.block_type === 31) {
      nodes.push(semanticTableFromFeishuBlock(block, nextLocator(headingPath, 'table', ordinals)));
      continue;
    }

    if (block.block_type === 19) {
      nodes.push(remoteCallout(block, nextLocator(headingPath, 'callout', ordinals), callouts));
      continue;
    }

    if (block.block_type === 27 || block.block_type === 43) {
      nodes.push(remoteAsset(block, nextLocator(headingPath, 'asset', ordinals)));
      continue;
    }

    const protectedResource = remoteSupademo(block);
    if (protectedResource) {
      nodes.push({
        ...protectedResource,
        locator: nextLocator(headingPath, 'protected-resource', ordinals)
      });
      continue;
    }

    nodes.push({
      kind: 'opaque',
      locator: nextLocator(headingPath, 'opaque', ordinals),
      description: `unsupported remote block_type ${block.block_type}`,
      fingerprint: semanticHash(normalizeRemoteBlock(block)),
      remoteBlockId: block.block_id
    });
  }

  return { nodes };
}

function remoteCodeBlock(
  block: FeishuBlock,
  locator: SemanticLocator,
  metadata: RemoteCodeMetadata | undefined
): SemanticCodeBlock {
  const code = asRecord(block.code);
  const style = asRecord(code?.style);
  const elements = Array.isArray(code?.elements) ? code.elements.filter(isTextElement) : [];
  const content = elements.map((element) => element.text_run?.content ?? '').join('');
  const issues: SemanticCodeBlock['issues'] = [];
  let resolvedLanguage = 'plaintext';
  let sourceLanguage = metadata?.language ?? '';
  try {
    if (metadata?.language) {
      resolvedLanguage = resolveCodeLanguage(metadata.language).resolvedLanguage;
    } else {
      resolvedLanguage = codeLanguageForId(numberValue(style?.language) || 1);
      sourceLanguage = resolvedLanguage;
    }
  } catch (error) {
    issues.push({
      code: 'unsupported-code-language',
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const caption = metadata?.caption ?? (typeof style?.caption === 'string'
    ? style.caption
    : typeof code?.caption === 'string'
      ? code.caption
      : undefined);
  return {
    kind: 'code',
    locator,
    content,
    sourceLanguage,
    resolvedLanguage,
    caption,
    remoteBlockId: block.block_id,
    issues
  };
}

function remoteCallout(
  block: FeishuBlock,
  locator: SemanticLocator,
  config: CalloutConfig
): SemanticCallout {
  const unsupported: string[] = [];
  const children = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const titleBlock = children[0];
  const titleMarkdown = titleBlock ? feishuBlocksToMarkdown([titleBlock], config).trim() : '';
  const shell = asRecord(block.callout);
  const emojiId = typeof shell?.emoji_id === 'string' ? shell.emoji_id : undefined;
  const calloutType = calloutTypeForTitle(titleMarkdown, config) ?? calloutTypeForEmojiId(emojiId);
  if (!calloutType) addUnsupported(unsupported, 'remote Callout title is unrecognized');
  if (!titleBlock || titleBlock.block_type !== 2) {
    addUnsupported(unsupported, 'remote Callout presentation title must be a text block');
  }

  const body = children.slice(1).map((child, ordinal) => {
    if (!isSupportedCalloutBlock(child.block_type)) {
      addUnsupported(unsupported, `block_type ${child.block_type} in Callout is unsupported`);
    }
    if ((child.block_type === 12 || child.block_type === 13) && Array.isArray(child.children) && child.children.length > 0) {
      addUnsupported(unsupported, 'nested lists are unsupported');
    }
    if (hasNonTextInline(child)) addUnsupported(unsupported, 'non-text inline element in Callout is unsupported');
    const markdown = feishuBlocksToMarkdown([child], config).trim();
    for (const link of markdown.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
      if (!/^https?:\/\//i.test((link[1] ?? '').trim())) {
        addUnsupported(unsupported, 'relative links are unsupported');
      }
    }
    return {
      ordinal,
      blockType: child.block_type,
      markdown,
      remoteBlockId: child.block_id
    };
  });

  return {
    kind: 'callout',
    locator,
    calloutType,
    title: titleBlock ? { markdown: titleMarkdown, remoteBlockId: titleBlock.block_id } : undefined,
    children: body,
    remoteBlockId: block.block_id,
    shell: {
      emojiId,
      backgroundColor: optionalNumber(shell?.background_color),
      borderColor: optionalNumber(shell?.border_color),
      textColor: optionalNumber(shell?.text_color)
    },
    unsupported
  };
}

function remoteAsset(block: FeishuBlock, locator: SemanticLocator): SemanticNode {
  const representation = block.block_type === 43 ? 'whiteboard' : 'image';
  const value = asRecord(block[representation]) ?? (representation === 'whiteboard' ? asRecord(block.board) : undefined);
  const token = typeof value?.token === 'string' ? value.token : undefined;
  return {
    kind: 'asset',
    locator,
    representation,
    remoteBlockId: block.block_id,
    remoteToken: token,
    ...(token ? {} : { unsupported: [`remote ${representation} token missing`] })
  };
}

const SUPADEMO_COMPONENT_TYPE_ID = 'blk_682093ba9580c002363b9dc3';

function remoteSupademo(
  block: FeishuBlock
): Omit<SemanticProtectedResource, 'locator'> | undefined {
  if (block.block_type !== 40) return undefined;
  const addOns = asRecord(block.add_ons);
  if (addOns?.component_type_id !== SUPADEMO_COMPONENT_TYPE_ID) return undefined;
  if (typeof addOns.record !== 'string') return undefined;
  let record: Record<string, unknown> | undefined;
  try {
    record = asRecord(JSON.parse(addOns.record));
  } catch {
    return undefined;
  }
  if (typeof record?.id !== 'string' || !record.id) return undefined;
  return {
    kind: 'protected-resource',
    resourceKind: 'supademo',
    componentId: record.id,
    remoteBlockId: block.block_id,
    remoteShape: `add-ons:${SUPADEMO_COMPONENT_TYPE_ID}`
  };
}

function isSupportedTextBlock(block: FeishuBlock): boolean {
  return block.block_type === 2 ||
    (block.block_type >= 3 && block.block_type <= 8) ||
    block.block_type === 12 ||
    block.block_type === 13;
}

function isSupportedCalloutBlock(blockType: number): boolean {
  return blockType === 2 ||
    (blockType >= 3 && blockType <= 8) ||
    blockType === 12 ||
    blockType === 13;
}

function hasNonTextInline(block: FeishuBlock): boolean {
  const key = TEXT_KEY_BY_TYPE[block.block_type];
  const value = key ? asRecord(block[key]) : undefined;
  const elements = Array.isArray(value?.elements) ? value.elements : [];
  return elements.some((element) => {
    return Boolean(element && typeof element === 'object' && !Array.isArray(element) && !('text_run' in element));
  });
}

function nextLocator(
  sectionPath: string[],
  kind: SemanticLocator['kind'],
  ordinals: Map<string, number>
): SemanticLocator {
  const stablePath = sectionPath.filter((part): part is string => typeof part === 'string');
  const key = `${kind}:${JSON.stringify(stablePath)}`;
  const ordinal = ordinals.get(key) ?? 0;
  ordinals.set(key, ordinal + 1);
  return { sectionPath: stablePath, kind, ordinal };
}

function normalizeRemoteBlock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRemoteBlock);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === 'block_id' || key === 'parent_id' || key === 'merge_info') return [];
    return [[key, normalizeRemoteBlock(child)]];
  }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}

function isTextElement(value: unknown): value is TextElement {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function addUnsupported(unsupported: string[], message: string): void {
  if (!unsupported.includes(message)) unsupported.push(message);
}
