import type {
  BitableField,
  BitableRecord,
  BitableTable,
  FeishuBlock,
  FeishuBlockUpdateRequest,
  FeishuDocClient,
  FeishuDriveFile
} from './types.js';
import { FeishuTokenProvider } from './token.js';
import { FeishuApiError } from '../services/feishu/errors.js';
import { withFeishuRetry } from '../services/feishu/retry.js';
import { FeishuBitableClient } from '../services/feishu/bitable-client.js';
import { FeishuDocxClient } from '../services/feishu/docx-client.js';
import { FeishuDriveClient } from '../services/feishu/drive-client.js';

export { FeishuApiError } from '../services/feishu/errors.js';

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

export class FeishuClient implements FeishuDocClient {
  private readonly host: string;
  private readonly tokenProvider: FeishuTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly docx: FeishuDocxClient;
  private readonly drive: FeishuDriveClient;
  private readonly bitable: FeishuBitableClient;

  constructor(config: ClientConfig = {}) {
    this.host = config.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn';
    this.tokenProvider = config.tokenProvider ?? new FeishuTokenProvider({ host: this.host });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    const request = this.request.bind(this);
    this.docx = new FeishuDocxClient(request);
    this.drive = new FeishuDriveClient(request);
    this.bitable = new FeishuBitableClient(request);
  }

  async getDocumentBlocks(documentId: string): Promise<FeishuBlock[]> {
    const blocks: FeishuBlock[] = [];
    let pageToken: string | undefined;

    do {
      const data = await this.docx.getDocumentBlocksPage(documentId, pageToken);
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
    await this.docx.deleteChildren(documentId, parentBlockId, startIndex, endIndex);
  }

  async createChildren(
    documentId: string,
    parentBlockId: string,
    blocks: FeishuBlock[],
    options: { index?: number } = {}
  ): Promise<FeishuBlock[]> {
    const created: FeishuBlock[] = [];
    const batchSize = 50;
    const segments = segmentBlocksForCreate(blocks, batchSize);

    for (const segment of segments) {
      const batch = segment.blocks.map(toCreateBlock);
      let data: { children?: FeishuBlock[] };
      try {
        data = await this.docx.createChildren(
          documentId,
          parentBlockId,
          createChildrenBody(batch, options.index === undefined ? undefined : options.index + created.length)
        );
      } catch (error) {
        throw enrichCreateChildrenError(error, {
          parentBlockId,
          startIndex: segment.startIndex,
          totalCount: blocks.length,
          batch
        });
      }
      const createdBatch = data.children ?? [];
      created.push(...createdBatch);

      for (let index = 0; index < createdBatch.length; index += 1) {
        const sourceBlock = segment.blocks[index];
        const createdBlock = createdBatch[index];
        if (sourceBlock && createdBlock) {
          await this.populateTableCells(documentId, sourceBlock, createdBlock);
          await this.populateBlockChildren(documentId, sourceBlock, createdBlock);
        }
      }
    }

    return created;
  }

  async batchUpdateBlocks(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]> {
    if (requests.length === 0) return [];

    const data = await this.docx.batchUpdateBlocks(documentId, requests);

    return data.blocks ?? [];
  }

  async listFolder(folderToken: string, type?: string): Promise<FeishuDriveFile[]> {
    return this.drive.listFolder(folderToken, type);
  }

  async createFolder(name: string, parentToken: string): Promise<FeishuDriveFile> {
    return this.drive.createFolder(name, parentToken);
  }

  async copyFile(token: string, targetFolderToken: string, name?: string, type?: string): Promise<FeishuDriveFile> {
    return this.drive.copyFile(token, targetFolderToken, name, type);
  }

  async moveFile(token: string, targetFolderToken: string, type?: string): Promise<FeishuDriveFile> {
    return this.drive.moveFile(token, targetFolderToken, type);
  }

  async createDocxDocument(title: string, folderToken: string): Promise<FeishuDriveFile> {
    return this.docx.createDocument(title, folderToken);
  }

  async listBitableTables(appToken: string): Promise<BitableTable[]> {
    return this.bitable.listTables(appToken);
  }

  async listBitableFields(appToken: string, tableId: string): Promise<BitableField[]> {
    return this.bitable.listFields(appToken, tableId);
  }

  async listBitableRecords(appToken: string, tableId: string): Promise<BitableRecord[]> {
    const records: BitableRecord[] = [];
    let pageToken: string | undefined;

    do {
      const data = await this.bitable.listRecordsPage(appToken, tableId, pageToken);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);

    return records;
  }

  async createBitableRecord(
    appToken: string,
    tableId: string,
    fields: Record<string, unknown>
  ): Promise<BitableRecord> {
    return this.bitable.createRecord(appToken, tableId, fields);
  }

  async updateBitableRecord(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<BitableRecord> {
    return this.bitable.updateRecord(appToken, tableId, recordId, fields);
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

      await this.docx.createChildren(documentId, cellId, { children: [toCreateBlock(cellContent)], index: 0 });
    }
  }

  private async populateBlockChildren(
    documentId: string,
    sourceBlock: FeishuBlock,
    createdBlock: FeishuBlock
  ): Promise<void> {
    if (!createdBlock.block_id || !Array.isArray(sourceBlock.children)) return;
    const childBlocks = sourceBlock.children.filter(isBlockLike);
    if (childBlocks.length === 0) return;

    await this.createChildren(documentId, createdBlock.block_id, childBlocks);
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return withFeishuRetry(() => this.requestOnce<T>(method, path, body), { sleep: async () => undefined });
  }

  private async requestOnce<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
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
          { code: payload.code, status: response.status, method, path, responseBody: payload }
        );
      }

      return (payload.data ?? {}) as T;
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new FeishuApiError(`Feishu API ${method} ${path} timed out after ${this.timeoutMs}ms`, { method, path });
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

