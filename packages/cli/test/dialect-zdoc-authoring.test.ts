import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { preprocessDialect } from '../src/dialects/preprocess.js';
import type { DocumentLinkResolver } from '../src/link-resolvers/types.js';

const fixturePath = new URL(
  './fixtures/dialects/zdoc-authoring/hugging-face.md',
  import.meta.url
);

describe('zdoc-authoring dialect', () => {
  it('removes frontmatter and explicit anchors while preserving assets', async () => {
    const result = await preprocessFixture({ resolver: undefined });

    expect(result.metadata).toMatchObject({ title: 'Hugging Face', slug: '/hugging-face' });
    expect(result.markdown).not.toContain('slug: /hugging-face');
    expect(result.markdown).toContain('## How it works\n');
    expect(result.markdown).toContain('![Flow](./images/hugging-face-flow.svg)');
    expect(result.blockers).toEqual([]);
  });

  it('removes escaped and unescaped explicit heading anchors', async () => {
    const result = await preprocessText(
      '## Plain{#plain}\n## Escaped\\{#escaped}\n'
    );

    expect(result.markdown).toBe('## Plain\n## Escaped\n');
  });

  it('turns note and warning directives into existing HTML Callout syntax', async () => {
    const result = await preprocessText(':::warning\nDo not expose the token.\n:::\n');

    expect(result.markdown).toBe(
      '<div class="alert warning">\n\nDo not expose the token.\n\n</div>\n'
    );
  });

  it('blocks custom directive titles, Tabs, and unknown directives', async () => {
    for (const [markdown, code] of [
      [':::note[Custom]\nBody\n:::\n', 'unsupported-zdoc-admonition'],
      ['<Tabs>\n<TabItem value="python">Body</TabItem>\n</Tabs>\n', 'unsupported-mdx-component'],
      [':::tip\nBody\n:::\n', 'unsupported-zdoc-admonition']
    ] as const) {
      const result = await preprocessText(markdown);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.code).toBe(code);
    }
  });

  it('removes Zdoc import statements before unsupported-component checks', async () => {
    const result = await preprocessText(
      "import Procedures from '@site/src/components/Procedures';\n\n# Article\n"
    );

    expect(result.markdown).toBe('\n# Article\n');
    expect(result.blockers).toEqual([]);
  });

  it('uses a resolver and removes a source heading fragment from a Feishu link', async () => {
    const result = await preprocessText('[Next](./next#details)\n', fakeResolver({
      slug: 'next',
      url: 'https://zilliverse.feishu.cn/wiki/wiki_next'
    }));

    expect(result.markdown).toBe('[Next](https://zilliverse.feishu.cn/wiki/wiki_next)\n');
    expect(result.warnings[0].message).toContain('heading fragment');
  });

  it('leaves component-looking text inside code fences unchanged', async () => {
    const markdown = '```mdx\n<Tabs>\n:::\n```\n';
    const result = await preprocessText(markdown);

    expect(result.markdown).toBe(markdown);
    expect(result.blockers).toEqual([]);
  });
});

async function preprocessFixture(input: { resolver?: DocumentLinkResolver }) {
  return preprocessText(await readFile(fixturePath, 'utf8'), input.resolver);
}

async function preprocessText(
  markdown: string,
  resolver?: DocumentLinkResolver
) {
  return preprocessDialect({
    cwd: '/workspace',
    sourcePath: '/workspace/article.md',
    markdown,
    dialect: 'zdoc-authoring',
    config: { publicSiteBaseUrl: 'https://docs.zilliz.com/docs' },
    linkResolver: resolver
  });
}

function fakeResolver(input: { slug: string; url: string }): DocumentLinkResolver {
  return {
    resolve: async ({ slug, originalUrl, location }) => slug === input.slug
      ? {
          resolved: {
            originalUrl,
            slug,
            resolvedUrl: input.url,
            source: 'live-base',
            location
          },
          diagnostics: []
        }
      : { diagnostics: [] }
  };
}
