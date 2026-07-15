import { execFile } from 'node:child_process';
import { CliFailure, type CliFailureType } from '../core/cli-failure.js';
import type { FeishuBlock } from '../feishu/types.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';
import type {
  CreatedDocument,
  CreatedWhiteboard,
  FeishuAdapter,
  RemoteBlocks,
  RemoteCodeMetadata,
  RemoteMarkdown,
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

  constructor(input: { exec?: LarkCliExecutor; identity?: LarkCliIdentity } = {}) {
    this.exec = input.exec ?? runLarkCli;
    this.identity = input.identity ?? larkCliIdentityFromEnv();
  }

  async resolveDocumentId(input: { target: PublishReceiptTarget }): Promise<string> {
    if (input.target.kind === 'docx') return input.target.token;
    if (input.target.kind === 'folder') {
      throw new Error('Folder targets do not resolve to an existing document.');
    }
    const result = await this.exec(withIdentity([
      'api',
      'GET',
      '/open-apis/wiki/v2/spaces/get_node',
      '--params',
      JSON.stringify({ token: input.target.token }),
      '--format',
      'json'
    ], this.identity));
    const parsed = parseLarkCliJson(result);
    const node = wikiNodeFromData(parsed.data);
    if (node?.obj_type !== 'docx' || typeof node.obj_token !== 'string') {
      throw new Error(`Wiki node ${input.target.token} does not resolve to a Docx document.`);
    }
    return node.obj_token;
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
    const blocks: FeishuBlock[] = [];
    let pageToken: string | undefined;

    do {
      const params: Record<string, string | number> = {
        page_size: 500,
        document_revision_id: -1
      };
      if (pageToken) params.page_token = pageToken;

      const result = await this.exec(withIdentity([
        'api',
        'GET',
        `/open-apis/docx/v1/documents/${input.doc}/blocks`,
        '--params',
        JSON.stringify(params),
        '--format',
        'json'
      ], this.identity));
      const parsed = parseLarkCliJson(result);
      const page = blockPageFromData(parsed.data);
      blocks.push(...page.items);
      pageToken = page.hasMore ? page.pageToken : undefined;
    } while (pageToken);

    return { blocks };
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

  async replaceBlock(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<void> {
    await this.updateBlock({
      doc: input.doc,
      command: 'block_replace',
      blockId: input.blockId,
      content: input.format === 'xml' ? '-' : input.content,
      format: input.format,
      stdin: input.format === 'xml' ? input.content : undefined
    });
  }

  async moveBlocksAfter(input: {
    doc: string;
    blockId: string;
    sourceBlockIds: string[];
  }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      'block_move_after',
      '--block-id',
      input.blockId,
      '--src-block-ids',
      input.sourceBlockIds.join(','),
      '--format',
      'json'
    ], this.identity)));
  }

  async insertBlocksAfter(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<void> {
    await this.updateBlock({
      doc: input.doc,
      command: 'block_insert_after',
      blockId: input.blockId,
      content: input.format === 'xml' ? '-' : input.content,
      format: input.format,
      stdin: input.format === 'xml' ? input.content : undefined
    });
  }

  async deleteBlocks(input: { doc: string; blockIds: string[] }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      'block_delete',
      '--block-id',
      input.blockIds.join(','),
      '--format',
      'json'
    ], this.identity)));
  }

  async replaceImageWithWhiteboard(input: {
    doc: string;
    blockId: string;
    svg: string;
  }): Promise<CreatedWhiteboard> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      'block_replace',
      '--block-id',
      input.blockId,
      '--doc-format',
      'xml',
      '--content',
      '-',
      '--format',
      'json'
    ], this.identity), {
      stdin: `<whiteboard type="svg">${input.svg}</whiteboard>`
    }));
    return createdWhiteboardFromData(parsed.data);
  }

  async queryWhiteboard(input: { whiteboardToken: string }): Promise<RemoteWhiteboard> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'whiteboard',
      '+query',
      '--whiteboard-token',
      input.whiteboardToken,
      '--output_as',
      'raw',
      '--format',
      'json'
    ], this.identity)));
    return { raw: whiteboardRawFromData(parsed.data) };
  }

  async updateWhiteboard(input: {
    whiteboardToken: string;
    svg: string;
    idempotencyToken: string;
  }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'whiteboard',
      '+update',
      '--whiteboard-token',
      input.whiteboardToken,
      '--input_format',
      'svg',
      '--source',
      '-',
      '--overwrite',
      '--idempotent-token',
      input.idempotencyToken,
      '--format',
      'json'
    ], this.identity), { stdin: input.svg }));
  }

  async createDocument(input: { title: string; markdown: string; parentToken: string }): Promise<CreatedDocument> {
    const data = parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+create',
      '--title',
      input.title,
      '--doc-format',
      'markdown',
      '--content',
      input.markdown,
      '--parent-token',
      input.parentToken,
      '--format',
      'json'
    ], this.identity)));
    const document = documentFromData(data.data);
    if (!document) {
      throw new Error('lark-cli docs +create did not return data.document.');
    }
    const documentId = typeof document.document_id === 'string' ? document.document_id : undefined;
    if (!documentId) {
      throw new Error('lark-cli docs +create did not return document.document_id.');
    }
    return {
      documentId,
      url: typeof document.url === 'string' ? document.url : undefined,
      revision: typeof document.revision_id === 'string' || typeof document.revision_id === 'number'
        ? String(document.revision_id)
        : undefined
    };
  }

  private async updateBlock(input: {
    doc: string;
    command: 'block_replace' | 'block_insert_after';
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
    stdin?: string;
  }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      input.command,
      '--block-id',
      input.blockId,
      '--doc-format',
      input.format,
      '--content',
      input.content,
      '--format',
      'json'
    ], this.identity), input.stdin === undefined ? undefined : { stdin: input.stdin }));
  }
}

