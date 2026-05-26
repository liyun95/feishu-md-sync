import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import { exportCodeBlockSnippets } from '../src/sync/code-block-export.js';

describe('code-block export', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes deterministic snippet files and a mixed manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-code-export-'));
    tempDirs.push(dir);

    const result = await exportCodeBlockSnippets({
      document: 'doc-url',
      inventory: inventory([
        block('python-1', 'python', 1, 'from pymilvus import MilvusClient'),
        block('go-1', 'go', 2, 'fmt.Println("ok")')
      ]),
      expectLanguages: ['go', 'restful'],
      outDir: dir,
      manifestPath: join(dir, 'manifest.json')
    });

    const goPath = join(dir, 'snippets/go-01-define-a-nullable-field-in-the-collection-schema.go');
    const restfulPath = join(dir, 'snippets/restful-01-define-a-nullable-field-in-the-collection-schema.sh');

    await expect(stat(goPath)).resolves.toBeTruthy();
    await expect(stat(restfulPath)).resolves.toBeTruthy();
    await expect(readFile(goPath, 'utf8')).resolves.toBe('fmt.Println("ok")');
    await expect(readFile(restfulPath, 'utf8')).resolves.toBe('');

    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        action: 'update',
        blockId: 'go-1',
        language: 'go',
        file: 'snippets/go-01-define-a-nullable-field-in-the-collection-schema.go'
      }),
      expect.objectContaining({
        action: 'insert',
        language: 'restful',
        insertAfterBlockId: 'go-1',
        file: 'snippets/restful-01-define-a-nullable-field-in-the-collection-schema.sh'
      })
    ]);

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as unknown;
    expect(manifest).toEqual(result.manifest);
  });
});

function inventory(blocks: CodeBlockInventory['blocks']): CodeBlockInventory {
  return {
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    groups: [{
      groupId: 'group-001',
      heading: 'Define a nullable field in the collection schema',
      pythonAnchorBlockId: 'python-1',
      parentBlockId: 'doc',
      startIndex: 1,
      endIndex: blocks[blocks.length - 1]?.childIndex ?? 1,
      languages: blocks.map((item) => item.canonicalLanguage),
      missingLanguages: ['java', 'javascript', 'go', 'restful'].filter((language) => {
        return !blocks.some((item) => item.canonicalLanguage === language);
      }) as CodeBlockInventory['languageOrder'],
      blocks
    }],
    blocks
  };
}

function block(
  blockId: string,
  language: 'python' | 'java' | 'javascript' | 'go' | 'restful',
  childIndex: number,
  text: string
): CodeBlockInventory['blocks'][number] {
  return {
    blockId,
    parentBlockId: 'doc',
    childIndex,
    documentIndex: childIndex,
    language,
    canonicalLanguage: language,
    text,
    isPlaceholder: false,
    heading: 'Define a nullable field in the collection schema',
    groupId: 'group-001',
    pythonAnchorBlockId: 'python-1'
  };
}
