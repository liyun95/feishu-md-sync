import { execFile } from 'node:child_process';
import type { DocumentSelector } from './model.js';
import type {
  CreateChildrenInput,
  CreatedChildrenResult,
  CreateDocumentInput,
  CreatedDocumentResult,
  DocxTransport,
  OverwriteWhiteboardInput,
  ProviderBlock,
  ProviderMutationInput,
  ProviderMutationResult,
} from './transport.js';

export type LarkCliExecResult = {
  stdout: string;
  stderr: string;
};

export type LarkCliExecInput = {
  stdin?: string;
};

export type LarkCliExecutor = (
  args: string[],
  input?: LarkCliExecInput,
) => Promise<LarkCliExecResult>;

export type LarkCliIdentity = 'auto' | 'bot' | 'user';

export interface LarkCliErrorEnvelope {
  type?: string;
  subtype?: string;
  code?: number;
  message?: string;
  hint?: string;
  retryable?: boolean;
  missing_scopes?: string[];
  console_url?: string;
  [key: string]: unknown;
}

export interface LarkCliProviderErrorDetails {
  type: string;
  subtype: string;
  providerCode?: number;
  message: string;
  hint?: string;
  retryable: boolean;
  missingScopes?: string[];
  consoleUrl?: string;
}

export class LarkCliProviderError extends Error {
  readonly envelope: LarkCliErrorEnvelope;
  readonly details: LarkCliProviderErrorDetails;

  constructor(envelope: LarkCliErrorEnvelope = {}, options: ErrorOptions = {}) {
    const details = providerErrorDetails(envelope);
    super(details.message, options);
    this.name = 'LarkCliProviderError';
    this.envelope = envelope;
    this.details = details;
  }
}

export class LarkCliTransport implements DocxTransport {
  private readonly exec: LarkCliExecutor;
  private readonly identity: LarkCliIdentity;

  constructor(input: {
    exec?: LarkCliExecutor;
    identity?: LarkCliIdentity;
  } = {}) {
    this.exec = input.exec ?? runLarkCli;
    this.identity = input.identity ?? 'auto';
  }

