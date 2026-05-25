import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReleaseTask } from '../src/release/task.js';
import {
  initReleaseWorkflow,
  approveReleaseWorkflow,
  statusReleaseWorkflow
} from '../src/release/workflow.js';
import { createInitialReleaseTask, saveReleaseTask, summarizeReleaseTask } from '../src/release/task.js';

const tempDirs: string[] = [];

describe('release workflow orchestration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('initializes a task directory with workflow subdirectories and task state', async () => {
    const dir = await tempDir();

    const task = await initReleaseWorkflow({
      releaseLine: '2.6.x',
      releaseVersion: '2.6.17',
      releaseDoc: 'doc-url',
      documentId: 'doc-token',
      milvusDocsPath: '/repo/milvus-docs',
      taskDir: dir,
      userDocs: [{ localPath: 'site/en/userGuide/example.md', feishuDoc: 'wiki-url' }],
      linkMapPath: 'release-links.json'
    });

    expect(task.status).toBe('initialized');
    await expect(readFile(join(dir, 'task.json'), 'utf8')).resolves.toContain('"releaseVersion": "2.6.17"');
    await expect(directoryExists(join(dir, 'feishu'))).resolves.toBe(true);
    await expect(directoryExists(join(dir, 'sdk'))).resolves.toBe(true);
    await expect(directoryExists(join(dir, 'audit'))).resolves.toBe(true);
  });

  it('records approval metadata and persists the updated task', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'audit'), { recursive: true });
    await writeFile(join(dir, 'audit/report.json'), '{"ok":true}\n', 'utf8');
    await writeFile(join(dir, 'audit/report.md'), '# Report\n', 'utf8');
    await saveReleaseTask(taskFixture(dir));

    const approved = await approveReleaseWorkflow({
      taskDir: dir,
      approvedBy: 'release-owner',
      approvedAt: '2026-05-25T00:00:00.000Z'
    });

    const approvals = JSON.parse(await readFile(join(dir, 'approvals.json'), 'utf8')) as {
      approvals: Array<{ reportHash: string; approvedBy: string; approvedAt: string }>;
    };
    const saved = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')) as ReleaseTask;

    expect(approved.status).toBe('approved');
    expect(approved.reportHash).toMatch(/^sha256:/);
    expect(approvals.approvals).toEqual([approved.approval]);
    expect(saved.status).toBe('approved');
    expect(saved.steps.approved).toBe(true);
    expect(saved.reportHash).toBe(approved.reportHash);
  });

  it('returns the task summary for status output', async () => {
    const dir = await tempDir();
    const task = taskFixture(dir);
    await saveReleaseTask(task);

    await expect(statusReleaseWorkflow(dir)).resolves.toEqual(summarizeReleaseTask(task));
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'release-workflow-'));
  tempDirs.push(dir);
  return dir;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function taskFixture(taskDir: string): ReleaseTask {
  return createInitialReleaseTask({
    releaseLine: '2.6.x',
    releaseVersion: '2.6.17',
    releaseDoc: 'doc-url',
    documentId: 'doc-token',
    milvusDocsPath: '/repo/milvus-docs',
    taskDir,
    userDocs: [],
    linkMapPath: undefined
  });
}
