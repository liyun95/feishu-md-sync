import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodeBlockDiffReport, renderCodeBlockDiffReport } from '../src/sync/code-block-diff.js';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';

const tempDirs: string[] = [];

describe('code-block diff', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('builds a block-level update diff with hashes, placeholder state, and previews', async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");\n', 'utf8');
    await writeManifest(dir, [
      {
        action: 'update',
        groupId: 'group-001',
        blockId: 'java-1',
        language: 'java',
        file: 'snippets/java.java'
      }
    ]);
    const client = {
      getDocumentBlocks: vi.fn(async () => [
        codeBlock('java-1', '// java\n', 29)
      ])
    };

    const report = await buildCodeBlockDiffReport(client, {
      manifestPath: join(dir, 'manifest.json')
    });

    expect(report.items).toEqual([
      expect.objectContaining({
        action: 'update',
        groupId: 'group-001',
        language: 'java',
        blockId: 'java-1',
        file: 'snippets/java.java',
        currentHash: expect.stringMatching(/^sha256:/),
        desiredHash: expect.stringMatching(/^sha256:/),
        isPlaceholder: true,
        currentPreview: '// java',
        desiredPreview: 'System.out.println("ok");'
      })
    ]);
    expect(report.items[0].diff).toContain('--- remote:group-001:java:java-1');
    expect(report.items[0].diff).toContain('+++ local:snippets/java.java');
    expect(report.items[0].diff).toContain('+System.out.println("ok");');
    expect(renderCodeBlockDiffReport(report)).toContain('placeholder: yes');
  });

  it('represents inserts as a diff from an empty remote block', async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, 'snippets/restful.sh'), 'curl http://localhost:19530/v2/vectordb/collections/list\n', 'utf8');
    await writeManifest(dir, [
      {
        action: 'insert',
        groupId: 'group-001',
        anchorBlockId: 'python-1',
        insertAfterBlockId: 'python-1',
        parentBlockId: 'doc',
        language: 'restful',
        file: 'snippets/restful.sh'
      }
    ]);

    const report = await buildCodeBlockDiffReport({ getDocumentBlocks: vi.fn(async () => []) }, {
      manifestPath: join(dir, 'manifest.json')
    });

    expect(report.items[0]).toEqual(expect.objectContaining({
      action: 'insert',
      groupId: 'group-001',
      anchorBlockId: 'python-1',
      insertAfterBlockId: 'python-1',
      parentBlockId: 'doc',
      currentHash: undefined,
      isPlaceholder: undefined
    }));
    expect(report.items[0].diff).toContain('--- remote:group-001:restful:new');
    expect(report.items[0].diff).toContain('+curl http://localhost:19530/v2/vectordb/collections/list');
  });

  it('fails when an update manifest points at a missing remote code block', async () => {
    const dir = await fixtureDir();
    await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");\n', 'utf8');
    await writeManifest(dir, [
      {
        action: 'update',
        groupId: 'group-001',
        blockId: 'missing-java-1',
        language: 'java',
        file: 'snippets/java.java'
      }
    ]);

    await expect(buildCodeBlockDiffReport({ getDocumentBlocks: vi.fn(async () => []) }, {
      manifestPath: join(dir, 'manifest.json')
    })).rejects.toThrow(/missing remote block missing-java-1/);
  });
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-code-diff-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'snippets'), { recursive: true });
  return dir;
}

async function writeManifest(dir: string, items: CodeBlockManifest['items']): Promise<void> {
  const manifest: CodeBlockManifest = {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function codeBlock(blockId: string, text: string, language: number) {
  return {
    block_id: blockId,
    block_type: 14,
    code: {
      elements: [{
        text_run: {
          content: text,
          text_element_style: {}
        }
      }],
      style: { language }
    }
  };
}
