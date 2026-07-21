import { execFile } from 'node:child_process';
import { LarkCliProviderError, LarkCliTransport, type DocxTransport } from 'feishu-docx-engine';
import { CliFailure, type CliFailureType } from '../core/cli-failure.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';
import type {
  CreatedDocument,
  CreatedChildBlocks,
  FeishuAdapter,
  RemoteBaseRecord,
  RemoteBaseTable,
  RemoteBlocks,
  RemoteCodeMetadata,
  RemoteMarkdown,
  RemoteMutationResult,
  RemoteWhiteboard
} from './feishu-adapter.js';

export type LarkCliExecResult = {
  stdout: string;
  stderr: string;
};

export type LarkCliExecInput = {
  stdin?: string;
};

export type LarkCliExecutor = (args: string[], input?: LarkCliExecInput) => Promise<LarkCliExecResult>;
export type LarkCliIdentity = 'auto' | 'bot' | 'user';

export class LarkCliAdapter implements FeishuAdapter {
  private readonly exec: LarkCliExecutor;
  private readonly identity: LarkCliIdentity;
  readonly docxTransport: DocxTransport;
  private nextWhiteboardIdempotencyToken?: string;

  constructor(input: { exec?: LarkCliExecutor; identity?: LarkCliIdentity } = {}) {
    this.exec = input.exec ?? runLarkCli;
    this.identity = input.identity ?? larkCliIdentityFromEnv();
    const transport = new LarkCliTransport({
      exec: (args, execInput) => this.exec(args, execInput),
      identity: this.identity
    });
    this.docxTransport = {
      resolveDocument: (selector) => transport.resolveDocument(selector),
      fetchBlocks: (documentId) => transport.fetchBlocks(documentId),
      replaceBlock: (request) => transport.replaceBlock(request),
      insertAfter: (request) => transport.insertAfter(request),
      createChildren: (request) => transport.createChildren(request),
      moveAfter: (request) => transport.moveAfter(request),
      deleteBlocks: (request) => transport.deleteBlocks(request),
      createDocument: (request) => transport.createDocument(request),
      queryWhiteboard: (token) => transport.queryWhiteboard(token),
      overwriteWhiteboard: (request) => transport.overwriteWhiteboard({
        ...request,
        idempotencyToken: this.effectiveWhiteboardIdempotencyToken(request.idempotencyToken)
      })
    };
  }

  setDocxEngineWhiteboardIdempotencyToken(token?: string): void {
    this.nextWhiteboardIdempotencyToken = token;
  }

  private effectiveWhiteboardIdempotencyToken(fallback: string): string {
    return this.nextWhiteboardIdempotencyToken ?? fallback;
  }