function createChildrenBody(children: FeishuBlock[], index?: number): { children: FeishuBlock[]; index?: number } {
  return index === undefined ? { children } : { children, index };
}

function segmentBlocksForCreate(blocks: FeishuBlock[], batchSize: number): Array<{ startIndex: number; blocks: FeishuBlock[] }> {
  const segments: Array<{ startIndex: number; blocks: FeishuBlock[] }> = [];
  let batch: FeishuBlock[] = [];
  let batchStartIndex = 0;

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.block_type === 31) {
      if (batch.length > 0) {
        segments.push({ startIndex: batchStartIndex, blocks: batch });
        batch = [];
      }
      segments.push({ startIndex: index, blocks: [block] });
      batchStartIndex = index + 1;
      continue;
    }

    if (batch.length === 0) {
      batchStartIndex = index;
    }
    batch.push(block);
    if (batch.length === batchSize) {
      segments.push({ startIndex: batchStartIndex, blocks: batch });
      batch = [];
      batchStartIndex = index + 1;
    }
  }

  if (batch.length > 0) {
    segments.push({ startIndex: batchStartIndex, blocks: batch });
  }

  return segments;
}

function enrichCreateChildrenError(
  error: unknown,
  input: {
    parentBlockId: string;
    startIndex: number;
    totalCount: number;
    batch: FeishuBlock[];
  }
): Error {
  const originalMessage = error instanceof Error ? error.message : String(error);
  const rangeStart = input.startIndex + 1;
  const rangeEnd = input.startIndex + input.batch.length;
  const firstBlock = input.batch[0];
  const blockType = firstBlock?.block_type ?? 'unknown';
  const message =
    `Failed to create Feishu child blocks ${rangeStart}-${rangeEnd} under parent block ${input.parentBlockId} ` +
    `(${input.totalCount} total replacement blocks). First generated block type: ${blockType}. ` +
    `First generated block preview: ${jsonPreview(firstBlock)}. Feishu error: ${originalMessage}`;

  if (error instanceof FeishuApiError) {
    return new FeishuApiError(message, {
      code: error.code,
      status: error.status,
      method: error.method,
      path: error.path,
      requestId: error.requestId,
      responseBody: error.responseBody
    });
  }
  return new Error(message);
}

function jsonPreview(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = '[unserializable block]';
  }
  return serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized;
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
    throw new FeishuApiError(`Feishu API returned malformed JSON.`, { status: response.status });
  }
}
