import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import { readHarnessTraceEvents } from '../src/harness/trace.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';
import {
  applyMultisdkLocalReview,
  configureMultisdkEnvironment,
  initMultisdkTask,
  validateMultisdkTask
} from '../src/multisdk/workflow.js';

const tempDirs: string[] = [];

describe('multisdk harness trace integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes trace events for init and environment configuration', async () => {
    const dir = await tempDir();
    await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java',
      inventory: inventory()
    });
    await configureMultisdkEnvironment({
      taskDir: dir,
      milvusTarget: { kind: 'released-version', version: '2.6.0' }
    });

    const events = await readHarnessTraceEvents(dir);
    expect(events.map((event) => event.tool)).toEqual(['multisdk.init', 'multisdk.environment']);
    expect(events[0]).toEqual(expect.objectContaining({
      workflow: 'multisdk',
      status: 'passed',
      mode: 'initialize'
    }));
    expect(events[1].arguments).toEqual(expect.objectContaining({ language: 'java' }));
  });

  it('writes a failed trace event when apply-local is blocked by missing evidence', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'inputs'), { recursive: true });
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'inputs/remote.md'), '# Docs\n', 'utf8');
    await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");', 'utf8');
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    });
    await saveMultisdkTask({
      ...task,
      status: 'prepared',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      lane: { ...task.lane, prepared: true, authored: true }
    });

    await expect(applyMultisdkLocalReview({
      taskDir: dir,
      remoteMarkdownPath: join(dir, 'inputs/remote.md'),
      snippetPaths: [join(dir, 'snippets/java.java')]
    })).rejects.toThrow(/validation evidence/);

    const events = await readHarnessTraceEvents(dir);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      tool: 'multisdk.apply-local',
      status: 'failed'
    }));
    expect(events.at(-1)?.summary).toContain('validation evidence');
  });

  it('traces validation evidence recording', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    });
    await saveMultisdkTask({
      ...task,
      status: 'prepared',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      lane: { ...task.lane, prepared: true, authored: true }
    });
    await writeFile(join(dir, 'evidence.log'), 'PASS\n', 'utf8');

    await validateMultisdkTask({
      taskDir: dir,
      command: 'mvn test',
      evidencePath: join(dir, 'evidence.log'),
      runner: 'manta',
      jobId: 'job-123'
    });

    const events = await readHarnessTraceEvents(dir);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      tool: 'multisdk.validate',
      mode: 'record-validation',
      status: 'passed'
    }));
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-trace-'));
  tempDirs.push(dir);
  return dir;
}

function inventory(): CodeBlockInventory {
  const pythonBlock = {
    blockId: 'python-1',
    parentBlockId: 'doc',
    childIndex: 1,
    documentIndex: 1,
    language: 'python',
    canonicalLanguage: 'python',
    text: 'print("ok")',
    isPlaceholder: false,
    heading: 'Create a collection',
    groupId: 'group-1',
    pythonAnchorBlockId: 'python-1'
  } satisfies CodeBlockInventory['blocks'][number];

  return {
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    groups: [
      {
        groupId: 'group-1',
        heading: 'Create a collection',
        pythonAnchorBlockId: 'python-1',
        parentBlockId: 'doc',
        startIndex: 1,
        endIndex: 1,
        languages: ['python'],
        missingLanguages: ['java', 'javascript', 'go', 'restful'],
        blocks: [pythonBlock]
      }
    ],
    blocks: [pythonBlock]
  };
}
