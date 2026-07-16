import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { buildPublishContext } from '../src/publish/publish-context.js';
import { runPublish } from '../src/publish/run-publish.js';

describe('publish context', () => {
  let cwd: string;
  let sourcePath: string;
  let tabsFile: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'fms-publish-context-'));
    sourcePath = join(cwd, 'article.md');
    tabsFile = join(cwd, 'tabs.md');
    await writeFile(sourcePath, '# Article\n', 'utf8');
    await writeFile(tabsFile, '<Tabs>\n<TabItem value="python">Body</TabItem>\n</Tabs>\n', 'utf8');
  });

  it('applies dialect before profile and fingerprints only used links', async () => {
    const input = {
      cwd,
      sourcePath,
      localSource: '---\nslug: /demo\n---\n\nMilvus links to [Next](./next).\n',
      dialect: 'zdoc-authoring' as const,
      dialectConfig: {
        publicSiteBaseUrl: 'https://docs.example.com/docs',
        linkResolver: {
          type: 'lark-base',
          baseUrl: 'https://example.feishu.cn/base/base_token',
          keyField: 'Slug',
          urlField: 'Docs',
          placementTypeField: 'Placement Type',
          acceptedPlacementTypes: ['canonical', 'ref']
        }
      },
      profile: 'zilliz' as const,
      adapter: baseAdapterFor({ next: 'https://example.feishu.cn/wiki/wiki_next' })
    };
    const context = await buildPublishContext(input);
    expect(context.dialectDraft).not.toContain('slug: /demo');
    expect(context.publishDraft).toContain('<include target="zilliz">Zilliz Cloud</include>');
    expect(context.publishDraft).toContain('https://example.feishu.cn/wiki/wiki_next');
    expect(context.linkResolutionFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const cached = await buildPublishContext({
      ...input,
      adapter: baseAdapterThatRejectsNetwork()
    });
    expect(cached.resolvedLinks[0]?.source).toBe('fresh-cache');
    expect(cached.linkResolutionFingerprint).toBe(context.linkResolutionFingerprint);
  });

  it('returns blockers without calling remote write methods', async () => {
    const adapter = trackingAdapter();
    const result = await runPublish({
      cwd,
      file: tabsFile,
      target: { kind: 'docx', token: 'doc' },
      dialect: 'zdoc-authoring',
      dialectConfig: {},
      profile: 'none',
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });
    expect(result.plan.strategy).toBe('blocked');
    expect(result.plan.dialectBlockers[0].code).toBe('unsupported-mdx-component');
    expect(adapter.writeCalls).toBe(0);
  });
});

function baseAdapterFor(links: Record<string, string>): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown: '' }),
    fetchDocBlocks: async () => ({
      blocks: [{ block_id: 'doc', block_type: 1, children: [] }]
    }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' }),
    resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
    fetchBaseTables: async () => [{ id: 'tbl_docs', name: 'Docs' }],
    fetchBaseRecords: async () => Object.entries(links).map(([slug, url], index) => ({
      recordId: `rec${index + 1}`,
      fields: {
        Slug: slug,
        Docs: `[${slug}](${url})`,
        'Placement Type': ['canonical']
      }
    }))
  };
}

function trackingAdapter(): FeishuAdapter & { writeCalls: number } {
  const adapter: FeishuAdapter & { writeCalls: number } = {
    writeCalls: 0,
    fetchDocMarkdown: async () => ({ markdown: '# Remote\n' }),
    fetchDocBlocks: async () => ({
      blocks: [{ block_id: 'doc', block_type: 1, children: [] }]
    }),
    replaceDocument: async () => {
      adapter.writeCalls += 1;
    },
    createDocument: async () => {
      adapter.writeCalls += 1;
      return { documentId: 'created' };
    }
  };
  return adapter;
}

function baseAdapterThatRejectsNetwork(): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown: '' }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' }),
    resolveBaseUrl: async () => {
      throw new Error('fresh cache must not resolve the Base URL');
    },
    fetchBaseTables: async () => {
      throw new Error('fresh cache must not list Base tables');
    },
    fetchBaseRecords: async () => {
      throw new Error('fresh cache must not list Base records');
    }
  };
}
