import { execFile } from 'node:child_process';
import type { CreatedDocument, FeishuAdapter, RemoteMarkdown } from './feishu-adapter.js';

export type LarkCliExecResult = {
  stdout: string;
  stderr: string;
};

export type LarkCliExecutor = (args: string[]) => Promise<LarkCliExecResult>;
export type LarkCliIdentity = 'auto' | 'bot' | 'user';

export class LarkCliAdapter implements FeishuAdapter {
  private readonly exec: LarkCliExecutor;
  private readonly identity: LarkCliIdentity;

  constructor(input: { exec?: LarkCliExecutor; identity?: LarkCliIdentity } = {}) {
    this.exec = input.exec ?? runLarkCli;
    this.identity = input.identity ?? larkCliIdentityFromEnv();
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
}

function withIdentity(args: string[], identity: LarkCliIdentity): string[] {
  return identity === 'auto' ? args : [...args, '--as', identity];
}

function larkCliIdentityFromEnv(): LarkCliIdentity {
  const value = process.env.FEISHU_MD_SYNC_LARK_AS;
  return value === 'bot' || value === 'user' ? value : 'auto';
}

function runLarkCli(args: string[]): Promise<LarkCliExecResult> {
  return new Promise((resolve, reject) => {
    execFile('lark-cli', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseLarkCliJson(result: LarkCliExecResult): { ok?: boolean; data?: unknown; error?: { message?: string } } {
  const raw = result.stdout.trim() || result.stderr.trim();
  let parsed: { ok?: boolean; data?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; data?: unknown; error?: { message?: string } };
  } catch {
    throw new Error(`lark-cli returned non-JSON output: ${raw}`);
  }
  if (parsed.ok === false) {
    throw new Error(`lark-cli failed: ${parsed.error?.message ?? 'unknown error'}`);
  }
  return parsed;
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