  async resolveBaseUrl(input: { url: string }): Promise<{ baseToken: string }> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'base',
      '+url-resolve',
      '--url',
      input.url,
      '--format',
      'json'
    ], this.identity)));
    const baseToken = baseTokenFromData(parsed.data);
    if (!baseToken) {
      throw new Error('lark-cli base +url-resolve did not return data.base_token.');
    }
    return { baseToken };
  }

  async fetchBaseTables(input: { baseToken: string }): Promise<RemoteBaseTable[]> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'base',
      '+base-block-list',
      '--base-token',
      input.baseToken,
      '--format',
      'json'
    ], this.identity)));
    return baseTablesFromData(parsed.data);
  }

  async fetchBaseRecords(input: {
    baseToken: string;
    tableId: string;
    fields: string[];
  }): Promise<RemoteBaseRecord[]> {
    const records: RemoteBaseRecord[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const fieldArgs = input.fields.flatMap((field) => ['--field-id', field]);
      const parsed = parseLarkCliJson(await this.exec(withIdentity([
        'base',
        '+record-list',
        '--base-token',
        input.baseToken,
        '--table-id',
        input.tableId,
        '--limit',
        '200',
        '--offset',
        String(offset),
        ...fieldArgs,
        '--format',
        'json'
      ], this.identity)));
      const page = baseRecordPageFromData(parsed.data);
      records.push(...page.records);
      offset += page.records.length;
      hasMore = page.hasMore;
      if (hasMore && page.records.length === 0) {
        throw new Error('lark-cli base +record-list returned an empty page with has_more=true.');
      }
    }

    return records;
  }

  async resolveDocumentId(input: { target: PublishReceiptTarget }): Promise<string> {
    if (input.target.kind === 'folder') {
      throw new Error('Folder targets do not resolve to an existing document.');
    }
    return withDocxTransportFailure(async () => {
      const selector = input.target.kind === 'docx'
        ? { kind: 'docx' as const, token: input.target.token }
        : { kind: 'wiki' as const, token: input.target.token };
      return (await this.docxTransport.resolveDocument(selector)).documentId;
    });
  }

  async fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown> {
    const result = await this.exec(withIdentity([
      'docs',
      '+fetch',
      '--doc',
      input.doc,
      '--doc-format',
      'markdown',
      '--format',
      'json'
    ], this.identity));
    const data = parseLarkCliJson(result);
    const content = markdownContentFromData(data.data);
    if (typeof content !== 'string') {
      throw new Error('lark-cli docs +fetch did not return document content.');
    }
    const revision = revisionFromData(data.data);
    return { markdown: content, revision };
  }

  async fetchDocBlocks(input: { doc: string }): Promise<RemoteBlocks> {
    return withDocxTransportFailure(async () => {
      const snapshot = await this.docxTransport.fetchBlocks(input.doc);
      return { blocks: snapshot.blocks };
    });
  }

  async fetchDocCodeMetadata(input: { doc: string }): Promise<RemoteCodeMetadata[]> {
    const result = await this.exec(withIdentity([
      'docs',
      '+fetch',
      '--doc',
      input.doc,
      '--doc-format',
      'xml',
      '--detail',
      'full',
      '--format',
      'json'
    ], this.identity));
    const parsed = parseLarkCliJson(result);
    const content = markdownContentFromData(parsed.data);
    if (typeof content !== 'string') {
      throw new Error('lark-cli docs +fetch did not return XML document content.');
    }
    return codeMetadataFromXml(content);
  }

  async replaceDocument(input: { doc: string; markdown: string }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      'overwrite',
      '--doc-format',
      'markdown',
      '--content',
      input.markdown,
      '--format',
      'json'
    ], this.identity)));
  }

  replaceBlock(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<RemoteMutationResult> {
    return withDocxTransportFailure(() => this.docxTransport.replaceBlock({
      documentId: input.doc,
      blockId: input.blockId,
      content: input.content,
      format: input.format
    }));
  }

  insertBlocksAfter(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<RemoteMutationResult> {
    return withDocxTransportFailure(() => this.docxTransport.insertAfter({
      documentId: input.doc,
      blockId: input.blockId,
      content: input.content,
      format: input.format
    }));
  }

  createChildBlocks(input: {
    doc: string;
    parentBlockId: string;
    index?: number;
    blocks: import('../feishu/types.js').FeishuBlock[];
    clientToken: string;
  }): Promise<CreatedChildBlocks> {
    return withDocxTransportFailure(async () => {
      const result = await this.docxTransport.createChildren({
        documentId: input.doc,
        parentBlockId: input.parentBlockId,
        index: input.index ?? -1,
        blocks: input.blocks,
        clientToken: input.clientToken
      });
      return { ...result, blocks: result.blocks };
    });
  }

  moveBlocksAfter(input: {
    doc: string;
    blockId: string;
    sourceBlockIds: string[];
  }): Promise<void> {
    return withDocxTransportFailure(() => this.docxTransport.moveAfter({
      documentId: input.doc,
      anchorBlockId: input.blockId,
      blockIds: input.sourceBlockIds
    }));
  }

  deleteBlocks(input: { doc: string; blockIds: string[] }): Promise<void> {
    return withDocxTransportFailure(() => this.docxTransport.deleteBlocks({
      documentId: input.doc,
      blockIds: input.blockIds
    }));
  }

  async queryWhiteboard(input: { whiteboardToken: string }): Promise<RemoteWhiteboard> {
    return withDocxTransportFailure(async () => ({
      raw: await this.docxTransport.queryWhiteboard(input.whiteboardToken)
    }));
  }

  updateWhiteboard(input: {
    whiteboardToken: string;
    svg: string;
    idempotencyToken: string;
  }): Promise<void> {
    return withDocxTransportFailure(() => this.docxTransport.overwriteWhiteboard({
      token: input.whiteboardToken,
      format: 'svg',
      value: input.svg,
      idempotencyToken: input.idempotencyToken
    }));
  }

  async createDocument(input: { title: string; markdown: string; parentToken: string }): Promise<CreatedDocument> {
    return withDocxTransportFailure(() => this.docxTransport.createDocument(input));
  }
}

async function withDocxTransportFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LarkCliProviderError) throw larkCliFailure(error.envelope);
    throw error;
  }
}

function baseTokenFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const token = (data as { base_token?: unknown }).base_token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

function baseTablesFromData(data: unknown): RemoteBaseTable[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const blocks = (data as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const record = block as { id?: unknown; name?: unknown; type?: unknown };
    if (record.type !== 'table' || typeof record.id !== 'string' || typeof record.name !== 'string') {
      return [];
    }
    return [{ id: record.id, name: record.name }];
  });
}

function baseRecordPageFromData(data: unknown): {
  records: RemoteBaseRecord[];
  hasMore: boolean;
} {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { records: [], hasMore: false };
  }
  const page = data as {
    fields?: unknown;
    data?: unknown;
    record_id_list?: unknown;
    has_more?: unknown;
  };
  const fields = Array.isArray(page.fields) && page.fields.every((field) => typeof field === 'string')
    ? page.fields as string[]
    : [];
  const rows = Array.isArray(page.data) ? page.data : [];
  const recordIds = Array.isArray(page.record_id_list) &&
    page.record_id_list.every((recordId) => typeof recordId === 'string')
    ? page.record_id_list as string[]
    : [];
  const consistentRows = rows.every((row) => Array.isArray(row) && row.length === fields.length);
  if (rows.length !== recordIds.length || !consistentRows) {
    throw new Error('lark-cli base +record-list returned inconsistent columnar data.');
  }
  return {
    records: rows.map((row, index) => ({
      recordId: recordIds[index]!,
      fields: Object.fromEntries(fields.map((field, fieldIndex) => [
        field,
        (row as unknown[])[fieldIndex]
      ]))
    })),
    hasMore: page.has_more === true
  };
}

function withIdentity(args: string[], identity: LarkCliIdentity): string[] {
  return identity === 'auto' ? args : [...args, '--as', identity];
}

function larkCliIdentityFromEnv(): LarkCliIdentity {
  const value = process.env.FEISHU_MD_SYNC_LARK_AS;
  return value === 'bot' || value === 'user' ? value : 'auto';
}

function runLarkCli(args: string[], input: LarkCliExecInput = {}): Promise<LarkCliExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('lark-cli', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const parsedFailure = larkCliFailureFromJson(stderr);
        if (parsedFailure) {
          reject(parsedFailure);
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new CliFailure({
            type: 'config',
            subtype: 'lark_cli_missing',
            message: 'lark-cli is not installed or is not available on PATH',
            hint: 'install the official Lark CLI and verify it with lark-cli auth status --verify',
            retryable: false
          }, { cause: error }));
          return;
        }
        reject(new CliFailure({
          type: 'internal',
          subtype: 'lark_cli_process_failed',
          message: 'lark-cli exited without a structured error response',
          hint: 'run the corresponding lark-cli command directly with --format json and inspect its stderr',
          retryable: false
        }, { cause: error }));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
  });
}

