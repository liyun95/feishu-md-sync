import type { FeishuBlock, FeishuDocClient } from './types.js';
import { FeishuTokenProvider } from './token.js';

type FeishuResponse<T> = {
  code: number;
  msg?: string;
  data?: T;
};

type ClientConfig = {
  host?: string;
  tokenProvider?: FeishuTokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number
  ) {
    super(message);
    this.name = 'FeishuApiError';
  }
}

export class FeishuClient implements FeishuDocClient {
  private readonly host: string;
  private readonly tokenProvider: FeishuTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ClientConfig = {}) {
    this.host = config.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn';
    this.tokenProvider = config.tokenProvider ?? new FeishuTokenProvider({ host: this.host });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  async getDocumentBlocks(documentId: string): Promise<FeishuBlock[]> {
    const blocks: FeishuBlock[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        page_size: '500',
        document_revision_id: '-1'
      });
      if (pageToken) params.set('page_token', pageToken);

      const data = await this.request<{ items?: FeishuBlock[]; has_more?: boolean; page_token?: string }>(
        'GET',
        `/open-apis/docx/v1/documents/${documentId}/blocks?${params.toString()}`
      );
      blocks.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);

    return blocks;
  }

  async resolveWikiNode(wikiNodeToken: string): Promise<string> {
    const params = new URLSearchParams({ token: wikiNodeToken });
    const data = await this.request<{ node?: { obj_token?: string; obj_type?: string } }>(
      'GET',
      `/open-apis/wiki/v2/spaces/get_node?${params.toString()}`
    );

    if (!data.node?.obj_token) {
      throw new FeishuApiError(`Could not resolve wiki node ${wikiNodeToken} to a docx object token.`);
    }

    if (data.node.obj_type && data.node.obj_type !== 'docx') {
      throw new FeishuApiError(`Wiki node ${wikiNodeToken} is ${data.node.obj_type}, not docx.`);
    }

    return data.node.obj_token;
  }

  async deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void> {
    await this.request(
      'DELETE',
      `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete`,
      { start_index: startIndex, end_index: endIndex }
    );
  }

  async createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[]): Promise<FeishuBlock[]> {
    const created: FeishuBlock[] = [];
    const batchSize = 50;
    const segments = segmentBlocksForCreate(blocks, batchSize);

    for (const segment of segments) {
      const batch = segment.blocks.map(toCreateBlock);
      const data = await this.request<{ children?: FeishuBlock[] }>(
        'POST',
        `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`,
        { children: batch }
      );
      const createdBatch = data.children ?? [];
      created.push(...createdBatch);

      for (let index = 0; index < createdBatch.length; index += 1) {
        const sourceBlock = segment.blocks[index];
        const createdBlock = createdBatch[index];
        if (sourceBlock && createdBlock) {
          await this.populateTableCells(documentId, sourceBlock, createdBlock);
        }
      }
    }

    return created;
  }

  private async populateTableCells(documentId: string, sourceBlock: FeishuBlock, createdBlock: FeishuBlock): Promise<void> {
    if (!isTableBlock(sourceBlock) || !isTableBlock(createdBlock)) return;

    const sourceCells = sourceBlock.table.cells ?? [];
    const createdCells = createdBlock.table.cells ?? [];
    const totalCells = Math.min(sourceCells.length, createdCells.length);

    for (let index = 0; index < totalCells; index += 1) {
      const cellId = createdCells[index];
      const cellContent = sourceCells[index];
      if (typeof cellId !== 'string' || !isBlockLike(cellContent)) continue;

      await this.request(
        'POST',
        `/open-apis/docx/v1/documents/${documentId}/blocks/${cellId}/children`,
        { children: [toCreateBlock(cellContent)], index: 0 }
      );
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenProvider.token();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.host}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      const payload = await parseJson(response);
      if (!response.ok || payload.code !== 0) {
        throw new FeishuApiError(
          `Feishu API ${method} ${path} failed: ${payload.msg ?? response.statusText}`,
          payload.code,
          response.status
        );
      }

      return (payload.data ?? {}) as T;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new FeishuApiError(`Feishu API ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function stripInlineChildren(block: FeishuBlock): FeishuBlock {
  const { children: _children, ...rest } = block;
  return rest;
}

function toCreateBlock(block: FeishuBlock): FeishuBlock {
  const cleanBlock = stripInlineChildren(block);

  if (isTableBlock(cleanBlock)) {
    cleanBlock.table = { ...cleanBlock.table };
    delete cleanBlock.table.cells;

    const property = cleanBlock.table.property;
    if (isTableProperty(property)) {
      const { merge_info: _mergeInfo, ...createProperty } = property;
      cleanBlock.table.property = createProperty;
    }
  }

  return cleanBlock;
}

function segmentBlocksForCreate(blocks: FeishuBlock[], batchSize: number): Array<{ blocks: FeishuBlock[] }> {
  const segments: Array<{ blocks: FeishuBlock[] }> = [];
  let batch: FeishuBlock[] = [];

  for (const block of blocks) {
    if (block.block_type === 31) {
      if (batch.length > 0) {
        segments.push({ blocks: batch });
        batch = [];
      }
      segments.push({ blocks: [block] });
      continue;
    }

    batch.push(block);
    if (batch.length === batchSize) {
      segments.push({ blocks: batch });
      batch = [];
    }
  }

  if (batch.length > 0) {
    segments.push({ blocks: batch });
  }

  return segments;
}

function isBlockLike(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}

function isTableBlock(block: FeishuBlock): block is FeishuBlock & { table: { cells?: unknown[]; property?: unknown } } {
  return Boolean(block.table && typeof block.table === 'object' && !Array.isArray(block.table));
}

function isTableProperty(value: unknown): value is { merge_info?: unknown } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function parseJson(response: Response): Promise<FeishuResponse<unknown>> {
  try {
    return await response.json() as FeishuResponse<unknown>;
  } catch {
    throw new FeishuApiError(`Feishu API returned malformed JSON.`, undefined, response.status);
  }
}
