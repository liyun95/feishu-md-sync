import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeMultisdkReviewMarkdown } from '../src/multisdk/review-markdown.js';

const tempDirs: string[] = [];

describe('multisdk review markdown', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('inserts selected language code after each Python block in local markdown', async () => {
    const dir = await tempDir();
    const remote = join(dir, 'inputs/remote.md');
    const snippet = join(dir, 'snippets/java-01-create-index.java');
    await mkdir(dirname(remote), { recursive: true });
    await mkdir(dirname(snippet), { recursive: true });
    await writeFile(remote, '# Docs\n\n```Python\nclient.create_index()\n```\n', 'utf8');
    await writeFile(snippet, 'client.createIndex(request);', 'utf8');

    const result = await writeMultisdkReviewMarkdown({
      taskDir: dir,
      language: 'java',
      remoteMarkdownPath: remote,
      snippetPaths: [snippet]
    });

    await expect(readFile(result.markdownPath, 'utf8')).resolves.toBe('# Docs\n\n```Python\nclient.create_index()\n```\n\n```java\nclient.createIndex(request);\n```\n');
    await expect(readFile(result.diffPath, 'utf8')).resolves.toContain('```java');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-review-'));
  tempDirs.push(dir);
  return dir;
}
