import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../src/multisdk/workflow.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk workflow', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('initializes a task directory with manifest, snippets, and task state', async () => {
    const dir = await tempDir();

    const result = await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      inventory: inventory()
    });

    expect(result.task.languages.java.status).toBe('exported');
    expect(result.task.languages.javascript.status).toBe('exported');
    expect(result.task.languages.go.status).toBe('exported');
    expect(result.task.languages.restful.status).toBe('exported');
    await expect(readFile(join(dir, 'manifest.json'), 'utf8')).resolves.toContain('"documentId": "doc"');
    await expect(readFile(join(dir, 'snippets/java-01-create-a-collection.java'), 'utf8')).resolves.toBe('');
  });

  it('records verification evidence and marks the language ready', async () => {
    const dir = await tempDir();
    const evidencePath = join(dir, 'java-smoke.log');
    await writeFile(evidencePath, 'PASS java smoke\n', 'utf8');
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));

    const task = await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath,
      command: 'mvn test -Dtest=Smoke'
    });

    expect(task.languages.java.status).toBe('ready');
    expect(task.languages.java.validated).toBe(true);
    expect(task.languages.java.evidence[0]).toEqual(expect.objectContaining({
      path: expect.stringMatching(/^evidence\/java-/),
      command: 'mvn test -Dtest=Smoke'
    }));
  });

  it('requires verification and dry-run before write apply', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));
    const client = fakeApplyClient();

    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client }))
      .rejects.toThrow(/requires verification evidence/);

    await writeFile(join(dir, 'java-smoke.log'), 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath: join(dir, 'java-smoke.log'),
      command: 'java Smoke'
    });
    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client }))
      .rejects.toThrow(/requires a successful dry-run/);

    const dryRun = await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: false, client });
    expect(dryRun.task.languages.java.status).toBe('dry-run-passed');

    const write = await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client });
    expect(write.task.languages.java.status).toBe('written');
    expect(client.batchUpdateBlocks).toHaveBeenCalledTimes(1);
  });

  it('audits one language and finalizes only after all languages are audited', async () => {
    const dir = await tempDir();
    const base = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...base,
      languages: {
        java: { ...base.languages.java, status: 'written', auditPassed: false },
        javascript: { ...base.languages.javascript, status: 'audited', auditPassed: true },
        go: { ...base.languages.go, status: 'audited', auditPassed: true },
        restful: { ...base.languages.restful, status: 'audited', auditPassed: true }
      }
    });

    const audited = await auditMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      inventory: inventoryWithLanguages(['python', 'java', 'javascript', 'go', 'restful'])
    });
    expect(audited.task.languages.java.status).toBe('audited');

    const final = await finalizeMultisdkTask({
      taskDir: dir,
      inventory: inventoryWithLanguages(['python', 'java', 'javascript', 'go', 'restful'])
    });
    expect(final.task.finalAuditPassed).toBe(true);
    await expect(readFile(join(dir, 'handoff.md'), 'utf8')).resolves.toContain('Final audit: passed');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-workflow-'));
  tempDirs.push(dir);
  return dir;
}

function manifest(): CodeBlockManifest {
  return {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items: [
      { action: 'update', groupId: 'group-001', blockId: 'java-1', language: 'java', file: 'snippets/java-01.java' }
    ]
  };
}

function fakeApplyClient() {
  return {
    batchUpdateBlocks: vi.fn(async () => [{ block_id: 'java-1', block_type: 14 }]),
    createChildren: vi.fn(async () => [{ block_id: 'created-1', block_type: 14 }]),
    getDocumentBlocks: vi.fn(async () => [
      { block_id: 'doc', block_type: 1, children: ['python-1', 'java-1'] },
      { block_id: 'python-1', block_type: 14 },
      { block_id: 'java-1', block_type: 14 }
    ])
  };
}

function inventory(): CodeBlockInventory {
  return inventoryWithLanguages(['python']);
}

function inventoryWithLanguages(languages: Array<'python' | 'java' | 'javascript' | 'go' | 'restful'>): CodeBlockInventory {
  const blocks = languages.map((language, index) => block(language, index + 1));
  return {
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    groups: [{
      groupId: 'group-001',
      heading: 'Create a collection',
      pythonAnchorBlockId: 'python-1',
      parentBlockId: 'doc',
      startIndex: 1,
      endIndex: blocks[blocks.length - 1]?.childIndex ?? 1,
      languages,
      missingLanguages: ['java', 'javascript', 'go', 'restful'].filter((language) => !languages.includes(language)) as CodeBlockInventory['languageOrder'],
      blocks
    }],
    blocks
  };
}

function block(
  language: 'python' | 'java' | 'javascript' | 'go' | 'restful',
  childIndex: number
): CodeBlockInventory['blocks'][number] {
  const blockId = `${language === 'javascript' ? 'js' : language}-1`;
  return {
    blockId,
    parentBlockId: 'doc',
    childIndex,
    documentIndex: childIndex,
    language,
    canonicalLanguage: language,
    text: language === 'python' ? 'from pymilvus import MilvusClient' : `${language} snippet`,
    isPlaceholder: false,
    heading: 'Create a collection',
    groupId: 'group-001',
    pythonAnchorBlockId: 'python-1'
  };
}
