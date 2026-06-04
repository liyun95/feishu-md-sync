import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMultisdkVerifier } from '../src/multisdk/prepare.js';

const tempDirs: string[] = [];

describe('multisdk prepare', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes python context, selected snippets, and a Java verifier scaffold', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'remote.md'), [
      '# Index docs',
      '',
      '```Python',
      'client.create_index(collection_name="books", index_params=index_params)',
      '```',
      ''
    ].join('\n'), 'utf8');
    await writeFile(join(dir, 'java-01-create-index.java'), 'client.createIndex(request);', 'utf8');

    const result = await prepareMultisdkVerifier({
      taskDir: dir,
      language: 'java',
      remoteMarkdownPath: join(dir, 'remote.md'),
      snippetPaths: [join(dir, 'java-01-create-index.java')],
      milvusVersion: '2.6.0'
    });

    expect(result.files.map((file) => file.replace(`${dir}/`, ''))).toEqual([
      'work/java/python-context.md',
      'work/java/snippets/java-01-create-index.java',
      'work/java/verify/README.md',
      'work/java/verify/pom.xml',
      'work/java/verify/src/test/java/io/milvus/docs/MultisdkExamplesTest.java'
    ]);
    await expect(readFile(join(dir, 'work/java/python-context.md'), 'utf8')).resolves.toContain('client.create_index');
    await expect(readFile(join(dir, 'work/java/verify/README.md'), 'utf8')).resolves.toContain('Milvus target: 2.6.0');
    await expect(readFile(join(dir, 'work/java/verify/pom.xml'), 'utf8')).resolves.toContain('<artifactId>milvus-sdk-java</artifactId>');
    await expect(readFile(join(dir, 'work/java/verify/src/test/java/io/milvus/docs/MultisdkExamplesTest.java'), 'utf8'))
      .resolves.toContain('Replace this scaffold with live Milvus assertions');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-prepare-'));
  tempDirs.push(dir);
  return dir;
}
