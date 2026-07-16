import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inventoryAndTransformZdoc } from '../src/zdoc/component-inventory.js';
import { planProceduresChanges } from '../src/zdoc/procedures-plan.js';
import { localSemanticDocument } from '../src/semantic/local-document.js';
import type { SemanticDocument } from '../src/semantic/types.js';

const fixture = (name: string) => new URL(
  `./fixtures/zdoc/model-providers/${name}`,
  import.meta.url
);

describe('Zdoc Procedures planning', () => {
  it('plans only two token creates for revision 790', async () => {
    const local = await canonicalDocument();
    const remote = remoteize(localSemanticDocument(
      await readFile(fixture('revision-790.md'), 'utf8')
    ));

    const plan = planProceduresChanges({ parentBlockId: 'page', local, remote });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: 'authoring-token-create', token: '<Procedures>' }),
      expect.objectContaining({ kind: 'authoring-token-create', token: '</Procedures>' })
    ]);
  });

  it('plans only the opening-token move for revision 799', async () => {
    const local = await canonicalDocument();
    const remote = remoteize(localSemanticDocument(
      await readFile(fixture('revision-799.md'), 'utf8')
    ));

    const plan = planProceduresChanges({ parentBlockId: 'page', local, remote });

    expect(plan.blockers).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: 'authoring-token-move',
        token: '<Procedures>',
        remoteBlockId: expect.any(String),
        insertAfterBlockId: expect.any(String)
      })
    ]);
  });

  it('deletes a complete remote pair when Procedures are removed locally', () => {
    const local = localSemanticDocument('Intro.\n\nStep.');
    const remote = remoteize(localSemanticDocument(
      'Intro.\n\n<Procedures>\n\nStep.\n\n</Procedures>'
    ));

    expect(planProceduresChanges({ parentBlockId: 'page', local, remote }).operations)
      .toEqual([
        expect.objectContaining({ kind: 'authoring-token-delete', token: '<Procedures>' }),
        expect.objectContaining({ kind: 'authoring-token-delete', token: '</Procedures>' })
      ]);
  });

  it('blocks deleting multiple remote Procedures pairs when local contains none', () => {
    const local = localSemanticDocument('# Configure\n\nFirst step.\n\nSecond step.');
    const remote = remoteize(localSemanticDocument(`# Configure

<Procedures>

First step.

</Procedures>

<Procedures>

Second step.

</Procedures>`));

    const plan = planProceduresChanges({ parentBlockId: 'page', local, remote });

    expect(plan.operations).toEqual([]);
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: 'procedures-boundary-ambiguous'
    }));
  });

  it('blocks when a token anchor is not unique', () => {
    const local = localSemanticDocument('Intro.\n\n<Procedures>\n\nStep.\n\n</Procedures>');
    const remote = remoteize(localSemanticDocument('Intro.\n\nIntro.\n\nStep.'));

    expect(planProceduresChanges({ parentBlockId: 'page', local, remote }).blockers)
      .toContainEqual(expect.objectContaining({ code: 'procedures-boundary-ambiguous' }));
  });

  it('preserves multiple Procedures pairs in the same section by exact boundaries', () => {
    const markdown = `# Configure

First intro.

<Procedures>

1. First step.

</Procedures>

Second intro.

<Procedures>

1. Second step.

</Procedures>`;
    const local = localSemanticDocument(markdown);
    const remote = remoteize(localSemanticDocument(markdown));

    expect(planProceduresChanges({ parentBlockId: 'page', local, remote }))
      .toEqual({ operations: [], blockers: [] });
  });
});

async function canonicalDocument(): Promise<SemanticDocument> {
  const markdown = await readFile(fixture('canonical-excerpt.md'), 'utf8');
  const transformed = inventoryAndTransformZdoc({
    sourcePath: '/workspace/article.md',
    markdown,
    lineOffset: 0
  });
  return localSemanticDocument(transformed.markdown, undefined, transformed.inventory);
}

function remoteize(document: SemanticDocument): SemanticDocument {
  return {
    nodes: document.nodes.map((node, index) => ({
      ...node,
      remoteBlockId: `block-${index}`
    }))
  };
}
