import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';

describe('LarkCliAdapter', () => {
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

  it('throws a concise error when lark-cli returns an error envelope', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: '',
        stderr: JSON.stringify({ ok: false, error: { message: 'permission denied' } })
      })
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'doc_token' })).rejects.toThrow('lark-cli failed: permission denied');
  });
});
