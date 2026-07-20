import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preprocessDialect } from '../src/dialects/preprocess.js';

const milvusFixtureRoot = fileURLToPath(new URL(
  './fixtures/dialects/milvus',
  import.meta.url
));

describe('milvus-authoring dialect', () => {
  it('expands frontmatter overrides, Variables.json, and fragments', async () => {
    const result = await preprocessMilvusFixture('guide.md');

    expect(result.markdown).toContain('Upgrade to Milvus 2.6.1 before continuing.');
    expect(result.markdown).toContain('Use image tag `v2.6.0`.');
    expect(result.markdown).toContain('template: "{{ query }}"');
    expect(result.dependencies.map(({ kind }) => kind)).toContain('file');
    expect(result.blockers).toEqual([]);
  });

  it('blocks missing variables with the fragment reference chain', async () => {
    const result = await preprocessMilvusText('{{fragments/missing-variable.md}}');

    expect(result.blockers[0]).toMatchObject({ code: 'missing-milvus-variable' });
    expect(result.blockers[0].referenceChain?.length).toBeGreaterThan(0);
  });

  it('blocks missing fragments and fragment cycles', async () => {
    const missing = await preprocessMilvusText('{{fragments/not-found.md}}');
    expect(missing.blockers[0].code).toBe('missing-milvus-fragment');

    const cycle = await preprocessMilvusText('{{fragments/a.md}}');
    expect(cycle.blockers[0].code).toBe('milvus-fragment-cycle');
  });

  it('blocks recognized unsupported Milvus directives outside code', async () => {
    const result = await preprocessMilvusText('{{tab}}\n');

    expect(result.blockers[0].code).toBe('unsupported-milvus-directive');
  });

  it('keeps variable-looking text inside indented code literal', async () => {
    const result = await preprocessMilvusText('    template: "{{ query }}"\n');

    expect(result.markdown).toContain('{{ query }}');
    expect(result.blockers).toEqual([]);
  });

  it('removes multipleCode language selectors while preserving their Code blocks', async () => {
    const result = await preprocessMilvusText([
      '<div class="multipleCode">',
      '  <a href="#python">Python</a>',
      '  <a href="#java">Java</a>',
      '</div>',
      '',
      '```python',
      'print(1)',
      '```',
      ''
    ].join('\n'));

    expect(result.markdown).not.toContain('multipleCode');
    expect(result.markdown).not.toContain('href="#python"');
    expect(result.markdown).toContain('```python\nprint(1)\n```');
    expect(result.blockers).toEqual([]);
  });

  it('dedents fenced Code blocks nested under Milvus list items', async () => {
    const result = await preprocessMilvusText([
      '1. Flatten the object:',
      '',
      '    ```json',
      '    {"category": "electronics"}',
      '    ```',
      '',
      '    The flattened value is then represented as:',
      '',
      '    ```plaintext',
      '    ("category", Text, "electronics")',
      '    ```',
      '',
      '1. Continue.',
      ''
    ].join('\n'));

    expect(result.markdown).toContain('1. Flatten the object:\n\n```json\n{"category": "electronics"}\n```');
    expect(result.markdown).not.toContain('    ```json');
    expect(result.markdown).toContain('```plaintext\n("category", Text, "electronics")\n```');
    expect(result.markdown).not.toContain('    ```plaintext');
    expect(result.blockers).toEqual([]);
  });
});

async function preprocessMilvusFixture(name: string) {
  const sourcePath = join(milvusFixtureRoot, 'site', 'en', name);
  return preprocessDialect({
    cwd: milvusFixtureRoot,
    sourcePath,
    markdown: await readFile(sourcePath, 'utf8'),
    dialect: 'milvus-authoring',
    config: { sourceRoot: 'site/en' }
  });
}

async function preprocessMilvusText(markdown: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'fms-milvus-dialect-'));
  const sourceRoot = join(cwd, 'site', 'en');
  const fragments = join(sourceRoot, 'fragments');
  await mkdir(fragments, { recursive: true });
  await writeFile(join(sourceRoot, 'Variables.json'), JSON.stringify({ known: 'value' }), 'utf8');
  await writeFile(join(fragments, 'missing-variable.md'), '{{var.not_found}}\n', 'utf8');
  await writeFile(join(fragments, 'a.md'), '{{fragments/b.md}}\n', 'utf8');
  await writeFile(join(fragments, 'b.md'), '{{fragments/a.md}}\n', 'utf8');
  const sourcePath = join(sourceRoot, 'doc.md');
  await writeFile(sourcePath, markdown, 'utf8');
  return preprocessDialect({
    cwd,
    sourcePath,
    markdown,
    dialect: 'milvus-authoring',
    config: { sourceRoot: 'site/en' }
  });
}
