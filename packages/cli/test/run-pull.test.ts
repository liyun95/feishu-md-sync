import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { readPullReceipt } from '../src/receipts/pull-receipt.js';
import { hashText } from '../src/receipts/publish-receipt.js';
import { runPull } from '../src/pull/run-pull.js';

describe('runPull', () => {
  it('emits canonical Feishu Code block languages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-code-'));
    const output = join(dir, 'doc.remote.md');

    await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: '```py\nprint(1)\n```\n' }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('```python\nprint(1)\n```\n');
  });

  it('canonicalizes remote Callouts while retaining the raw remote hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-'));
    const output = join(dir, 'doc.remote.md');
    const remoteMarkdown = '<callout emoji="📘">\nNotes\nUse load-time CPU adaptation.\n</callout>';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '291' }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'wiki', token: 'wiki_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(
      '<div class="alert note">\n\nUse load-time CPU adaptation.\n\n</div>'
    );
    expect(result.remoteRawHash).toBe(hashText(remoteMarkdown));
    expect(result.outputHash).toBe(hashText(
      '<div class="alert note">\n\nUse load-time CPU adaptation.\n\n</div>'
    ));
  });

  it('recognizes configured Chinese Callout titles and omits the presentation title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '<callout emoji="❗">\n警告\n不要在生产环境运行。\n</callout>'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      callouts: { noteTitle: '说明', warningTitle: '警告' },
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(
      '<div class="alert warning">\n\n不要在生产环境运行。\n\n</div>'
    );
  });

  it('normalizes paragraph-wrapped Callout payloads without dropping the body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-paragraphs-'));
    const output = join(dir, 'doc.remote.md');
    const remoteMarkdown = '<callout emoji="📘"><p>Notes</p>' +
      '<p>In this example, the JSON field allows null values with <code>nullable=True</code>. ' +
      'For details, refer to <cite doc-id="nullable" title="Nullable Fields"></cite>.</p></callout>';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '1365' }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'wiki', token: 'wiki_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(
      '<div class="alert note">\n\n' +
      'In this example, the JSON field allows null values with <code>nullable=True</code>. ' +
      'For details, refer to <cite doc-id="nullable" title="Nullable Fields"></cite>.\n\n' +
      '</div>'
    );
    expect(result.warnings).toContain(
      'remote Callout 1 used paragraph-wrapped title/body compatibility normalization'
    );
  });

  it('uses a Docx block type hint for a paragraph-wrapped custom Callout title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-hint-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      resolveDocumentId: async () => 'doc_token',
      fetchDocMarkdown: async () => ({
        markdown: '<callout><p>Team convention</p><p>Keep this body wrapped.</p></callout>'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
        {
          block_id: 'callout1',
          block_type: 19,
          callout: { emoji_id: '📘' },
          children: ['title1', 'body1']
        },
        pullTextBlock('title1', 'Team convention'),
        pullTextBlock('body1', 'Keep this body wrapped.')
      ] }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'wiki', token: 'wiki_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(
      '<div class="alert note">\n\nKeep this body wrapped.\n\n</div>'
    );
    expect(result.warnings).toContain('remote Callout types were resolved from Docx block metadata');
  });

  it('fails closed when a remote Callout title cannot be identified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '<callout emoji="📘">\nTeam convention\nKeep this body wrapped.\n</callout>'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    })).rejects.toThrow('Cannot identify remote Callout type from title "Team convention".');
  });

  it('fails closed when Docx block metadata also cannot identify the Callout type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-callout-unidentified-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '<callout><p>Team convention</p><p>Keep this body wrapped.</p></callout>'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
        { block_id: 'callout1', block_type: 19, callout: {}, children: ['title1', 'body1'] },
        pullTextBlock('title1', 'Team convention'),
        pullTextBlock('body1', 'Keep this body wrapped.')
      ] }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    })).rejects.toThrow('Cannot identify remote Callout type from title "Team convention".');
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a profile-transformed remote snapshot and verifies the local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: '# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
        revision: '11'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'milvus',
      overwrite: false,
      writeReceipt: false,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('# Title\n\nMilvus stores vectors.');
    expect(result).toMatchObject({
      mode: 'write',
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'milvus',
      remoteRevision: '11',
      warnings: []
    });
    expect(result.receiptPath).toBeUndefined();
  });

  it('refuses to overwrite an existing output before fetching the remote document', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    await writeFile(output, 'existing local snapshot', 'utf8');
    let fetches = 0;
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => {
        fetches += 1;
        return { markdown: 'Remote' };
      },
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    await expect(runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter
    })).rejects.toThrow('Refusing to overwrite existing output without --overwrite');
    expect(fetches).toBe(0);
  });

  it('overwrites when requested and writes an independent pull snapshot receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-'));
    const output = join(dir, 'doc.remote.md');
    await writeFile(output, 'existing local snapshot', 'utf8');
    const remoteMarkdown = '# Title\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({
        markdown: remoteMarkdown,
        revision: '12'
      }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'zilliz',
      overwrite: true,
      writeReceipt: true,
      adapter
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('# Title\n\nZilliz Cloud stores vectors.');
    expect(result.receiptPath).toContain('/.sync/feishu-md-sync/pulls/');
    await expect(readPullReceipt({
      cwd: dir,
      outputPath: result.outputPath,
      target: { kind: 'docx', token: 'doc_token' }
    })).resolves.toMatchObject({
      kind: 'pull-snapshot',
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: 'doc.remote.md',
      profile: 'zilliz',
      remoteRevision: '12',
      remoteRawHash: hashText(remoteMarkdown),
      outputHash: hashText('# Title\n\nZilliz Cloud stores vectors.')
    });
  });
});

function pullTextBlock(blockId: string, content: string) {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content, text_element_style: {} } }]
    }
  };
}
