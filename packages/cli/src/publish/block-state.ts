import type { FeishuBlock } from '../feishu/types.js';

export type PageBlock = FeishuBlock & { block_id: string };

export function findPageBlock(blocks: FeishuBlock[], documentId: string): PageBlock {
  const page = blocks.find((block) => block.block_type === 1) ?? blocks.find((block) => block.block_id === documentId);
  if (!page?.block_id) {
    throw new Error(`Could not find page block for document ${documentId}.`);
  }
  return page as PageBlock;
}

export function directChildBlocks(blocks: FeishuBlock[], pageBlock: FeishuBlock): FeishuBlock[] {
  const byId = blockMapById(blocks);
  const children = Array.isArray(pageBlock.children) ? pageBlock.children : [];

  return children
    .map((child) => (typeof child === 'string' ? byId.get(child) : child))
    .filter((child): child is FeishuBlock => Boolean(child));
}

export function comparableDirectChildBlocks(blocks: FeishuBlock[], pageBlock: FeishuBlock): FeishuBlock[] {
  const byId = blockMapById(blocks);

  return directChildBlocks(blocks, pageBlock).map((block) => comparableBlock(block, byId));
}

export function renderableDirectChildBlocks(blocks: FeishuBlock[], pageBlock: FeishuBlock): FeishuBlock[] {
  const byId = blockMapById(blocks);
  return directChildBlocks(blocks, pageBlock).flatMap((block) => renderableBlocks(block, byId));
}

export function resolvedChildBlocks(blocks: FeishuBlock[], parentBlockId: string): FeishuBlock[] {
  const parent = blocks.find((block) => block.block_id === parentBlockId);
  if (!parent) return [];
  const byId = blockMapById(blocks);
  return directChildBlocks(blocks, parent).map((block) => comparableBlock(block, byId));
}

export function resolvedBlockById(blocks: FeishuBlock[], blockId: string): FeishuBlock | undefined {
  const block = blocks.find((candidate) => candidate.block_id === blockId);
  return block ? comparableBlock(block, blockMapById(blocks)) : undefined;
}

function blockMapById(blocks: FeishuBlock[]): Map<string, FeishuBlock> {
  return new Map(blocks.flatMap((block) => block.block_id ? [[block.block_id, block] as const] : []));
}

function renderableBlocks(block: FeishuBlock, byId: Map<string, FeishuBlock>): FeishuBlock[] {
  if (block.block_type === 19 && Array.isArray(block.children)) {
    return [resolveChildContainer(block, byId)];
  }

  if (block.block_type !== 49 || !Array.isArray(block.children)) {
    return [comparableBlock(block, byId)];
  }

  return block.children.flatMap((childRef) => {
    const child = typeof childRef === 'string' ? byId.get(childRef) : asBlock(childRef);
    return child ? renderableBlocks(child, byId) : [];
  });
}

function resolveChildContainer(block: FeishuBlock, byId: Map<string, FeishuBlock>): FeishuBlock {
  const children = Array.isArray(block.children)
    ? block.children
      .map((childRef) => (typeof childRef === 'string' ? byId.get(childRef) : asBlock(childRef)))
      .filter((child): child is FeishuBlock => Boolean(child))
      .map((child) => comparableBlock(child, byId))
    : [];

  return {
    ...block,
    children
  };
}

function comparableBlock(block: FeishuBlock, byId: Map<string, FeishuBlock>): FeishuBlock {
  if (block.block_type !== 31 || !isTableBlock(block)) {
    return Array.isArray(block.children) ? resolveChildContainer(block, byId) : block;
  }

  const cellRefs = block.table.cells ?? [];
  const resolvedCells = cellRefs.map((cellRef) => {
    const cellBlock = typeof cellRef === 'string' ? byId.get(cellRef) : asBlock(cellRef);
    const children = Array.isArray(cellBlock?.children)
      ? cellBlock.children
        .map((childRef) => (typeof childRef === 'string' ? byId.get(childRef) : asBlock(childRef)))
        .filter((child): child is FeishuBlock => Boolean(child))
        .map((child) => comparableBlock(child, byId))
      : [];
    return {
      ...(cellBlock ?? { block_type: 32 }),
      children: children.length > 0
        ? children
        : [{ block_type: 2, text: { elements: [], style: { align: 1 } } }]
    };
  });

  return {
    ...block,
    table: {
      ...block.table,
      cells: resolvedCells
    }
  };
}

function isTableBlock(block: FeishuBlock): block is FeishuBlock & { table: { cells?: unknown[] } } {
  return Boolean(
    block.table &&
    typeof block.table === 'object' &&
    !Array.isArray(block.table)
  );
}

function asBlock(value: unknown): FeishuBlock | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value) {
    return value as FeishuBlock;
  }
  return undefined;
}
