import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import { readHarnessTraceEvents } from '../src/harness/trace.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';
import {
  applyMultisdkLanguage,
  initMultisdkTask,
  recordMultisdkVerification
} from '../src/multisdk/workflow.js';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';

const tempDirs: string[] = [];

describe('multisdk harness trace integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes trace events for init and verify', async () => {
    const dir = await tempDir();
    await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      inventory: inventory()
    });
    const evidencePath = join(dir, 'java.log');
    await writeFile(evidencePath, 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath,
      command: 'mvn test'
    });

    const events = await readHarnessTraceEvents(dir);
    expect(events.map((event) => event.tool)).toEqual(['multisdk.init', 'multisdk.verify']);
    expect(events[0]).toEqual(expect.objectContaining({
      workflow: 'multisdk',
      status: 'passed',
      mode: 'initialize'
    }));
    expect(events[1].arguments).toEqual(expect.objectContaining({ language: 'java' }));
    expect(events[1].artifacts.map((artifact) => artifact.path)).toContain('evidence/evidence.json');
  });

  it('writes a failed trace event when apply is blocked by missing evidence', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true }
      }
    });

    await expect(applyMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      write: true,
      client: {
        batchUpdateBlocks: vi.fn(async () => []),
        createChildren: vi.fn(async () => [])
      }
    })).rejects.toThrow(/requires verification evidence/);

    const events = await readHarnessTraceEvents(dir);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      tool: 'multisdk.apply',
      status: 'failed'
    }));
    expect(events.at(-1)?.summary).toContain('requires verification evidence');
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

function manifest(): CodeBlockManifest {
  return {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items: [
      {
        action: 'insert',
        groupId: 'group-1',
        anchorBlockId: 'python-1',
        insertAfterBlockId: 'python-1',
        parentBlockId: 'doc',
        language: 'java',
        file: 'snippets/java.java'
      }
    ]
  };
}
