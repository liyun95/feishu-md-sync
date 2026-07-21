import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFeishuDocxEngine,
  LarkCliProviderError,
  LarkCliTransport,
  type DocxTransport,
  type LarkCliExecInput,
  type LarkCliExecResult,
} from '../src/index.js';

type RecordedCall = {
  args: string[];
  stdin?: string;
};

describe('LarkCliTransport', () => {
  it('verifies Code replacements when the blocks API omits language and caption metadata', async () => {
    const calls: RecordedCall[] = [];
    let revision = 1;
    let content = 'print("old")';
    let language = 'python';
    let caption = 'Example';
    const transport = createTransport(calls, async (args, input) => {
      if (args[0] === 'docs' && args[1] === '+update') {
        const xml = input?.stdin ?? '';
        content = xml.match(/<code>([\s\S]*)<\/code>/)?.[1] ?? content;
        language = xml.match(/lang="([^"]+)"/)?.[1] ?? language;
        caption = xml.match(/caption="([^"]+)"/)?.[1] ?? caption;
        revision += 1;
        return json({ document: { revision_id: revision } });
      }
      if (args[0] === 'docs' && args[1] === '+fetch') {
        return json({
          document: {
            revision_id: revision,
            content: `<pre id="code1" lang="${language}" caption="${caption}"><code>${content}</code></pre>`,
          },
        });
      }
      if (args[2] === '/open-apis/docx/v1/documents/doc_token') {
        return json({ document: { revision_id: revision } });
      }
      return json({
        items: [
          { block_id: 'doc_token', block_type: 1, children: ['code1'] },
          {
            block_id: 'code1', parent_id: 'doc_token', block_type: 14,
            code: {
              elements: [{ text_run: { content, text_element_style: {} } }],
              style: { wrap: false },
            },
          },
        ],
        has_more: false,
      });
    }, 'bot');
    const engine = createFeishuDocxEngine({ transport });
    const snapshot = await engine.snapshot({ kind: 'docx', token: 'doc_token' });
    const code = snapshot.nodes.find((node) => node.blockId === 'code1')!;

    await expect(engine.apply({
      batch: engine.prepare({
        snapshot,
        operations: [{
          operationId: 'replace-code',
          kind: 'replace',
          targetBlockId: 'code1',
          expectedHash: code.canonicalHash,
          desired: { kind: 'code', language: 'go', text: 'print("local")', caption: 'Example' },
        }],
        idempotencyNamespace: 'code-metadata-readback',
      }),
      journal: { recordVerified: async () => {} },
    })).resolves.toMatchObject({
      operations: [{ operationId: 'replace-code', verified: true }],
    });
    expect(calls.filter(({ args }) => args[0] === 'docs' && args[1] === '+fetch').map(({ args }) =>
      args[args.indexOf('--revision-id') + 1]
    )).toEqual(['1', '1', '1', '2']);
  });

  it('fails closed when full XML Code metadata is not from the pinned blocks revision', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async (args) => {
      if (args[0] === 'docs' && args[1] === '+fetch') {
        return json({
          document: {
            revision_id: 43,
            content: '<pre id="code1" lang="python"><code>print(1)</code></pre>',
          },
        });
      }
      if (args[2] === '/open-apis/docx/v1/documents/doc_token') {
        return json({ document: { revision_id: 42 } });
      }
      return json({
        items: [
          { block_id: 'doc_token', block_type: 1, children: ['code1'] },
          {
            block_id: 'code1', parent_id: 'doc_token', block_type: 14,
            code: {
              elements: [{ text_run: { content: 'print(1)', text_element_style: {} } }],
              style: { wrap: false },
            },
          },
        ],
        has_more: false,
      });
    });

    const failure = await transport.fetchBlocks('doc_token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LarkCliProviderError);
    expect((failure as LarkCliProviderError).details).toMatchObject({
      type: 'internal',
      subtype: 'lark_cli_invalid_response',
      message: 'lark-cli full XML readback returned revision 43; expected 42.',
    });
  });

  it('resolves direct docx selectors and docx URLs without invoking lark-cli', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({}));

    await expect(transport.resolveDocument({ kind: 'docx', token: 'doc_token' }))
      .resolves.toEqual({ documentId: 'doc_token' });
    await expect(transport.resolveDocument({
      kind: 'url',
      url: 'https://example.feishu.cn/docx/docFromUrl?from=wiki',
    })).resolves.toEqual({ documentId: 'docFromUrl' });
    await expect(transport.resolveDocument({
      kind: 'url',
      url: 'https://example.feishu.cn/docs/docFromLegacyUrl',
    })).resolves.toEqual({ documentId: 'docFromLegacyUrl' });

    expect(calls).toEqual([]);
  });

  it('resolves Wiki selectors and Wiki URLs through the official Wiki API', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({
      node: { obj_type: 'docx', obj_token: 'doc_resolved' },
    }), 'user');

    await expect(transport.resolveDocument({ kind: 'wiki', token: 'wiki_token' }))
      .resolves.toEqual({ documentId: 'doc_resolved' });
    await expect(transport.resolveDocument({
      kind: 'url',
      url: 'https://example.feishu.cn/wiki/wikiFromUrl#heading',
    })).resolves.toEqual({ documentId: 'doc_resolved' });

    expect(calls).toEqual([
      {
        args: [
          'api',
          'GET',
          '/open-apis/wiki/v2/spaces/get_node',
          '--params',
          '{"token":"wiki_token"}',
          '--format',
          'json',
          '--as',
          'user',
        ],
        stdin: undefined,
      },
      {
        args: [
          'api',
          'GET',
          '/open-apis/wiki/v2/spaces/get_node',
          '--params',
          '{"token":"wikiFromUrl"}',
          '--format',
          'json',
          '--as',
          'user',
        ],
        stdin: undefined,
      },
    ]);
  });

  it('pins all block pages to the revision returned by document metadata', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async (args) => {
      if (args[2] === '/open-apis/docx/v1/documents/doc_token') {
        return json({ document: { revision_id: 42 } });
      }
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as {
        page_token?: string;
      };
      return params.page_token
        ? json({
            items: [{ block_id: 'p1', parent_id: 'page', block_type: 2 }],
            has_more: false,
          })
        : json({
            items: [{ block_id: 'page', block_type: 1, children: ['p1'] }],
            has_more: true,
            page_token: 'next',
          });
    }, 'bot');

    await expect(transport.fetchBlocks('doc_token')).resolves.toEqual({
      revision: '42',
      blocks: [
        { block_id: 'page', block_type: 1, children: ['p1'] },
        { block_id: 'p1', parent_id: 'page', block_type: 2 },
      ],
    });
    expect(calls.map(({ args }) => args)).toEqual([
      [
        'api',
        'GET',
        '/open-apis/docx/v1/documents/doc_token',
        '--format',
        'json',
        '--as',
        'bot',
      ],
      [
        'api',
        'GET',
        '/open-apis/docx/v1/documents/doc_token/blocks',
        '--params',
        '{"page_size":500,"document_revision_id":42}',
        '--format',
        'json',
        '--as',
        'bot',
      ],
      [
        'api',
        'GET',
        '/open-apis/docx/v1/documents/doc_token/blocks',
        '--params',
        '{"page_size":500,"document_revision_id":42,"page_token":"next"}',
        '--format',
        'json',
        '--as',
        'bot',
      ],
    ]);
  });

  it('fails closed when document metadata does not contain a revision', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({ document: {} }));

    const failure = await transport.fetchBlocks('doc_token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LarkCliProviderError);
    expect((failure as LarkCliProviderError).details).toMatchObject({
      type: 'internal',
      subtype: 'lark_cli_invalid_response',
      message: 'lark-cli Docx document metadata did not return document.revision_id.',
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['non-object data', null],
    ['non-array items', { items: {}, has_more: false }],
    ['a malformed block', { items: [{ block_id: 'p1' }], has_more: false }],
    ['a non-boolean has_more', { items: [], has_more: 'false' }],
    ['has_more without a cursor', { items: [], has_more: true }],
    ['a final page with a cursor', { items: [], has_more: false, page_token: 'unexpected' }],
  ])('rejects a malformed block page with %s', async (_description, pageData) => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async (args) => {
      return args[2] === '/open-apis/docx/v1/documents/doc_token'
        ? json({ document: { revision_id: 42 } })
        : json(pageData);
    });

    const failure = await transport.fetchBlocks('doc_token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LarkCliProviderError);
    expect((failure as LarkCliProviderError).details).toMatchObject({
      type: 'internal',
      subtype: 'lark_cli_invalid_response',
    });
  });

  it('rejects a repeated page cursor before requesting it again', async () => {
    const calls: RecordedCall[] = [];
    let blockPageCalls = 0;
    const transport = createTransport(calls, async (args) => {
      if (args[2] === '/open-apis/docx/v1/documents/doc_token') {
        return json({ document: { revision_id: 42 } });
      }
      blockPageCalls += 1;
      if (blockPageCalls > 2) throw new Error('test loop guard reached');
      return json({
        items: [],
        has_more: true,
        page_token: 'repeated',
      });
    });

    const failure = await transport.fetchBlocks('doc_token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LarkCliProviderError);
    expect((failure as LarkCliProviderError).details).toMatchObject({
      type: 'internal',
      subtype: 'lark_cli_invalid_response',
      message: 'lark-cli Docx block list repeated page_token repeated.',
    });
    expect(blockPageCalls).toBe(2);
  });

  it('replaces and inserts XML through stdin while passing Markdown inline', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({
      document: { revision_id: 9 },
    }), 'user');

    await expect(transport.replaceBlock({
      documentId: 'doc_token',
      blockId: 'table1',
      content: '<table><tr><td>Value</td></tr></table>',
      format: 'xml',
    })).resolves.toEqual({ revision: '9' });
    await expect(transport.insertAfter({
      documentId: 'doc_token',
      blockId: 'p1',
      content: '- New item',
      format: 'markdown',
    })).resolves.toEqual({ revision: '9' });

    expect(calls).toEqual([
      {
        args: [
          'docs', '+update', '--doc', 'doc_token', '--command', 'block_replace',
          '--block-id', 'table1', '--doc-format', 'xml', '--content', '-',
          '--format', 'json', '--as', 'user',
        ],
        stdin: '<table><tr><td>Value</td></tr></table>',
      },
      {
        args: [
          'docs', '+update', '--doc', 'doc_token', '--command', 'block_insert_after',
          '--block-id', 'p1', '--doc-format', 'markdown', '--content', '- New item',
          '--format', 'json', '--as', 'user',
        ],
        stdin: undefined,
      },
    ]);
  });

  it('creates child blocks with an idempotency token and provider-encoded links', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({
      children: [{ block_id: 'child-1', parent_id: 'parent-1', block_type: 2 }],
      client_token: 'token-1',
      document_revision_id: 10,
    }), 'user');

    await expect(transport.createChildren({
      documentId: 'doc_token',
      parentBlockId: 'parent-1',
      index: 2,
      clientToken: 'token-1',
      blocks: [{
        block_type: 2,
        text: {
          elements: [
            {
              text_run: {
                content: 'first',
                text_element_style: { link: { url: 'https://example.com/nested?q=one' } },
              },
            },
            {
              text_run: {
                content: 'second',
                text_element_style: { link: { url: 'https%3A%2F%2Fexample.com%2Falready' } },
              },
            },
          ],
        },
      }],
    })).resolves.toEqual({
      blocks: [{ block_id: 'child-1', parent_id: 'parent-1', block_type: 2 }],
      revision: '10',
      clientToken: 'token-1',
    });
    expect(calls).toEqual([{
      args: [
        'api',
        'POST',
        '/open-apis/docx/v1/documents/doc_token/blocks/parent-1/children',
        '--params',
        '{"document_revision_id":-1,"client_token":"token-1"}',
        '--data',
        '{"index":2,"children":[{"block_type":2,"text":{"elements":[{"text_run":{"content":"first","text_element_style":{"link":{"url":"https%3A%2F%2Fexample.com%2Fnested%3Fq%3Done"}}}},{"text_run":{"content":"second","text_element_style":{"link":{"url":"https%3A%2F%2Fexample.com%2Falready"}}}}]}}]}',
        '--format',
        'json',
        '--as',
        'user',
      ],
      stdin: undefined,
    }]);
  });

  it('moves and deletes blocks through exact docs update commands', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async () => json({ result: 'success' }), 'bot');

    await transport.moveAfter({
      documentId: 'doc_token',
      anchorBlockId: 'anchor',
      blockIds: ['p2', 'p3'],
    });
    await transport.deleteBlocks({ documentId: 'doc_token', blockIds: ['p4', 'p5'] });

    expect(calls).toEqual([
      {
        args: [
          'docs', '+update', '--doc', 'doc_token', '--command', 'block_move_after',
          '--block-id', 'anchor', '--src-block-ids', 'p2,p3', '--format', 'json', '--as', 'bot',
        ],
        stdin: undefined,
      },
      {
        args: [
          'docs', '+update', '--doc', 'doc_token', '--command', 'block_delete',
          '--block-id', 'p4,p5', '--format', 'json', '--as', 'bot',
        ],
        stdin: undefined,
      },
    ]);
  });

  it('creates a Markdown document under an explicit parent token', async () => {
    const calls: RecordedCall[] = [];
    const transport: DocxTransport = createTransport(calls, async () => json({
      document: {
        document_id: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created',
        revision_id: 1,
      },
    }), 'bot');

    await expect(transport.createDocument({
      title: 'Doc Title',
      markdown: '# Doc Title\n\nBody\n',
      parentToken: 'parent-token',
    })).resolves.toEqual({
      documentId: 'doc_created',
      url: 'https://example.feishu.cn/docx/doc_created',
      revision: '1',
    });
    expect(calls).toEqual([{
      args: [
        'docs', '+create', '--title', 'Doc Title', '--doc-format', 'markdown',
        '--content', '# Doc Title\n\nBody\n', '--parent-token', 'parent-token',
        '--format', 'json', '--as', 'bot',
      ],
      stdin: undefined,
    }]);
  });

  it('queries raw Whiteboard state and overwrites Whiteboards from raw and SVG stdin', async () => {
    const calls: RecordedCall[] = [];
    const transport = createTransport(calls, async (args) => {
      return args[1] === '+query'
        ? json({ raw: { nodes: [{ id: 'node-1', text: 'CAGRA' }] } })
        : json({ result: 'success' });
    }, 'user');

    await expect(transport.queryWhiteboard('wb_token')).resolves.toEqual({
      nodes: [{ id: 'node-1', text: 'CAGRA' }],
    });
    await transport.overwriteWhiteboard({
      token: 'wb_token',
      format: 'raw',
      value: { nodes: [{ id: 'node-2', text: 'HNSW' }] },
      idempotencyToken: 'raw-token',
    });
    await transport.overwriteWhiteboard({
      token: 'wb_token',
      format: 'svg',
      value: '<svg><text>CAGRA</text></svg>',
      idempotencyToken: 'svg-token',
    });

    expect(calls).toEqual([
      {
        args: [
          'whiteboard', '+query', '--whiteboard-token', 'wb_token', '--output_as', 'raw',
          '--format', 'json', '--as', 'user',
        ],
        stdin: undefined,
      },
      {
        args: [
          'whiteboard', '+update', '--whiteboard-token', 'wb_token', '--input_format', 'raw',
          '--source', '-', '--overwrite', '--idempotent-token', 'raw-token',
          '--format', 'json', '--as', 'user',
        ],
        stdin: '{"nodes":[{"id":"node-2","text":"HNSW"}]}',
      },
      {
        args: [
          'whiteboard', '+update', '--whiteboard-token', 'wb_token', '--input_format', 'svg',
          '--source', '-', '--overwrite', '--idempotent-token', 'svg-token',
          '--format', 'json', '--as', 'user',
        ],
        stdin: '<svg><text>CAGRA</text></svg>',
      },
    ]);
  });

  it('preserves the complete structured provider error envelope', async () => {
    const providerEnvelope = {
      type: 'authorization',
      subtype: 'missing_scope',
      code: 4003101,
      message: 'permission denied',
      hint: 'run lark-cli auth login --scope docx:document:readonly',
      retryable: false,
      missing_scopes: ['docx:document:readonly'],
      console_url: 'https://open.feishu.cn/app/cli_xxx/auth',
      request_id: 'request-1',
      details: { service: 'docx' },
    };
    const transport = new LarkCliTransport({
      exec: async () => ({
        stdout: '',
        stderr: JSON.stringify({ ok: false, identity: 'user', error: providerEnvelope }),
      }),
    });

    const failure = await transport.fetchBlocks('doc_token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LarkCliProviderError);
    expect((failure as LarkCliProviderError).envelope).toEqual(providerEnvelope);
    expect((failure as LarkCliProviderError).details).toEqual({
      type: 'authorization',
      subtype: 'missing_scope',
      providerCode: 4003101,
      message: 'permission denied',
      hint: 'run lark-cli auth login --scope docx:document:readonly',
      retryable: false,
      missingScopes: ['docx:document:readonly'],
      consoleUrl: 'https://open.feishu.cn/app/cli_xxx/auth',
    });
  });

  it('preserves the child process cause for structured nonzero stderr errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docx-engine-lark-cli-'));
    const executable = join(directory, 'lark-cli');
    const previousPath = process.env.PATH;
    try {
      await writeFile(executable, [
        '#!/bin/sh',
        'printf \'%s\' \'{"ok":false,"error":{"type":"authorization","subtype":"missing_scope","message":"permission denied","retryable":false,"request_id":"request-2"}}\' >&2',
        'exit 1',
        '',
      ].join('\n'));
      await chmod(executable, 0o755);
      process.env.PATH = directory;

      const failure = await new LarkCliTransport().fetchBlocks('doc_token')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LarkCliProviderError);
      expect((failure as LarkCliProviderError).envelope).toMatchObject({
        subtype: 'missing_scope',
        request_id: 'request-2',
      });
      expect((failure as Error).cause).toBeInstanceOf(Error);
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the ENOENT process cause when lark-cli is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'docx-engine-empty-path-'));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = directory;

      const failure = await new LarkCliTransport().fetchBlocks('doc_token')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(LarkCliProviderError);
      expect((failure as LarkCliProviderError).details).toMatchObject({
        type: 'config',
        subtype: 'lark_cli_missing',
      });
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    } finally {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createTransport(
  calls: RecordedCall[],
  response: (
    args: string[],
    input?: LarkCliExecInput,
  ) => Promise<LarkCliExecResult>,
  identity: 'auto' | 'bot' | 'user' = 'auto',
): LarkCliTransport {
  return new LarkCliTransport({
    identity,
    exec: async (args, input) => {
      calls.push({ args, stdin: input?.stdin });
      return response(args, input);
    },
  });
}

function json(data: unknown): Promise<LarkCliExecResult> {
  return Promise.resolve({
    stdout: JSON.stringify({ ok: true, data }),
    stderr: '',
  });
}