function wikiNodeFromData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || !('node' in data)) return undefined;
  const node = (data as { node?: unknown }).node;
  return node && typeof node === 'object' && !Array.isArray(node)
    ? node as Record<string, unknown>
    : undefined;
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
    retryable: error?.retryable === true,
    missingScopes: error?.missing_scopes,
    consoleUrl: error?.console_url
  });
}

function mapLarkCliFailureType(type: string | undefined): CliFailureType {
  if (type === 'authentication') return 'authentication';
  if (type === 'authorization') return 'authorization';
  if (type === 'config') return 'config';
  if (type === 'network') return 'network';
  if (type === 'confirmation') return 'confirmation_required';
  if (type === 'validation') return 'validation';
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

function documentFromData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || !('document' in data)) return undefined;
  const document = (data as { document?: unknown }).document;
  return document && typeof document === 'object' ? document as Record<string, unknown> : undefined;
}

function createdWhiteboardFromData(data: unknown): CreatedWhiteboard {
  const document = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as { document?: unknown }).document
    : undefined;
  const newBlocks = document && typeof document === 'object' && !Array.isArray(document)
    ? (document as { new_blocks?: unknown }).new_blocks
    : undefined;
  const whiteboards = Array.isArray(newBlocks) ? newBlocks.filter(isCreatedWhiteboard) : [];
  if (whiteboards.length !== 1) {
    throw new Error(`lark-cli docs +update returned ${whiteboards.length} Whiteboard blocks; expected exactly one`);
  }
  const whiteboard = whiteboards[0];
  return {
    blockId: whiteboard.block_id,
    whiteboardToken: whiteboard.block_token
  };
}

function isCreatedWhiteboard(value: unknown): value is { block_id: string; block_token: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const block = value as { block_id?: unknown; block_type?: unknown; block_token?: unknown };
  return (block.block_type === 'whiteboard' || block.block_type === 43 || block.block_type === '43') &&
    typeof block.block_id === 'string' &&
    typeof block.block_token === 'string';
}

function whiteboardRawFromData(data: unknown): unknown {
  let raw: unknown;
  if (Array.isArray(data)) {
    raw = data;
  } else if (typeof data === 'string') {
    raw = parseEmbeddedJson(data);
  } else if (!data || typeof data !== 'object') {
    throw new Error('lark-cli whiteboard +query did not return raw node state.');
  } else {
    const record = data as Record<string, unknown>;
    if ('raw' in record) raw = record.raw;
    else if (typeof record.content === 'string') raw = parseEmbeddedJson(record.content);
    else raw = data;
  }
  const hasNodeState = Array.isArray(raw)
    ? raw.length > 0
    : Boolean(raw && typeof raw === 'object' && Array.isArray((raw as { nodes?: unknown }).nodes));
  if (!hasNodeState) {
    throw new Error('lark-cli whiteboard +query did not return raw node state.');
  }
  return raw;
}

function parseEmbeddedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('lark-cli whiteboard +query returned invalid raw JSON.');
  }
}

function blockPageFromData(data: unknown): { items: FeishuBlock[]; hasMore: boolean; pageToken?: string } {
  if (!data || typeof data !== 'object') {
    return { items: [], hasMore: false };
  }
  const record = data as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.filter(isFeishuBlock) : [];
  const hasMore = record.has_more === true;
  const pageToken = typeof record.page_token === 'string' ? record.page_token : undefined;
  return { items, hasMore, pageToken };
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'block_type' in value);
}
