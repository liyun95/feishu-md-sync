import { describe, expect, it, vi } from 'vitest';
import { FeishuClient, FeishuApiError } from '../src/feishu/client.js';
import { FeishuTokenProvider } from '../src/feishu/token.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

describe('FeishuClient', () => {
  it('fetches and caches auth tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      tenant_access_token: 'tenant-token',
      expire: 7200
    }));
    const provider = new FeishuTokenProvider({
      appId: 'app',
      appSecret: 'secret',
      fetchImpl
    });

    await expect(provider.token()).resolves.toBe('tenant-token');
    await expect(provider.token()).resolves.toBe('tenant-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires credentials before auth', async () => {
    const provider = new FeishuTokenProvider({
      appId: '',
      appSecret: '',
      fetchImpl: vi.fn()
    });

    await expect(provider.token()).rejects.toThrow(/Missing APP_ID/);
  });

  it('throws on auth failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 999, msg: 'bad secret' }));
    const provider = new FeishuTokenProvider({
      appId: 'app',
      appSecret: 'secret',
      fetchImpl
    });

    await expect(provider.token()).rejects.toThrow(/auth failed/);
  });

  it('paginates block reads', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { items: [{ block_id: 'a', block_type: 1 }], has_more: true, page_token: 'next' }
      }))
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: { items: [{ block_id: 'b', block_type: 2 }], has_more: false }
      }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.getDocumentBlocks('doc')).resolves.toHaveLength(2);
    expect(fetchImpl.mock.calls[1][0]).toContain('page_token=next');
  });

  it('resolves wiki node tokens to docx object tokens', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      data: { node: { obj_type: 'docx', obj_token: 'DocxObjToken123456789' } }
    }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.resolveWikiNode('WikiNode123456789')).resolves.toBe('DocxObjToken123456789');
    expect(fetchImpl.mock.calls[0][0]).toContain('/open-apis/wiki/v2/spaces/get_node?token=WikiNode123456789');
  });

  it('rejects wiki nodes that are not docx objects', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      data: { node: { obj_type: 'sheet', obj_token: 'SheetObjToken123456789' } }
    }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.resolveWikiNode('WikiNode123456789')).rejects.toThrow(/not docx/);
  });

  it('deletes child ranges and creates children in batches', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(
      jsonResponse({ code: 0, data: { children: [{ block_id: 'created', block_type: 2 }] } })
    ));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await client.deleteChildren('doc', 'page', 1, 3);
    const created = await client.createChildren(
      'doc',
      'page',
      Array.from({ length: 51 }, () => ({ block_type: 2, children: ['nested'], text: { elements: [] } }))
    );

    expect(created).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toContain('/children/batch_delete');
    const firstCreateBody = JSON.parse(fetchImpl.mock.calls[1][1]?.body as string);
    expect(firstCreateBody.children).toHaveLength(50);
    expect(firstCreateBody.children[0]).not.toHaveProperty('children');
  });

  it('creates tables without inline cells and then populates returned cell blocks', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        code: 0,
        data: {
          children: [{
            block_id: 'table-1',
            block_type: 31,
            table: { cells: ['cell-1'], property: { row_size: 1, column_size: 1 } }
          }]
        }
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { children: [{ block_id: 'cell-text', block_type: 2 }] } }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await client.createChildren('doc', 'page', [{
      block_type: 31,
      table: {
        property: { row_size: 1, column_size: 1, merge_info: [null] },
        cells: [{ block_type: 2, text: { elements: [] } }]
      }
    }]);

    const tableBody = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(tableBody.children[0].table).toEqual({ property: { row_size: 1, column_size: 1 } });
    const cellBody = JSON.parse(fetchImpl.mock.calls[1][1]?.body as string);
    expect(fetchImpl.mock.calls[1][0]).toContain('/blocks/cell-1/children');
    expect(cellBody).toEqual({ children: [{ block_type: 2, text: { elements: [] } }], index: 0 });
  });

  it('throws on 429 API responses', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 99991429, msg: 'rate limited' }, { status: 429 }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.getDocumentBlocks('doc')).rejects.toMatchObject({
      name: 'FeishuApiError',
      code: 99991429,
      status: 429
    });
  });

  it('throws on malformed JSON', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not-json', { status: 200 }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.getDocumentBlocks('doc')).rejects.toBeInstanceOf(FeishuApiError);
  });

  it('throws on timeout', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;
    const client = new FeishuClient({ tokenProvider, fetchImpl, timeoutMs: 1 });

    await expect(client.getDocumentBlocks('doc')).rejects.toThrow(/timed out/);
  });
});
