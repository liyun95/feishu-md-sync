import { describe, expect, it } from 'vitest';
import { localSemanticDocument } from '../src/semantic/local-document.js';
import type { ZdocComponentInventory } from '../src/zdoc/types.js';
import { stripExecutionMetadata } from '../src/semantic/normalize.js';

describe('local semantic document', () => {
  it('assigns heading paths and table ordinals while preserving text nodes', () => {
    const document = localSemanticDocument(`
# GPU CAGRA

Intro text.

## Index params

### Index-specific search params

<table>
  <tr><th>Parameter</th><th>Description</th></tr>
  <tr><td><code>ef</code></td><td>Accuracy trade-off.</td></tr>
</table>

Closing text.
`);

    const table = document.nodes.find((node) => node.kind === 'table');
    expect(table?.locator).toEqual({
      sectionPath: ['GPU CAGRA', 'Index params', 'Index-specific search params'],
      kind: 'table',
      ordinal: 0
    });
    expect(document.nodes.filter((node) => node.kind === 'text').length).toBeGreaterThan(1);
  });

  it('compacts skipped heading levels in table locators', () => {
    const document = localSemanticDocument(`
## Index params

<table>
  <tr><th>Parameter</th><th>Description</th></tr>
  <tr><td><code>ef</code></td><td>Accuracy trade-off.</td></tr>
</table>
`);

    const table = document.nodes.find((node) => node.kind === 'table');
    expect(table?.locator.sectionPath).toEqual(['Index params']);
  });

  it('parses canonical Milvus Callouts and keeps other div containers opaque', () => {
    const document = localSemanticDocument('<div class="alert note">\n\nNote body.\n\n</div>');
    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'callout',
      calloutType: 'note',
      children: [expect.objectContaining({ markdown: 'Note body.' })]
    }));

    const opaque = localSemanticDocument('<div class="multipleCode">\n\nCode tabs.\n\n</div>');
    expect(opaque.nodes).toContainEqual(expect.objectContaining({
      kind: 'opaque',
      description: 'unsupported local HTML container: div'
    }));
  });

  it('assigns section-aware Callout ordinals', () => {
    const document = localSemanticDocument(`# Build index

<div class="alert note">

First note.

</div>

<div class="alert warning">

First warning.

</div>`);

    expect(document.nodes.filter((node) => node.kind === 'callout').map((node) => node.locator)).toEqual([
      { sectionPath: ['Build index'], kind: 'callout', ordinal: 0 },
      { sectionPath: ['Build index'], kind: 'callout', ordinal: 1 }
    ]);
  });

  it('keeps YAML frontmatter out of writable text nodes', () => {
    const document = localSemanticDocument('---\ntitle: GPU CAGRA\n---\n\n# GPU CAGRA');
    expect(document.nodes[0]).toMatchObject({
      kind: 'opaque',
      description: 'local YAML frontmatter'
    });
    expect(document.nodes.filter((node) => node.kind === 'text')).toHaveLength(1);
  });

  it('represents a standalone Markdown image as an asset scope', () => {
    const document = localSemanticDocument('# Section\n\n![Diagram](./diagram.png)');

    expect(document.nodes.at(-1)).toMatchObject({
      kind: 'asset',
      representation: 'image',
      alt: 'Diagram',
      source: './diagram.png',
      locator: { sectionPath: ['Section'], kind: 'asset', ordinal: 0 }
    });
  });

  it('keeps an inline image inside the ordinary text scope', () => {
    const document = localSemanticDocument('See ![Diagram](./diagram.png) for details.');

    expect(document.nodes).toEqual([
      expect.objectContaining({
        kind: 'text',
        markdown: 'See ![Diagram](./diagram.png) for details.'
      })
    ]);
  });

  it('parses top-level fenced Code blocks as first-class scopes', () => {
    const document = localSemanticDocument('# Build\n\n```curl\ncurl localhost\n```\n');

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'code',
      locator: { sectionPath: ['Build'], kind: 'code', ordinal: 0 },
      content: 'curl localhost',
      sourceLanguage: 'curl',
      resolvedLanguage: 'bash',
      issues: []
    }));
  });

  it('does not parse fenced text inside Callouts as a top-level Code scope', () => {
    const document = localSemanticDocument('<div class="alert note">\n\n```python\nprint(1)\n```\n\n</div>');

    expect(document.nodes.some((node) => node.kind === 'code')).toBe(false);
  });

  it('keeps four-space-indented fences opaque instead of parsing their body as text', () => {
    const document = localSemanticDocument('1. item\n\n    ```python\n    print(1)\n    ```\n');

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'opaque',
      description: 'unsupported indented fenced Code block'
    }));
    expect(document.nodes.some((node) => node.kind === 'text' && node.markdown.includes('print(1)'))).toBe(false);
  });

  it('does not mistake HTML-looking Code content for a table', () => {
    const document = localSemanticDocument('```html\n<table><tr><td>x</td></tr></table>\n```');

    expect(document.nodes).toEqual([
      expect.objectContaining({ kind: 'code', content: '<table><tr><td>x</td></tr></table>' })
    ]);
  });

  it('keeps ordinary text locators stable when Procedures tokens are present', () => {
    const without = localSemanticDocument('Intro.\n\n1. First.\n\nAfter.');
    const withTokens = localSemanticDocument(
      'Intro.\n\n<Procedures>\n\n1. First.\n\n</Procedures>\n\nAfter.'
    );

    expect(withTokens.nodes.filter((node) => node.kind === 'text').map((node) => node.locator))
      .toEqual(without.nodes.filter((node) => node.kind === 'text').map((node) => node.locator));
    expect(withTokens.nodes.filter((node) => node.kind === 'authoring-token')).toEqual([
      expect.objectContaining({ component: 'Procedures', token: 'open', markdown: '<Procedures>' }),
      expect.objectContaining({ component: 'Procedures', token: 'close', markdown: '</Procedures>' })
    ]);
  });

  it('pairs Zdoc Supademo placeholders with inventory entries', () => {
    const inventory: ZdocComponentInventory = {
      components: [{
        kind: 'supademo',
        componentId: 'demo-id',
        isShowcase: true,
        status: 'preserved',
        sourceLine: 3,
        sectionPath: ['Demo']
      }],
      ignoredMetadata: []
    };
    const document = localSemanticDocument(
      '# Demo\n\n<readonly-block type="isv"></readonly-block>\n',
      undefined,
      inventory
    );

    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'protected-resource',
      resourceKind: 'supademo',
      componentId: 'demo-id',
      isShowcase: true,
      locator: { sectionPath: ['Demo'], kind: 'protected-resource', ordinal: 0 }
    }));
  });

  it('keeps an unmatched ISV placeholder opaque', () => {
    expect(localSemanticDocument(
      '<readonly-block type="isv"></readonly-block>'
    ).nodes).toContainEqual(expect.objectContaining({
      kind: 'opaque',
      description: 'unmatched local ISV placeholder'
    }));
  });

  it('parses short and canonical table separators into the same semantic table', () => {
    const short = localSemanticDocument('| A | B |\n|-|-|\n| x | y |').nodes[0];
    const canonical = localSemanticDocument(
      '| A | B |\n| --- | --- |\n| x | y |'
    ).nodes[0];

    expect(short?.kind).toBe('table');
    expect(canonical?.kind).toBe('table');
    expect(stripExecutionMetadata(short)).toEqual(stripExecutionMetadata(canonical));
  });

  it('represents nested list descendants inside one root text scope', () => {
    const document = localSemanticDocument(`- **Parent**

    Child paragraph.

    - Nested bullet.
    1. Nested ordered.
`);

    expect(document.nodes).toEqual([expect.objectContaining({
      kind: 'text',
      blockType: 12,
      markdown: `- **Parent**

    Child paragraph.

    - Nested bullet.

    1. Nested ordered.`,
      children: [
        expect.objectContaining({ blockType: 2, markdown: 'Child paragraph.' }),
        expect.objectContaining({ blockType: 12, markdown: '- Nested bullet.' }),
        expect.objectContaining({ blockType: 13, markdown: '1. Nested ordered.' })
      ]
    })]);
  });
});
