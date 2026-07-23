import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inventoryAndTransformZdoc } from '../src/zdoc/component-inventory.js';

const canonicalFixture = new URL(
  './fixtures/zdoc/model-providers/canonical-excerpt.md',
  import.meta.url
);

describe('Zdoc component inventory', () => {
  it('transforms registered components and records their authoring intent', async () => {
    const markdown = await readFile(canonicalFixture, 'utf8');
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown,
      lineOffset: 0
    });

    expect(result.inventory.components).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'admonition',
        status: 'transformed',
        title: 'Billing',
        calloutType: 'note'
      }),
      expect.objectContaining({
        kind: 'supademo',
        status: 'preserved',
        componentId: 'cmj9f3j6u0johf6zpk5kdyx3u'
      }),
      expect.objectContaining({
        kind: 'procedures',
        token: 'open',
        status: 'preserved'
      }),
      expect.objectContaining({
        kind: 'procedures',
        token: 'close',
        status: 'preserved'
      })
    ]));
    expect(result.markdown).toContain(
      '<div class="alert note" data-fms-callout-title="Billing">'
    );
    expect(result.markdown).toContain(
      '<readonly-block type="isv"></readonly-block>'
    );
    expect(result.markdown).toContain('<Procedures>');
    expect(result.markdown).toContain('</Procedures>');
    expect(result.markdown).not.toContain('<Admonition');
    expect(result.markdown).not.toContain('<Supademo');
    expect(result.blockers).toEqual([]);
  });

  it('removes frontmatter and imports as intentionally ignored metadata', () => {
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown: `---
title: Article
---

import Procedures from '@site/src/components/Procedures';

# Article
`,
      lineOffset: 0
    });

    expect(result.markdown).toBe('\n# Article\n');
    expect(result.inventory.ignoredMetadata).toEqual([
      expect.objectContaining({ kind: 'frontmatter', sourceLine: 1 }),
      expect.objectContaining({ kind: 'import', sourceLine: 5 })
    ]);
    expect(result.blockers).toEqual([]);
  });

  it.each([
    '<Supademo id="demo" title="" isShowcase />',
    '<Supademo id="demo" title="" isShowcase="true" />'
  ])('records showcase mode from %s', (source) => {
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown: `# Demo\n\n${source}\n`,
      lineOffset: 0
    });

    expect(result.inventory.components).toContainEqual(expect.objectContaining({
      kind: 'supademo',
      componentId: 'demo',
      isShowcase: true,
      status: 'preserved'
    }));
    expect(result.markdown).toContain('<readonly-block type="isv"></readonly-block>');
    expect(result.blockers).toEqual([]);
  });

  it.each([
    '<Supademo id="demo" title="" isShowcase="yes" />',
    '<Supademo id="demo" title="" isShowcase={true} />',
    '<Supademo id="demo" title="" isShowcase isShowcase />',
    '<Supademo id="demo" title="" autoplay="true" />',
    '<Supademo id="demo"title="" isShowcase />',
    '<Supademo id="demo" title=""isShowcase="true" />'
  ])('blocks unsupported Supademo metadata in %s', (source) => {
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown: `${source}\n`,
      lineOffset: 0
    });

    expect(result.inventory.components).toContainEqual(expect.objectContaining({
      kind: 'unknown',
      componentName: 'Supademo',
      status: 'blocking'
    }));
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'zdoc-component-unsupported'
    }));
  });

  it.each([
    {
      markdown: '<Procedures>\n\n1. Step.\n',
      code: 'zdoc-procedures-unpaired'
    },
    {
      markdown: '<Procedures>\n<Procedures>\n</Procedures>\n</Procedures>\n',
      code: 'zdoc-procedures-nested'
    },
    {
      markdown: '<Tabs>\nBody\n</Tabs>\n',
      code: 'zdoc-component-unsupported'
    },
    {
      markdown: '<Admonition type="tip" title="Tip">\n\nBody.\n\n</Admonition>\n',
      code: 'zdoc-admonition-unsupported'
    }
  ])('blocks invalid registered syntax with $code', ({ markdown, code }) => {
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown,
      lineOffset: 0
    });

    expect(result.blockers).toContainEqual(expect.objectContaining({ code }));
  });

  it('does not inventory component-looking text inside fenced Code', () => {
    const markdown = '```mdx\n<Procedures>\n<Supademo id="demo" />\n</Procedures>\n```\n';
    const result = inventoryAndTransformZdoc({
      sourcePath: '/workspace/article.md',
      markdown,
      lineOffset: 0
    });

    expect(result.markdown).toBe(markdown);
    expect(result.inventory.components).toEqual([]);
    expect(result.blockers).toEqual([]);
  });
});