function parseLarkCliJson(result: LarkCliExecResult): { ok?: boolean; data?: unknown; error?: LarkCliErrorEnvelope } {
  const raw = result.stdout.trim() || result.stderr.trim();
  let parsed: { ok?: boolean; data?: unknown; error?: LarkCliErrorEnvelope };
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; data?: unknown; error?: LarkCliErrorEnvelope };
  } catch {
    throw new CliFailure({
      type: 'internal',
      subtype: 'lark_cli_non_json',
      message: 'lark-cli returned non-JSON output',
      hint: 'rerun the corresponding lark-cli command directly with --format json',
      retryable: false
    });
  }
  if (parsed.ok === false) {
    throw larkCliFailure(parsed.error);
  }
  return parsed;
}

type LarkCliErrorEnvelope = {
  type?: string;
  subtype?: string;
  code?: number;
  message?: string;
  hint?: string;
  retryable?: boolean;
  missing_scopes?: string[];
  console_url?: string;
};

function larkCliFailureFromJson(raw: string): CliFailure | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: LarkCliErrorEnvelope };
    return parsed.ok === false ? larkCliFailure(parsed.error) : undefined;
  } catch {
    return undefined;
  }
}

function larkCliFailure(error: LarkCliErrorEnvelope | undefined): CliFailure {
  const type = mapLarkCliFailureType(error?.type);
  return new CliFailure({
    type,
    subtype: error?.subtype ?? 'lark_cli_error',
    message: error?.message ?? 'lark-cli returned an unknown error',
    hint: error?.hint,
    requiredFlags: error?.type === 'confirmation_required' ? ['--yes'] : undefined,
    retryable: error?.retryable === true,
    ...(typeof error?.code === 'number' ? { providerCode: error.code } : {}),
    missingScopes: error?.missing_scopes,
    consoleUrl: error?.console_url
  });
}

function mapLarkCliFailureType(type: string | undefined): CliFailureType {
  if (type === 'authentication') return 'authentication';
  if (type === 'authorization') return 'authorization';
  if (type === 'config') return 'config';
  if (type === 'network') return 'network';
  if (type === 'confirmation' || type === 'confirmation_required') return 'confirmation_required';
  if (type === 'validation') return 'validation';
  if (type === 'verification') return 'verification';
  if (type === 'policy') return 'authorization';
  return 'internal';
}

function markdownContentFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if ('content' in data && typeof (data as { content?: unknown }).content === 'string') {
    return (data as { content: string }).content;
  }
  if ('document' in data) {
    const document = (data as { document?: unknown }).document;
    if (document && typeof document === 'object' && typeof (document as { content?: unknown }).content === 'string') {
      return (document as { content: string }).content;
    }
  }
  return undefined;
}

function codeMetadataFromXml(xml: string): RemoteCodeMetadata[] {
  return [...xml.matchAll(/<pre\b([^>]*)>/gi)].flatMap((match) => {
    const attributes = parseXmlAttributes(match[1] ?? '');
    const blockId = attributes.id;
    const language = attributes.lang;
    if (!blockId || !language) return [];
    const caption = attributes.caption?.replace(/\n+$/g, '');
    return [{
      blockId,
      language,
      ...(caption ? { caption } : {})
    }];
  });
}

function parseXmlAttributes(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((match) => {
    return [match[1]!, decodeXmlEntities(match[2] ?? '')];
  }));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function revisionFromData(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (typeof (data as { revision?: unknown }).revision === 'string') {
    return (data as { revision: string }).revision;
  }
  if ('document' in data) {
    const document = (data as { document?: unknown }).document;
    const revision = document && typeof document === 'object'
      ? (document as { revision_id?: unknown }).revision_id
      : undefined;
    return typeof revision === 'string' || typeof revision === 'number' ? String(revision) : undefined;
  }
  return undefined;
}
