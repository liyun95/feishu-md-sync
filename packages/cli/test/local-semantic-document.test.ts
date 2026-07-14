import { describe, expect, it } from 'vitest';
import { localSemanticDocument } from '../src/semantic/local-document.js';

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
});