  async resolveDocument(selector: DocumentSelector): Promise<{ documentId: string }> {
    const target = selector.kind === 'url'
      ? selectorFromUrl(selector.url)
      : selector;
    if (target.kind === 'docx') {
      return { documentId: target.token };
    }

    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'api',
      'GET',
      '/open-apis/wiki/v2/spaces/get_node',
      '--params',
      JSON.stringify({ token: target.token }),
      '--format',
      'json',
    ], this.identity)));
    const node = wikiNodeFromData(parsed.data);
    if (node?.obj_type !== 'docx' || typeof node.obj_token !== 'string') {
      throw new Error(`Wiki node ${target.token} does not resolve to a Docx document.`);
    }
    return { documentId: node.obj_token };
  }

  async fetchBlocks(documentId: string): Promise<{
    revision: string;
    blocks: ProviderBlock[];
  }> {
    const metadata = parseLarkCliJson(await this.exec(withIdentity([
      'api',
      'GET',
      `/open-apis/docx/v1/documents/${documentId}`,
      '--format',
      'json',
    ], this.identity)));
    const documentRevision = documentRevisionFromData(metadata.data);
    const blocks: ProviderBlock[] = [];
    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();

    do {
      const params: Record<string, string | number> = {
        page_size: 500,
        document_revision_id: documentRevision.parameter,
      };
      if (pageToken) params.page_token = pageToken;

      const parsed = parseLarkCliJson(await this.exec(withIdentity([
        'api',
        'GET',
        `/open-apis/docx/v1/documents/${documentId}/blocks`,
        '--params',
        JSON.stringify(params),
        '--format',
        'json',
      ], this.identity)));
      const page = blockPageFromData(parsed.data);
      blocks.push(...page.items);
      if (page.hasMore) {
        const nextPageToken = page.pageToken!;
        if (seenPageTokens.has(nextPageToken)) {
          throw invalidResponseError(
            `lark-cli Docx block list repeated page_token ${nextPageToken}.`,
          );
        }
        seenPageTokens.add(nextPageToken);
      }
      pageToken = page.hasMore ? page.pageToken : undefined;
    } while (pageToken);

    const completeBlocks = blocks.some((block) => block.block_type === 14)
      ? await this.enrichCodeMetadata(documentId, documentRevision, blocks)
      : blocks;
    return { revision: documentRevision.revision, blocks: completeBlocks };
  }

  replaceBlock(input: ProviderMutationInput): Promise<ProviderMutationResult> {
    return this.updateBlock(input, 'block_replace');
  }

  insertAfter(input: ProviderMutationInput): Promise<ProviderMutationResult> {
    return this.updateBlock(input, 'block_insert_after');
  }

  async createChildren(input: CreateChildrenInput): Promise<CreatedChildrenResult> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'api',
      'POST',
      `/open-apis/docx/v1/documents/${input.documentId}/blocks/${input.parentBlockId}/children`,
      '--params',
      JSON.stringify({
        document_revision_id: -1,
        client_token: input.clientToken,
      }),
      '--data',
      JSON.stringify({
        index: input.index,
        children: encodeProviderLinkUrls(input.blocks),
      }),
      '--format',
      'json',
    ], this.identity)));
    return createdChildrenFromData(parsed.data);
  }

  async moveAfter(input: {
    documentId: string;
    anchorBlockId: string;
    blockIds: string[];
  }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.documentId,
      '--command',
      'block_move_after',
      '--block-id',
      input.anchorBlockId,
      '--src-block-ids',
      input.blockIds.join(','),
      '--format',
      'json',
    ], this.identity)));
  }

  async deleteBlocks(input: {
    documentId: string;
    blockIds: string[];
  }): Promise<void> {
    parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.documentId,
      '--command',
      'block_delete',
      '--block-id',
      input.blockIds.join(','),
      '--format',
      'json',
    ], this.identity)));
  }

  async createDocument(input: CreateDocumentInput): Promise<CreatedDocumentResult> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
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
      'json',
    ], this.identity)));
    return createdDocumentFromData(parsed.data);
  }

  async queryWhiteboard(token: string): Promise<unknown> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'whiteboard',
      '+query',
      '--whiteboard-token',
      token,
      '--output_as',
      'raw',
      '--format',
      'json',
    ], this.identity)));
    return whiteboardRawFromData(parsed.data);
  }

  async overwriteWhiteboard(input: OverwriteWhiteboardInput): Promise<void> {
    const stdin = input.format === 'svg'
      ? input.value
      : JSON.stringify(input.value);
    parseLarkCliJson(await this.exec(withIdentity([
      'whiteboard',
      '+update',
      '--whiteboard-token',
      input.token,
      '--input_format',
      input.format,
      '--source',
      '-',
      '--overwrite',
      '--idempotent-token',
      input.idempotencyToken,
      '--format',
      'json',
    ], this.identity), { stdin }));
  }

  private async updateBlock(
    input: ProviderMutationInput,
    command: 'block_replace' | 'block_insert_after',
  ): Promise<ProviderMutationResult> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+update',
      '--doc',
      input.documentId,
      '--command',
      command,
      '--block-id',
      input.blockId,
      '--doc-format',
      input.format,
      '--content',
      input.format === 'xml' ? '-' : input.content,
      '--format',
      'json',
    ], this.identity), input.format === 'xml' ? { stdin: input.content } : undefined));
    return { revision: revisionFromData(parsed.data) };
  }

  private async enrichCodeMetadata(
    documentId: string,
    documentRevision: { revision: string; parameter: string | number },
    blocks: ProviderBlock[],
  ): Promise<ProviderBlock[]> {
    const parsed = parseLarkCliJson(await this.exec(withIdentity([
      'docs',
      '+fetch',
      '--doc',
      documentId,
      '--doc-format',
      'xml',
      '--detail',
      'full',
      '--revision-id',
      String(documentRevision.parameter),
      '--format',
      'json',
    ], this.identity)));
    const fetchedRevision = revisionFromData(parsed.data);
    if (fetchedRevision !== documentRevision.revision) {
      throw invalidResponseError(
        `lark-cli full XML readback returned revision ${fetchedRevision ?? '<missing>'}; expected ${documentRevision.revision}.`,
      );
    }
    const content = documentContentFromData(parsed.data);
    if (content === undefined) {
      throw invalidResponseError('lark-cli full XML readback did not return document.content.');
    }
    const metadata = codeMetadataFromXml(content);
    return blocks.map((block) => {
      if (block.block_type !== 14) return block;
      const blockId = typeof block.block_id === 'string' ? block.block_id : undefined;
      const codeMetadata = blockId ? metadata.get(blockId) : undefined;
      if (!blockId || !codeMetadata) {
        throw invalidResponseError(
          `lark-cli full XML readback is missing Code metadata for ${blockId ?? '<missing block ID>'}.`,
        );
      }
      const code = isRecord(block.code) ? block.code : {};
      const style = isRecord(code.style) ? { ...code.style } : {};
      style.language = codeMetadata.language;
      if (codeMetadata.caption === undefined) delete style.caption;
      else style.caption = codeMetadata.caption;
      return { ...block, code: { ...code, style } };
    });
  }
}

