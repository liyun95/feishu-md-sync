import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { createDocumentLinkResolver } from '../src/link-resolvers/create-resolver.js';

const baseUrl = process.env.FEISHU_MD_SYNC_TEST_BASE;

describe.skipIf(!baseUrl)('live read-only Base resolver', () => {
  it('resolves the maintained model-provider slug', async () => {
    const created = await createDocumentLinkResolver({
      cwd: process.cwd(),
      config: {
        type: 'lark-base',
        baseUrl: baseUrl!,
        keyField: 'Slug',
        urlField: 'Docs',
        placementTypeField: 'Placement Type',
        referenceField: 'Ref Target Doc',
        acceptedPlacementTypes: ['canonical', 'ref']
      },
      adapter: new LarkCliAdapter({ identity: 'user' }),
      now: new Date()
    });
    if (!created.resolver) throw new Error('live Base resolver was not created');
    const result = await created.resolver.resolve({
      slug: 'integrate-with-model-providers',
      originalUrl: './integrate-with-model-providers',
      location: { file: 'hugging-face.md', line: 1 }
    });
    expect(result.resolved?.resolvedUrl).toMatch(
      /^https:\/\/[^/]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+$/
    );
  }, 30_000);
});
