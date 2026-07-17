import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import type { FeishuBlock } from '../src/feishu/types.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { readPullReceipt } from '../src/receipts/pull-receipt.js';
import { hashText } from '../src/receipts/publish-receipt.js';
import { runPull } from '../src/pull/run-pull.js';

describe('runPull', () => {
  it('reconstructs nested list child paragraphs from the native block tree when lark-cli Markdown is lossy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-nested-tree-'));
    const output = join(dir, 'doc.remote.md');
    const desiredList = `- **Parent one**

    Child one.

    Child two.

- **Parent two**

    Leading paragraph.

    - Nested one.

    - Nested two.

    Trailing paragraph.

- **Parent three**

    Only child.`;
    const lossyList = `- **Parent one**Child one.Child two.

- **Parent two**Leading paragraph.Trailing paragraph.

    - Nested one.

    - Nested two.

- **Parent three**Only child.`;
    const remoteMarkdown = `## Before

${lossyList}

## After

Stable paragraph.`;
    const expected = `## Before

${desiredList}

## After

Stable paragraph.`;
    const tree = materializePullTree(desiredList, 'nested');

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '44' }),
        fetchDocBlocks: async () => ({
          blocks: [
            { block_id: 'doc_token', block_type: 1, children: tree.roots.map((block) => block.block_id!) },
            ...tree.roots,
            ...tree.descendants
          ]
        }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(expected);
    expect(result.remoteRevision).toBe('44');
    expect(result.remoteRawHash).toBe(hashText(remoteMarkdown));
    expect(result.warnings).toContain('reconstructed nested list hierarchy from Docx block API');
  });

  it('reconstructs the compact two-space nested list serialization observed at revision 44', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-nested-tree-'));
    const output = join(dir, 'doc.remote.md');
    const desiredList = `- **Parent one**

    Child one.

    Child two.

- **Parent two**

    Leading paragraph.

    - Nested one.

    - Nested two.

    - Nested three.

    Trailing paragraph one.

    Trailing paragraph two.

- **Parent three**

    Only child.`;
    const compactLossyList = `- **Parent one**Child one.Child two.
- **Parent two**Leading paragraph.Trailing paragraph one.Trailing paragraph two.

  - Nested one.
  - Nested two.
  - Nested three.
- **Parent three**Only child.`;
    const remoteMarkdown = `Opening paragraph.

${compactLossyList}

![Flow](remote-whiteboard)

Following paragraph.`;
    const expected = `Opening paragraph.

${desiredList}

![Flow](remote-whiteboard)

Following paragraph.`;
    const tree = materializePullTree(desiredList, 'revision44');

    const result = await runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: remoteMarkdown, revision: '44' }),
        fetchDocBlocks: async () => ({
          blocks: [
            { block_id: 'doc_token', block_type: 1, children: tree.roots.map((block) => block.block_id!) },
            ...tree.roots,
            ...tree.descendants
          ]
        }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(expected);
    expect(result.warnings).toEqual(['reconstructed nested list hierarchy from Docx block API']);
  });

  it('keeps an already-correct nested list and resolves wiki targets before block reconstruction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-nested-tree-'));
    const output = join(dir, 'doc.remote.md');
    const desired = `- **Parent**

    Child paragraph.

    - Nested bullet.

    Trailing paragraph.`;
    const tree = materializePullTree(desired, 'correct');
    const resolved: string[] = [];
    const result = await runPull({
      cwd: dir,
      target: { kind: 'wiki', token: 'wiki_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter: {
        resolveDocumentId: async ({ target }) => {
          resolved.push(target.token);
          return 'doc_token';
        },
        fetchDocMarkdown: async () => ({ markdown: desired, revision: '44' }),
        fetchDocBlocks: async ({ doc }) => {
          expect(doc).toBe('doc_token');
          return {
            blocks: [
              { block_id: 'doc_token', block_type: 1, children: tree.roots.map((block) => block.block_id!) },
              ...tree.roots,
              ...tree.descendants
            ]
          };
        },
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    });

    await expect(readFile(output, 'utf8')).resolves.toBe(desired);
    expect(resolved).toEqual(['wiki_token']);
    expect(result.warnings).toEqual([]);
  });

  it('fails closed when a lossy nested list cannot be uniquely matched in fetched Markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-nested-tree-'));
    const output = join(dir, 'doc.remote.md');
    const desired = `- **Parent**

    Child paragraph.`;
    const lossy = '- **Parent**Child paragraph.';
    const tree = materializePullTree(desired, 'ambiguous');

    await expect(runPull({
      cwd: dir,
      target: { kind: 'docx', token: 'doc_token' },
      outputPath: output,
      profile: 'none',
      overwrite: false,
      writeReceipt: false,
      adapter: {
        fetchDocMarkdown: async () => ({ markdown: `${lossy}\n\n${lossy}` }),
        fetchDocBlocks: async () => ({
          blocks: [
            { block_id: 'doc_token', block_type: 1, children: tree.roots.map((block) => block.block_id!) },
            ...tree.roots,
            ...tree.descendants
          ]
        }),
        replaceDocument: async () => {},
        createDocument: async () => ({ documentId: 'created' })
      }
    })).rejects.toThrow(
      'pull nested list hierarchy reconstruction failed: native block sequence cannot be uniquely matched'
    );
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

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

function materializePullTree(
  markdown: string,
  prefix: string
): { roots: FeishuBlock[]; descendants: FeishuBlock[] } {
  let ordinal = 0;
  const visit = (block: FeishuBlock): { root: FeishuBlock; descendants: FeishuBlock[] } => {
    ordinal += 1;
    const blockId = `${prefix}-${ordinal}`;
    const children = Array.isArray(block.children)
      ? block.children.filter((child): child is FeishuBlock => {
        return Boolean(child && typeof child === 'object' && !Array.isArray(child) && 'block_type' in child);
      })
      : [];
    const materialized = children.map(visit);
    return {
      root: {
        ...block,
        block_id: blockId,
        ...(materialized.length > 0
          ? { children: materialized.map((child) => child.root.block_id!) }
          : { children: undefined })
      },
      descendants: materialized.flatMap((child) => [child.root, ...child.descendants])
    };
  };
  const materialized = markdownToFeishuBlocks(markdown).map(visit);
  return {
    roots: materialized.map((entry) => entry.root),
    descendants: materialized.flatMap((entry) => entry.descendants)
  };
}
