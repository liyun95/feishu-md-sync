import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import {
  filterManifestByLanguage,
  mergeLanguageManifestItems,
  writeLanguageScopedManifest
} from '../src/multisdk/manifest.js';

const tempDirs: string[] = [];

describe('multisdk manifest helpers', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('filters a full manifest to one language', () => {
    const scoped = filterManifestByLanguage(fullManifest(), 'javascript');

    expect(scoped.items).toEqual([
      expect.objectContaining({ language: 'javascript', file: 'snippets/javascript-01.js' })
    ]);
    expect(scoped.languageOrder).toEqual(['python', 'java', 'javascript', 'go', 'restful']);
  });

  it('merges refreshed language items without changing other languages', () => {
    const merged = mergeLanguageManifestItems(fullManifest(), {
      ...fullManifest(),
      items: [
        {
          action: 'insert',
          groupId: 'group-002',
          anchorBlockId: 'python-2',
          insertAfterBlockId: 'python-2',
          parentBlockId: 'doc',
          language: 'go',
          file: 'snippets/go-02.go'
        }
      ]
    }, 'go');

    expect(merged.items.map((item) => `${item.language}:${item.file}`)).toEqual([
      'java:snippets/java-01.java',
      'javascript:snippets/javascript-01.js',
      'restful:snippets/restful-01.sh',
      'go:snippets/go-02.go'
    ]);
  });

  it('writes a scoped manifest next to the full manifest so snippet paths resolve from task dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multisdk-manifest-'));
    tempDirs.push(dir);

    const path = await writeLanguageScopedManifest(dir, fullManifest(), 'java');

    expect(path).toBe(join(dir, '.multisdk-java-manifest.json'));
    const written = JSON.parse(await readFile(path, 'utf8')) as CodeBlockManifest;
    expect(written.items).toHaveLength(1);
    expect(written.items[0]?.file).toBe('snippets/java-01.java');
  });
});

function fullManifest(): CodeBlockManifest {
  return {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items: [
      { action: 'update', groupId: 'group-001', blockId: 'java-1', language: 'java', file: 'snippets/java-01.java' },
      { action: 'update', groupId: 'group-001', blockId: 'js-1', language: 'javascript', file: 'snippets/javascript-01.js' },
      { action: 'update', groupId: 'group-001', blockId: 'go-1', language: 'go', file: 'snippets/go-01.go' },
      { action: 'update', groupId: 'group-001', blockId: 'rest-1', language: 'restful', file: 'snippets/restful-01.sh' }
    ]
  };
}
