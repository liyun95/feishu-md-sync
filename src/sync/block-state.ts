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
  const byId = new Map(blocks.filter((block) => block.block_id).map((block) => [block.block_id, block]));
  const children = Array.isArray(pageBlock.children) ? pageBlock.children : [];

  return children
    .map((child) => (typeof child === 'string' ? byId.get(child) : child))
    .filter((child): child is FeishuBlock => Boolean(child));
}

export function comparableDirectChildBlocks(blocks: FeishuBlock[], pageBlock: FeishuBlock): FeishuBlock[] {
  const byId = new Map(blocks.filter((block) => block.block_id).map((block) => [block.block_id, block]));

  return directChildBlocks(blocks, pageBlock).map((block) => {
    if (block.block_type !== 31 || !isTableBlock(block)) {
      return block;
    }

    const cellRefs = block.table.cells ?? [];
    const resolvedCells = cellRefs.map((cellRef) => {
      const cellBlock = typeof cellRef === 'string' ? byId.get(cellRef) : asBlock(cellRef);
      const firstChildRef = Array.isArray(cellBlock?.children) ? cellBlock.children[0] : undefined;
      const firstChild = typeof firstChildRef === 'string' ? byId.get(firstChildRef) : asBlock(firstChildRef);
      return firstChild ?? { block_type: 2, text: { elements: [], style: { align: 1 } } };
    });

    return {
      ...block,
      table: {
        ...block.table,
        cells: resolvedCells
      }
    };
  });
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
