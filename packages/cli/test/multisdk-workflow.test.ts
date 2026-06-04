import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import {
  applyMultisdkLocalReview,
  authorMultisdkTask,
  auditMultisdkLanguage,
  configureMultisdkEnvironment,
  finalizeMultisdkTask,
  initMultisdkTask,
  prepareMultisdkTask,
  recordMultisdkPush,
  validateMultisdkTask
} from '../src/multisdk/workflow.js';
import { createInitialMultisdkTask, loadMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk workflow', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('initializes only the requested language lane', async () => {
    const dir = await tempDir();

    const result = await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java',
      inventory: inventory()
    });

    expect(result.task.language).toBe('java');
    expect(result.task.languages).toEqual(['java']);
    expect(result.task.status).toBe('initialized');
    expect(result.files.every((file) => file.includes('/java-'))).toBe(true);
    await expect(readFile(join(dir, 'snippets/java-01-create-a-collection.java'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(dir, 'snippets/javascript-01-create-a-collection.js'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('configures Milvus target before prepare', async () => {
    const dir = await tempDir();
    await saveMultisdkTask(createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    }));

    await expect(prepareMultisdkTask({
      taskDir: dir,
      remoteMarkdownPath: join(dir, 'inputs/remote.md'),
      snippetPaths: []
    })).rejects.toThrow(/Milvus target/);

    const task = await configureMultisdkEnvironment({
      taskDir: dir,
      milvusTarget: { kind: 'released-version', version: '2.6.0' }
    });

    expect(task.status).toBe('environment-ready');
    expect(task.runner).toBe('manta');
    expect(task.milvusTarget).toEqual({ kind: 'released-version', version: '2.6.0' });
  });

  it('prepares verifier artifacts, validates, writes local review, records push, and audits', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'inputs'), { recursive: true });
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'inputs/remote.md'), '# Docs\n\n```python\nclient.create_index()\n```\n', 'utf8');
    await writeFile(join(dir, 'snippets/java-01-create-index.java'), 'client.createIndex(request);', 'utf8');
    const base = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    });
    await saveMultisdkTask({
      ...base,
      status: 'environment-ready',
      milvusTarget: { kind: 'released-version', version: '2.6.0' }
    });

    const prepared = await prepareMultisdkTask({
      taskDir: dir,
      remoteMarkdownPath: join(dir, 'inputs/remote.md'),
      snippetPaths: [join(dir, 'snippets/java-01-create-index.java')]
    });
    expect(prepared.task.status).toBe('prepared');
    expect(prepared.task.lane.prepared).toBe(true);
    expect(prepared.command).toBe('mvn test');

    await expect(validateMultisdkTask({
      taskDir: dir,
      command: 'mvn test',
      evidencePath: join(dir, 'evidence.log'),
      runner: 'manta'
    })).rejects.toThrow(/authored snippets/);

    await writeFile(join(dir, 'snippets/empty.java'), '  \n', 'utf8');
    await expect(authorMultisdkTask({
      taskDir: dir,
      snippetPaths: [join(dir, 'snippets/empty.java')]
    })).rejects.toThrow(/empty snippets/);

    const authored = await authorMultisdkTask({
      taskDir: dir,
      snippetPaths: [join(dir, 'snippets/java-01-create-index.java')]
    });
    expect(authored.task.status).toBe('authored');
    expect(authored.task.lane.authored).toBe(true);
    await expect(readFile(join(dir, 'work/java/snippets/java-01-create-index.java'), 'utf8'))
      .resolves.toBe('client.createIndex(request);');

    await expect(validateMultisdkTask({
      taskDir: dir,
      command: 'mvn test',
      evidencePath: join(dir, 'missing-evidence.log'),
      runner: 'manta'
    })).rejects.toThrow(/validation evidence file/);

    await writeFile(join(dir, 'failed-evidence.log'), 'BUILD FAILURE\nTests run: 2, Failures: 0, Errors: 2\n', 'utf8');
    await expect(validateMultisdkTask({
      taskDir: dir,
      command: 'mvn test',
      evidencePath: join(dir, 'failed-evidence.log'),
      runner: 'manta'
    })).rejects.toThrow(/does not prove successful live Milvus validation/);

    await writeFile(join(dir, 'evidence.log'), 'PASS live Milvus validation\n', 'utf8');
    const validated = await validateMultisdkTask({
      taskDir: dir,
      command: 'mvn test',
      evidencePath: join(dir, 'evidence.log'),
      runner: 'manta',
      jobId: 'job-123'
    });
    expect(validated.status).toBe('validated');
    expect(validated.lane.evidence[0]).toEqual(expect.objectContaining({
      runner: 'manta',
      command: 'mvn test',
      jobId: 'job-123',
      milvusTarget: { kind: 'released-version', version: '2.6.0' }
    }));

    const local = await applyMultisdkLocalReview({
      taskDir: dir,
      remoteMarkdownPath: join(dir, 'inputs/remote.md'),
      snippetPaths: [join(dir, 'snippets/java-01-create-index.java')]
    });
    expect(local.task.status).toBe('local-applied');
    await expect(readFile(local.markdownPath, 'utf8')).resolves.toContain('```java');

    const dryRun = await recordMultisdkPush({
      taskDir: dir,
      mode: 'dry-run',
      command: 'md2feishu push outputs/review.md doc-url'
    });
    expect(dryRun.status).toBe('remote-dry-run');
    expect(dryRun.remotePush?.dryRunAt).toBeTruthy();

    const written = await recordMultisdkPush({
      taskDir: dir,
      mode: 'write',
      command: 'md2feishu push outputs/review.md doc-url --write -y',
      resultPath: 'outputs/push-result.json'
    });
    expect(written.status).toBe('remote-written');
    expect(written.lane.remoteWritten).toBe(true);

    const audited = await auditMultisdkLanguage({
      taskDir: dir,
      inventory: inventoryWithLanguages(['python', 'java'])
    });
    expect(audited.task.status).toBe('audited');
    expect(audited.task.finalAuditPassed).toBe(true);

    const final = await finalizeMultisdkTask({
      taskDir: dir,
      inventory: inventoryWithLanguages(['python', 'java'])
    });
    expect(final.task.finalAuditPassed).toBe(true);
    await expect(readFile(join(dir, 'handoff.md'), 'utf8')).resolves.toContain('Language: java');

    const loaded = await loadMultisdkTask(dir);
    expect(loaded.languages).toEqual(['java']);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-workflow-'));
  tempDirs.push(dir);
  return dir;
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
