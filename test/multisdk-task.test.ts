import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInitialMultisdkTask,
  loadMultisdkTask,
  markLanguageStatus,
  saveMultisdkTask,
  summarizeMultisdkTask
} from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk task model', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('creates initial per-language state', () => {
    const task = createInitialMultisdkTask({
      document: 'https://zilliverse.feishu.cn/wiki/doc-token',
      documentId: 'doc-id',
      taskDir: 'runs/doc-token'
    });

    expect(task.kind).toBe('feishu-multisdk-task');
    expect(task.languageOrder).toEqual(['python', 'java', 'javascript', 'go', 'restful']);
    expect(task.languages.java.status).toBe('pending');
    expect(task.languages.javascript.status).toBe('pending');
    expect(task.languages.go.status).toBe('pending');
    expect(task.languages.restful.status).toBe('pending');
    expect(task.finalAuditPassed).toBe(false);
  });

  it('saves and loads task.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multisdk-task-'));
    tempDirs.push(dir);
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: dir
    });

    await saveMultisdkTask(task);

    expect(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'))).toEqual(task);
    await expect(loadMultisdkTask(dir)).resolves.toEqual(task);
  });

  it('updates language status without mutating other lanes', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id'
    });

    const updated = markLanguageStatus(task, 'java', 'exported');

    expect(updated.languages.java.status).toBe('exported');
    expect(updated.languages.javascript.status).toBe('pending');
    expect(task.languages.java.status).toBe('pending');
  });

  it('summarizes the task for status output', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id'
    });
    const updated = markLanguageStatus(task, 'java', 'audited');

    expect(summarizeMultisdkTask(updated)).toEqual({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id',
      languages: {
        java: 'audited',
        javascript: 'pending',
        go: 'pending',
        restful: 'pending'
      },
      finalAuditPassed: false
    });
  });
});
