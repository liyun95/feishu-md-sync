import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { preprocessDialect } from '../src/dialects/preprocess.js';
import { runPublish } from '../src/publish/run-publish.js';
import { localSemanticDocument } from '../src/semantic/local-document.js';

const fixtureUrl = new URL('./fixtures/live/zdoc-engine-controlled.md', import.meta.url);

describe('controlled Zdoc engine parity fixture', () => {
  it('has no dialect/link blockers and preserves the intended nested and table semantics', async () => {
    const source = await readFile(fixtureUrl, 'utf8');
    const dialect = await preprocessDialect({
      cwd: '/workspace',
      sourcePath: '/workspace/zdoc-engine-controlled.md',
      markdown: source,
      dialect: 'zdoc-authoring',
      config: {},
    });

    expect(dialect.blockers).toEqual([]);
    expect(dialect.linkResolution).toEqual({
      resolvedToFeishu: 0,
      resolvedFromFreshCache: 0,
      resolvedFromStaleCache: 0,
      resolvedToPublicSite: 0,
      unresolved: 0,
    });
    expect(dialect.markdown).toContain('[Lark documentation](https://open.larksuite.com/document/)');
    expect(dialect.markdown).toContain('<div class="alert note">');

    const semantic = localSemanticDocument(dialect.markdown, undefined, dialect.zdoc?.inventory);
    expect(semantic.nodes).toContainEqual(expect.objectContaining({
      kind: 'text',
      blockType: 12,
      markdown: expect.stringContaining('- Parent item'),
      children: [
        expect.objectContaining({ blockType: 2, markdown: 'Continuation paragraph.' }),
        expect.objectContaining({ blockType: 13, markdown: '1. Ordered child.' }),
      ],
    }));
    expect(semantic.nodes).toContainEqual(expect.objectContaining({
      kind: 'table',
      headers: [
        expect.objectContaining({ blocks: [expect.objectContaining({ inlines: [expect.objectContaining({ value: 'Shape' })] })] }),
        expect.objectContaining({ blocks: [expect.objectContaining({ inlines: [expect.objectContaining({ value: 'Expected' })] })] }),
      ],
      rows: [expect.objectContaining({
        cells: [
          expect.objectContaining({ blocks: [expect.objectContaining({ inlines: [expect.objectContaining({ value: 'Nested list' })] })] }),
          expect.objectContaining({ blocks: [expect.objectContaining({ inlines: [expect.objectContaining({ value: 'Preserved' })] })] }),
        ],
      })],
      unsupported: [],
    }));
  });

  it('produces a safe create dry-run without adapter IO or Base configuration', async () => {
    const fixturePath = fileURLToPath(fixtureUrl);
    const result = await runPublish({
      cwd: fileURLToPath(new URL('.', fixtureUrl)),
      file: fixturePath,
      target: { kind: 'folder', token: 'controlled-folder' },
      dialect: 'zdoc-authoring',
      dialectConfig: {},
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter: noIoAdapter(),
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan).toMatchObject({
      strategy: 'create-document',
      safeToWrite: true,
      dialectBlockers: [],
      risks: [],
      linkResolution: {
        resolvedToFeishu: 0,
        resolvedToPublicSite: 0,
        unresolved: 0,
      },
      zdocRoundTrip: { safeToPublish: true },
    });
    expect(result.plan.publishDraftHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

function noIoAdapter(): FeishuAdapter {
  const unexpected = async (): Promise<never> => {
    throw new Error('controlled create dry-run must not perform adapter IO');
  };
  return {
    fetchDocMarkdown: unexpected,
    replaceDocument: unexpected,
    createDocument: unexpected,
  };
}
