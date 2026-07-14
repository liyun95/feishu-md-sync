import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';

describe('LarkCliAdapter', () => {
  it('resolves docx targets without invoking lark-cli', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return { stdout: '{}', stderr: '' };
      }
    });

    await expect(adapter.resolveDocumentId({
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toBe('doc_token');
    expect(calls).toEqual([]);
  });

  it('resolves wiki nodes to their underlying docx token', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { node: { obj_type: 'docx', obj_token: 'doc_token' } }
          }),
          stderr: ''
        };
      }
    });

    await expect(adapter.resolveDocumentId({
      target: { kind: 'wiki', token: 'wiki_token' }
    })).resolves.toBe('doc_token');
    expect(calls).toEqual([[
      'api',
      'GET',
      '/open-apis/wiki/v2/spaces/get_node',
      '--params',
      '{"token":"wiki_token"}',
      '--format',
      'json'
    ]]);
  });

  it('fetches an existing doc as markdown through lark-cli docs +fetch', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ ok: true, data: { content: '# Remote\n' } }),
          stderr: ''
        };
      }
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'doc_token' })).resolves.toEqual({
      markdown: '# Remote\n',
      revision: undefined
    });
    expect(calls).toEqual([['docs', '+fetch', '--doc', 'doc_token', '--doc-format', 'markdown', '--format', 'json']]);
  });

  it('fetches document-shaped lark-cli responses and can force bot identity', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      identity: 'bot',
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ ok: true, data: { document: { content: '# Remote\n', revision_id: 4 } } }),
          stderr: ''
        };
      }
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'wiki_token' })).resolves.toEqual({
      markdown: '# Remote\n',
      revision: '4'
    });
    expect(calls).toEqual([['docs', '+fetch', '--doc', 'wiki_token', '--doc-format', 'markdown', '--format', 'json', '--as', 'bot']]);
  });

  it('overwrites an existing doc through lark-cli docs +update', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ ok: true, data: { document_id: 'doc_token' } }), stderr: '' };
      }
    });

    await adapter.replaceDocument({ doc: 'doc_token', markdown: '# Local\n' });

    expect(calls).toEqual([[
      'docs',
      '+update',
      '--doc',
      'doc_token',
      '--command',
      'overwrite',
      '--doc-format',
      'markdown',
      '--content',
      '# Local\n',
      '--format',
      'json'
    ]]);
  });

  it('fetches docx blocks through lark-cli raw api and paginates', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      identity: 'bot',
      exec: async (args) => {
        calls.push(args);
        const params = JSON.parse(args[args.indexOf('--params') + 1]) as { page_token?: string };
        if (!params.page_token) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [{ block_id: 'page', block_type: 1 }],
                has_more: true,
                page_token: 'next'
              }
            }),
            stderr: ''
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              items: [{ block_id: 'p1', block_type: 2 }],
              has_more: false
            }
          }),
          stderr: ''
        };
      }
    });

    await expect(adapter.fetchDocBlocks({ doc: 'doc_token' })).resolves.toEqual({
      blocks: [
        { block_id: 'page', block_type: 1 },
        { block_id: 'p1', block_type: 2 }
      ]
    });
    expect(calls).toEqual([
      [
        'api',
        'GET',
        '/open-apis/docx/v1/documents/doc_token/blocks',
        '--params',
        '{"page_size":500,"document_revision_id":-1}',
        '--format',
        'json',
        '--as',
        'bot'
      ],
      [
        'api',
        'GET',
        '/open-apis/docx/v1/documents/doc_token/blocks',
        '--params',
        '{"page_size":500,"document_revision_id":-1,"page_token":"next"}',
        '--format',
        'json',
        '--as',
        'bot'
      ]
    ]);
  });

  it('fetches Code language and caption metadata from full XML', async () => {
    const adapter = new LarkCliAdapter({
      identity: 'user',
      exec: async (args) => {
        expect(args).toEqual([
          'docs', '+fetch', '--doc', 'doc_token', '--doc-format', 'xml', '--detail', 'full',
          '--format', 'json', '--as', 'user'
        ]);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              document: {
                content: '<pre id="code1" caption="Example&#xA;" lang="python"><code>print(1)</code></pre>' +
                  '<pre id="code2" caption="&#xA;" lang="bash"><code>echo ok</code></pre>'
              }
            }
          }),
          stderr: ''
        };
      }
    });

    await expect(adapter.fetchDocCodeMetadata({ doc: 'doc_token' })).resolves.toEqual([
      { blockId: 'code1', language: 'python', caption: 'Example' },
      { blockId: 'code2', language: 'bash' }
    ]);
  });

  it('updates and moves blocks through format-aware lark-cli docs +update commands', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const adapter = new LarkCliAdapter({
      identity: 'bot',
      exec: async (args, input) => {
        calls.push({ args, stdin: input?.stdin });
        return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
      }
    });

    await adapter.replaceBlock({
      doc: 'doc_token',
      blockId: 'p1',
      content: '<table><tr><td>Value</td></tr></table>',
      format: 'xml'
    });
    await adapter.insertBlocksAfter({
      doc: 'doc_token',
      blockId: 'p1',
      content: '- New item',
      format: 'markdown'
    });
    await adapter.deleteBlocks({ doc: 'doc_token', blockIds: ['p2', 'p3'] });
    await adapter.moveBlocksAfter({ doc: 'doc_token', blockId: 'p1', sourceBlockIds: ['code1'] });

    expect(calls).toEqual([
      {
        args: [
          'docs', '+update', '--doc', 'doc_token', '--command', 'block_replace',
          '--block-id', 'p1', '--doc-format', 'xml', '--content', '-', '--format', 'json', '--as', 'bot'
        ],
        stdin: '<table><tr><td>Value</td></tr></table>'
      },
      { args: [
        'docs',
        '+update',
        '--doc',
        'doc_token',
        '--command',
        'block_insert_after',
        '--block-id',
        'p1',
        '--doc-format',
        'markdown',
        '--content',
        '- New item',
        '--format',
        'json',
        '--as',
        'bot'
      ], stdin: undefined },
      { args: [
        'docs',
        '+update',
        '--doc',
        'doc_token',
        '--command',
        'block_delete',
        '--block-id',
        'p2,p3',
        '--format',
        'json',
        '--as',
        'bot'
      ], stdin: undefined },
      { args: [
        'docs', '+update', '--doc', 'doc_token', '--command', 'block_move_after',
        '--block-id', 'p1', '--src-block-ids', 'code1', '--format', 'json', '--as', 'bot'
      ], stdin: undefined }
    ]);
  });

  it('inserts Callout XML through stdin', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const adapter = new LarkCliAdapter({
      identity: 'user',
      exec: async (args, input) => {
        calls.push({ args, stdin: input?.stdin });
        return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
      }
    });

    await adapter.insertBlocksAfter({
      doc: 'doc_token',
      blockId: 'p1',
      content: '<callout emoji="📘"><p>Notes</p><p>Body</p></callout>',
      format: 'xml'
    });

    expect(calls).toEqual([{
      args: [
        'docs', '+update', '--doc', 'doc_token', '--command', 'block_insert_after',
        '--block-id', 'p1', '--doc-format', 'xml', '--content', '-', '--format', 'json', '--as', 'user'
      ],
      stdin: '<callout emoji="📘"><p>Notes</p><p>Body</p></callout>'
    }]);
  });

  it('creates a Markdown doc under a parent token through lark-cli docs +create', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      identity: 'bot',
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              document: {
                document_id: 'doc_created',
                url: 'https://example.feishu.cn/docx/doc_created',
                revision_id: 1
              }
            }
          }),
          stderr: ''
        };
      }
    });

    await expect(adapter.createDocument({
      title: 'Doc Title',
      markdown: '# Doc Title\n\nBody\n',
      parentToken: 'parent-token'
    })).resolves.toEqual({
      documentId: 'doc_created',
      url: 'https://example.feishu.cn/docx/doc_created',
      revision: '1'
    });

    expect(calls).toEqual([[
      'docs',
      '+create',
      '--title',
      'Doc Title',
      '--doc-format',
      'markdown',
      '--content',
      '# Doc Title\n\nBody\n',
      '--parent-token',
      'parent-token',
      '--format',
      'json',
      '--as',
      'bot'
    ]]);
  });

  it('throws a concise error when lark-cli returns an error envelope', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: '',
        stderr: JSON.stringify({ ok: false, error: { message: 'permission denied' } })
      })
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'doc_token' })).rejects.toThrow('lark-cli failed: permission denied');
  });

  it('replaces an image block with an inline SVG Whiteboard and returns its identity', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const adapter = new LarkCliAdapter({
      identity: 'user',
      exec: async (args, input) => {
        calls.push({ args, stdin: input?.stdin });
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              document: {
                new_blocks: [{ block_id: 'wb_block', block_type: 'whiteboard', block_token: 'wb_token' }]
              }
            }
          }),
          stderr: ''
        };
      }
    });

    await expect(adapter.replaceImageWithWhiteboard({
      doc: 'doc_token',
      blockId: 'image_block',
      svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    })).resolves.toEqual({ blockId: 'wb_block', whiteboardToken: 'wb_token' });
    expect(calls).toEqual([{
      args: [
        'docs', '+update', '--doc', 'doc_token', '--command', 'block_replace', '--block-id', 'image_block',
        '--doc-format', 'xml', '--content', '-', '--format', 'json', '--as', 'user'
      ],
      stdin: '<whiteboard type="svg"><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></whiteboard>'
    }]);
  });

  it('queries raw Whiteboard state through the official shortcut', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      identity: 'user',
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ ok: true, data: { raw: { nodes: [{ id: 'node-1', text: 'CAGRA' }] } } }),
          stderr: ''
        };
      }
    });

    await expect(adapter.queryWhiteboard({ whiteboardToken: 'wb_token' })).resolves.toEqual({
      raw: { nodes: [{ id: 'node-1', text: 'CAGRA' }] }
    });
    expect(calls).toEqual([[
      'whiteboard', '+query', '--whiteboard-token', 'wb_token', '--output_as', 'raw', '--format', 'json', '--as', 'user'
    ]]);
  });

  it('rejects an empty raw Whiteboard query result', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: JSON.stringify({ ok: true, data: { raw: undefined } }),
        stderr: ''
      })
    });

    await expect(adapter.queryWhiteboard({ whiteboardToken: 'wb_token' }))
      .rejects.toThrow('lark-cli whiteboard +query did not return raw node state');
  });

  it('rejects raw Whiteboard metadata without a nodes array', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: JSON.stringify({ ok: true, data: { raw: { version: 1 } } }),
        stderr: ''
      })
    });

    await expect(adapter.queryWhiteboard({ whiteboardToken: 'wb_token' }))
      .rejects.toThrow('lark-cli whiteboard +query did not return raw node state');
  });

  it('updates a Whiteboard from SVG through stdin with overwrite and idempotency', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const adapter = new LarkCliAdapter({
      identity: 'bot',
      exec: async (args, input) => {
        calls.push({ args, stdin: input?.stdin });
        return { stdout: JSON.stringify({ ok: true, data: { result: 'success' } }), stderr: '' };
      }
    });

    await adapter.updateWhiteboard({
      whiteboardToken: 'wb_token',
      svg: '<svg viewBox="0 0 10 10"><text>CAGRA</text></svg>',
      idempotencyToken: 'fms-1234567890'
    });

    expect(calls).toEqual([{
      args: [
        'whiteboard', '+update', '--whiteboard-token', 'wb_token', '--input_format', 'svg', '--source', '-',
        '--overwrite', '--idempotent-token', 'fms-1234567890', '--format', 'json', '--as', 'bot'
      ],
      stdin: '<svg viewBox="0 0 10 10"><text>CAGRA</text></svg>'
    }]);
  });

  it('rejects ambiguous Whiteboard identities returned by document update', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: JSON.stringify({
          ok: true,
          data: {
            document: {
              new_blocks: [
                { block_id: 'wb1', block_type: 'whiteboard', block_token: 'token1' },
                { block_id: 'wb2', block_type: 43, block_token: 'token2' }
              ]
            }
          }
        }),
        stderr: ''
      })
    });

    await expect(adapter.replaceImageWithWhiteboard({
      doc: 'doc_token',
      blockId: 'image_block',
      svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    })).rejects.toThrow('lark-cli docs +update returned 2 Whiteboard blocks; expected exactly one');
  });
});