function selectorFromUrl(urlValue: string): Exclude<DocumentSelector, { kind: 'url' }> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid Feishu document URL: ${urlValue}`);
  }
  const docxMatch = url.pathname.match(/\/(?:docx|docs)\/([A-Za-z0-9]+)/);
  if (docxMatch?.[1]) return { kind: 'docx', token: docxMatch[1] };
  const wikiMatch = url.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch?.[1]) return { kind: 'wiki', token: wikiMatch[1] };
  throw new Error(`Could not find a supported Feishu document token in URL: ${urlValue}`);
}

function withIdentity(args: string[], identity: LarkCliIdentity): string[] {
  return identity === 'auto' ? args : [...args, '--as', identity];
}

function parseLarkCliJson(result: LarkCliExecResult): {
  ok?: boolean;
  data?: unknown;
  error?: LarkCliErrorEnvelope;
} {
  const raw = result.stdout.trim() || result.stderr.trim();
  let parsed: {
    ok?: boolean;
    data?: unknown;
    error?: LarkCliErrorEnvelope;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new LarkCliProviderError({
      type: 'internal',
      subtype: 'lark_cli_non_json',
      message: 'lark-cli returned non-JSON output',
      hint: 'rerun the corresponding lark-cli command directly with --format json',
      retryable: false,
    });
  }
  if (parsed.ok === false) throw new LarkCliProviderError(parsed.error);
  return parsed;
}

function providerErrorDetails(envelope: LarkCliErrorEnvelope): LarkCliProviderErrorDetails {
  return {
    type: envelope.type ?? 'internal',
    subtype: envelope.subtype ?? 'lark_cli_error',
    ...(typeof envelope.code === 'number' ? { providerCode: envelope.code } : {}),
    message: envelope.message ?? 'lark-cli returned an unknown error',
    ...(typeof envelope.hint === 'string' ? { hint: envelope.hint } : {}),
    retryable: envelope.retryable === true,
    ...(Array.isArray(envelope.missing_scopes)
      ? { missingScopes: envelope.missing_scopes }
      : {}),
    ...(typeof envelope.console_url === 'string'
      ? { consoleUrl: envelope.console_url }
      : {}),
  };
}

function runLarkCli(
  args: string[],
  input: LarkCliExecInput = {},
): Promise<LarkCliExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('lark-cli', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      const parsedFailure = providerFailureFromJson(stderr);
      if (parsedFailure) {
        reject(new LarkCliProviderError(parsedFailure, { cause: error }));
        return;
      }
      const processError = error as NodeJS.ErrnoException;
      if (processError.code === 'ENOENT') {
        reject(new LarkCliProviderError({
          type: 'config',
          subtype: 'lark_cli_missing',
          message: 'lark-cli is not installed or is not available on PATH',
          hint: 'install the official Lark CLI and verify it with lark-cli auth status --verify',
          retryable: false,
        }, { cause: error }));
        return;
      }
      reject(new LarkCliProviderError({
        type: 'internal',
        subtype: 'lark_cli_process_failed',
        message: 'lark-cli exited without a structured error response',
        hint: 'run the corresponding lark-cli command directly with --format json and inspect its stderr',
        retryable: false,
      }, { cause: error }));
    });
    if (input.stdin !== undefined) child.stdin?.end(input.stdin);
  });
}

function providerFailureFromJson(raw: string): LarkCliErrorEnvelope | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean;
      error?: LarkCliErrorEnvelope;
    };
    return parsed.ok === false ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

function wikiNodeFromData(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data.node)) return undefined;
  return data.node;
}

function blockPageFromData(data: unknown): {
  items: ProviderBlock[];
  hasMore: boolean;
  pageToken?: string;
} {
  if (!isRecord(data)) {
    throw invalidResponseError('lark-cli Docx block list did not return object data.');
  }
  if (!Array.isArray(data.items)) {
    throw invalidResponseError('lark-cli Docx block list did not return an items array.');
  }
  if (!data.items.every(isProviderBlock)) {
    throw invalidResponseError('lark-cli Docx block list returned a malformed block item.');
  }
  if (typeof data.has_more !== 'boolean') {
    throw invalidResponseError('lark-cli Docx block list did not return boolean has_more.');
  }
  if (
    data.page_token !== undefined
    && (typeof data.page_token !== 'string' || data.page_token.length === 0)
  ) {
    throw invalidResponseError('lark-cli Docx block list returned an invalid page_token.');
  }
  if (data.has_more && data.page_token === undefined) {
    throw invalidResponseError('lark-cli Docx block list returned has_more=true without page_token.');
  }
  if (!data.has_more && data.page_token !== undefined) {
    throw invalidResponseError('lark-cli Docx block list returned page_token with has_more=false.');
  }
  return {
    items: data.items,
    hasMore: data.has_more,
    ...(typeof data.page_token === 'string' ? { pageToken: data.page_token } : {}),
  };
}

function documentRevisionFromData(data: unknown): {
  revision: string;
  parameter: string | number;
} {
  const revision = isRecord(data) && isRecord(data.document)
    ? data.document.revision_id
    : undefined;
  const validNumber = typeof revision === 'number'
    && Number.isSafeInteger(revision)
    && revision >= 0;
  const validString = typeof revision === 'string' && /^\d+$/.test(revision);
  if (!validNumber && !validString) {
    throw invalidResponseError(
      'lark-cli Docx document metadata did not return document.revision_id.',
    );
  }
  return {
    revision: String(revision),
    parameter: revision,
  };
}

function documentContentFromData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (typeof data.content === 'string') return data.content;
  return isRecord(data.document) && typeof data.document.content === 'string'
    ? data.document.content
    : undefined;
}

function codeMetadataFromXml(xml: string): Map<string, { language: string; caption?: string }> {
  const metadata = new Map<string, { language: string; caption?: string }>();
  for (const match of xml.matchAll(/<pre\b([^>]*)>/gi)) {
    const attributes = parseXmlAttributes(match[1] ?? '');
    const blockId = attributes.id;
    const language = attributes.lang;
    if (!blockId || !language) continue;
    if (metadata.has(blockId)) {
      throw invalidResponseError(`lark-cli full XML readback repeated Code block ID ${blockId}.`);
    }
    metadata.set(blockId, {
      language,
      ...(attributes.caption !== undefined ? { caption: attributes.caption.replace(/\n+$/g, '') } : {}),
    });
  }
  return metadata;
}

function parseXmlAttributes(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map((match) => [
    match[1]!,
    decodeXmlEntities(match[2] ?? ''),
  ]));
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function invalidResponseError(message: string): LarkCliProviderError {
  return new LarkCliProviderError({
    type: 'internal',
    subtype: 'lark_cli_invalid_response',
    message,
    retryable: false,
  });
}

function createdChildrenFromData(data: unknown): CreatedChildrenResult {
  if (!isRecord(data) || !Array.isArray(data.children)) {
    throw new Error('lark-cli Docx children create did not return structured data.');
  }
  const blocks = data.children.filter(isProviderBlock);
  if (
    blocks.length === 0
    || blocks.length !== data.children.length
    || blocks.some((block) => typeof block.block_id !== 'string')
  ) {
    throw new Error('lark-cli Docx children create did not return created block identities.');
  }
  const revision = revisionFromData(data);
  return {
    blocks,
    ...(revision ? { revision } : {}),
    ...(typeof data.client_token === 'string' ? { clientToken: data.client_token } : {}),
  };
}

function createdDocumentFromData(data: unknown): CreatedDocumentResult {
  if (!isRecord(data) || !isRecord(data.document)) {
    throw new Error('lark-cli docs +create did not return data.document.');
  }
  const documentId = typeof data.document.document_id === 'string'
    ? data.document.document_id
    : undefined;
  if (!documentId) {
    throw new Error('lark-cli docs +create did not return document.document_id.');
  }
  const revision = revisionFromData(data);
  return {
    documentId,
    ...(typeof data.document.url === 'string' ? { url: data.document.url } : {}),
    ...(revision ? { revision } : {}),
  };
}

function revisionFromData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct = data.document_revision_id ?? data.revision;
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
  if (!isRecord(data.document)) return undefined;
  const nested = data.document.revision_id;
  return typeof nested === 'string' || typeof nested === 'number'
    ? String(nested)
    : undefined;
}

function whiteboardRawFromData(data: unknown): unknown {
  let raw: unknown;
  if (Array.isArray(data)) raw = data;
  else if (typeof data === 'string') raw = parseEmbeddedJson(data);
  else if (!isRecord(data)) throw whiteboardRawNotReadyError();
  else if ('raw' in data) {
    if (data.raw === undefined || data.raw === null) throw whiteboardRawNotReadyError();
    raw = data.raw;
  } else if (typeof data.content === 'string') raw = parseEmbeddedJson(data.content);
  else if ('nodes' in data || Object.keys(data).length > 0) raw = data;
  else throw whiteboardRawNotReadyError();

  if (Array.isArray(raw)) {
    if (raw.length === 0) throw whiteboardRawNotReadyError();
    return raw;
  }
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
    throw new Error('lark-cli whiteboard +query did not return raw node state.');
  }
  if (raw.nodes.length === 0) throw whiteboardRawNotReadyError();
  return raw;
}

function whiteboardRawNotReadyError(): LarkCliProviderError {
  return new LarkCliProviderError({
    type: 'verification',
    subtype: 'whiteboard_raw_not_ready',
    message: 'lark-cli whiteboard +query succeeded before raw node state was ready.',
    retryable: false,
  });
}

function parseEmbeddedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('lark-cli whiteboard +query returned invalid raw JSON.');
  }
}

function encodeProviderLinkUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeProviderLinkUrls);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'link' && isRecord(child) && typeof child.url === 'string') {
      return [key, {
        ...child,
        url: encodeURIComponent(normalizeAbsoluteUrl(child.url)),
      }];
    }
    return [key, encodeProviderLinkUrls(child)];
  }));
}

function normalizeAbsoluteUrl(value: string): string {
  if (isAbsoluteHttpUrl(value)) return value;
  try {
    const decoded = decodeURIComponent(value);
    return isAbsoluteHttpUrl(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isProviderBlock(value: unknown): value is ProviderBlock {
  return isRecord(value) && typeof value.block_type === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
