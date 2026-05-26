import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  diffMultisdkLanguage,
  exportMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../src/multisdk/workflow.js';
import { createInitialMultisdkTask, loadMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

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
    const initial = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...initial,
      languages: {
        ...initial.languages,
        java: { ...initial.languages.java, status: 'exported', snippetsReady: true }
      }
    });

    const task = await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath,
      command: 'mvn test -Dtest=Smoke',
      profile: 'manta-k8s-maven',
      sdkVersion: 'milvus-sdk-java 3.0.1',
      sourceCommit: 'c7adc475',
      endpoint: 'manta-k8s'
    });

    expect(task.languages.java.status).toBe('ready');
    expect(task.languages.java.validated).toBe(true);
    expect(task.languages.java.evidence[0]).toEqual(expect.objectContaining({
      path: expect.stringMatching(/^evidence\/java-/),
      command: 'mvn test -Dtest=Smoke',
      profile: 'manta-k8s-maven',
      sdkVersion: 'milvus-sdk-java 3.0.1',
      sourceCommit: 'c7adc475',
      endpoint: 'manta-k8s'
    }));
    const evidenceJson = JSON.parse(await readFile(join(dir, 'evidence/evidence.json'), 'utf8'));
    expect(evidenceJson.items[0]).toEqual(expect.objectContaining({
      language: 'java',
      command: 'mvn test -Dtest=Smoke',
      profile: 'manta-k8s-maven',
      sdkVersion: 'milvus-sdk-java 3.0.1',
      sourceCommit: 'c7adc475'
    }));
    await expect(readFile(join(dir, 'evidence/evidence.md'), 'utf8')).resolves.toContain('milvus-sdk-java 3.0.1');
  });

  it('requires verification and dry-run before write apply', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true }
      }
    });
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
    expect(write.task.languages.javascript.snippetsReady).toBe(false);
    expect(client.batchUpdateBlocks).toHaveBeenCalledTimes(1);
  });

  it('clears stale verification evidence when a language is exported again', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const initial = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...initial,
      languages: {
        ...initial.languages,
        java: { ...initial.languages.java, status: 'exported', snippetsReady: true }
      }
    });
    await writeFile(join(dir, 'java-smoke.log'), 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath: join(dir, 'java-smoke.log'),
      command: 'java Smoke'
    });

    const exported = await exportMultisdkLanguage({
      document: 'doc-url',
      taskDir: dir,
      language: 'java',
      inventory: inventoryWithLanguages(['python', 'java'])
    });

    expect(exported.task.languages.java.status).toBe('exported');
    expect(exported.task.languages.java.validated).toBe(false);
    expect(exported.task.languages.java.dryRunPassed).toBe(false);
    expect(exported.task.languages.java.evidence).toEqual([]);
    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client: fakeApplyClient() }))
      .rejects.toThrow(/requires verification evidence/);
  });

  it('requires later languages to be re-exported after a preceding language write', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'snippets/javascript-01.js'), 'console.log("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
      ...manifest(),
      items: [
        {
          action: 'insert',
          groupId: 'group-001',
          anchorBlockId: 'python-1',
          insertAfterBlockId: 'python-1',
          parentBlockId: 'doc',
          language: 'java',
          file: 'snippets/java-01.java'
        },
        {
          action: 'insert',
          groupId: 'group-001',
          anchorBlockId: 'python-1',
          insertAfterBlockId: 'python-1',
          parentBlockId: 'doc',
          language: 'javascript',
          file: 'snippets/javascript-01.js'
        }
      ]
    } satisfies CodeBlockManifest, null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true },
        javascript: { ...task.languages.javascript, status: 'exported', snippetsReady: true }
      }
    });
    await writeFile(join(dir, 'java-smoke.log'), 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath: join(dir, 'java-smoke.log'),
      command: 'java Smoke'
    });
    const client = fakeApplyClient();

    await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: false, client });
    await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client });

    const updated = await loadMultisdkTask(dir);
    expect(updated.languages.javascript.status).toBe('pending');
    expect(updated.languages.javascript.snippetsReady).toBe(false);
    expect(updated.languages.javascript.evidence).toEqual([]);
    await writeFile(join(dir, 'javascript-smoke.log'), 'PASS\n', 'utf8');
    await expect(recordMultisdkVerification({
      taskDir: dir,
      language: 'javascript',
      evidencePath: join(dir, 'javascript-smoke.log'),
      command: 'node smoke.mjs'
    })).rejects.toThrow(/requires fresh exported snippets/);
    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'javascript', write: false, client }))
      .rejects.toThrow(/requires fresh exported snippets/);
  });

  it('requires a fresh dry-run when snippet content changes before write', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true }
      }
    });
    await writeFile(join(dir, 'java-smoke.log'), 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath: join(dir, 'java-smoke.log'),
      command: 'java Smoke'
    });
    const client = fakeApplyClient();

    await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: false, client });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("changed");', 'utf8');

    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client }))
      .rejects.toThrow(/requires a fresh dry-run because snippet content changed/);
    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
  });

  it('builds a language-scoped diff report before apply', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'snippets/go-01.go'), 'fmt.Println("ok")', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({
      ...manifest(),
      items: [
        { action: 'update', groupId: 'group-001', blockId: 'java-1', language: 'java', file: 'snippets/java-01.java' },
        { action: 'update', groupId: 'group-001', blockId: 'go-1', language: 'go', file: 'snippets/go-01.go' }
      ]
    } satisfies CodeBlockManifest, null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true }
      }
    });

    const result = await diffMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      client: {
        getDocumentBlocks: vi.fn(async () => [
          codeBlock('java-1', '// java', 29),
          codeBlock('go-1', '// go', 22)
        ])
      }
    });

    expect(result.task.documentId).toBe('doc');
    expect(result.report.items).toHaveLength(1);
    expect(result.report.items[0]).toEqual(expect.objectContaining({
      action: 'update',
      language: 'java',
      blockId: 'java-1',
      isPlaceholder: true
    }));
  });

  it('requires fresh snippets before building a language-scoped diff report', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask(task);

    await expect(diffMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      client: { getDocumentBlocks: vi.fn(async () => []) }
    })).rejects.toThrow(/requires fresh exported snippets/);
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
