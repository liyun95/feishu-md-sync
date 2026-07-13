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

  it('marks non-table HTML containers as opaque', () => {
    const document = localSemanticDocument('<div class="alert note">\n\nNote body.\n\n</div>');
    expect(document.nodes).toContainEqual(expect.objectContaining({
      kind: 'opaque',
      description: 'unsupported local HTML container: div'
    }));
  });

  it('keeps YAML frontmatter out of writable text nodes', () => {
    const document = localSemanticDocument('---\ntitle: GPU CAGRA\n---\n\n# GPU CAGRA');
    expect(document.nodes[0]).toMatchObject({
      kind: 'opaque',
      description: 'local YAML frontmatter'
    });
    expect(document.nodes.filter((node) => node.kind === 'text')).toHaveLength(1);
  });
});
