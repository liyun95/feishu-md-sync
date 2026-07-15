import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  FeishuAdapter,
  RemoteBaseRecord
} from '../src/adapters/feishu-adapter.js';
import {
  createDocumentLinkResolver
} from '../src/link-resolvers/create-resolver.js';
import { linkResolverCachePath } from '../src/link-resolvers/cache.js';
import { extractFeishuDocumentUrl } from '../src/link-resolvers/lark-base-resolver.js';
import type { LarkBaseLinkResolverConfig } from '../src/link-resolvers/types.js';

describe('Lark Base document link resolver', () => {
  it('resolves one canonical slug to its Feishu URL', async () => {
    const resolver = await createResolverWithRecords([
      baseRecord(
        'canonical',
        'integrate-with-model-providers',
        'https://example.feishu.cn/wiki/wiki1'
      )
    ]);
    const result = await resolver.resolve({
      slug: 'integrate-with-model-providers',
      originalUrl: './integrate-with-model-providers',
      location: { file: '/workspace/doc.md', line: 5 }
    });
    expect(result.resolved).toMatchObject({
      resolvedUrl: 'https://example.feishu.cn/wiki/wiki1',
      source: 'live-base'
    });
  });

  it('ignores section and link rows and blocks duplicate canonical candidates', async () => {
    const resolver = await createResolverWithRecords([
      baseRecord('section', 'next', 'http://Next'),
      baseRecord('canonical', 'next', 'https://example.feishu.cn/wiki/wiki1'),
      baseRecord('canonical', 'next', 'https://example.feishu.cn/wiki/wiki2')
    ]);
    const result = await resolver.resolve({
      slug: 'next',
      originalUrl: './next',
      location: { file: '/workspace/doc.md', line: 2 }
    });
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics[0].code).toBe('relative-link-ambiguous');
  });

  it('extracts URLs from Markdown-link cells and rejects non-Feishu Docs values', () => {
    expect(extractFeishuDocumentUrl('[Title](https://example.feishu.cn/wiki/wiki1)'))
      .toBe('https://example.feishu.cn/wiki/wiki1');
    expect(extractFeishuDocumentUrl('[Section](http://Section)')).toBeUndefined();
  });

  it('uses stale cache when Base refresh fails', async () => {
    const { resolver, cachePath } = await createResolverWithStaleCacheAndFailingAdapter();
    const result = await resolver.resolve({
      slug: 'next',
      originalUrl: './next',
      location: { file: '/workspace/doc.md', line: 2 }
    });
    expect(cachePath).toContain('.sync/feishu-md-sync/link-resolvers');
    expect(result.resolved?.source).toBe('stale-cache');
    expect(result.diagnostics.map(({ code }) => code)).toContain('link-resolver-stale-cache');
  });
});

const resolverConfig: LarkBaseLinkResolverConfig = {
  type: 'lark-base',
  baseUrl: 'https://example.feishu.cn/base/base_token',
  keyField: 'Slug',
  urlField: 'Docs',
  placementTypeField: 'Placement Type',
  referenceField: 'Ref Target Doc',
  acceptedPlacementTypes: ['canonical', 'ref']
};

function baseRecord(
  placementType: string,
  slug: string,
  url: string
): RemoteBaseRecord {
  return {
    recordId: `rec-${placementType}-${slug}-${url.slice(-5)}`,
    fields: {
      Slug: slug,
      Docs: `[${slug}](${url})`,
      'Placement Type': [placementType],
      'Ref Target Doc': null
    }
  };
}

function baseAdapter(records: RemoteBaseRecord[], failRecords = false): FeishuAdapter {
  return {
    fetchDocMarkdown: async () => ({ markdown: '' }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' }),
    resolveBaseUrl: async () => ({ baseToken: 'base_token' }),
    fetchBaseTables: async () => [{ id: 'tbl_ai', name: 'AI Models' }],
    fetchBaseRecords: async () => {
      if (failRecords) throw new Error('Base unavailable');
      return records;
    }
  };
}

async function createResolverWithRecords(records: RemoteBaseRecord[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'fms-base-resolver-'));
  const created = await createDocumentLinkResolver({
    cwd,
    config: resolverConfig,
    adapter: baseAdapter(records),
    now: new Date('2026-07-15T08:00:00.000Z')
  });
  if (!created.resolver) throw new Error('test resolver was not created');
  return created.resolver;
}

async function createResolverWithStaleCacheAndFailingAdapter() {
  const cwd = await mkdtemp(join(tmpdir(), 'fms-base-resolver-stale-'));
  await createDocumentLinkResolver({
    cwd,
    config: resolverConfig,
    adapter: baseAdapter([
      baseRecord('canonical', 'next', 'https://example.feishu.cn/wiki/wiki1')
    ]),
    now: new Date('2026-07-15T08:00:00.000Z')
  });
  const created = await createDocumentLinkResolver({
    cwd,
    config: resolverConfig,
    adapter: baseAdapter([], true),
    now: new Date('2026-07-15T10:00:00.000Z')
  });
  if (!created.resolver) throw new Error('stale test resolver was not created');
  return {
    resolver: created.resolver,
    cachePath: linkResolverCachePath({ cwd, baseToken: 'base_token', config: resolverConfig })
  };
}
