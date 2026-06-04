import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInitialMultisdkTask,
  loadMultisdkTask,
  saveMultisdkTask,
  summarizeMultisdkTask
} from '../src/multisdk/task.js';
import { renderMultisdkHandoff } from '../src/multisdk/handoff.js';

const tempDirs: string[] = [];

describe('multisdk task model', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('creates a single-language local-first task', () => {
    const task = createInitialMultisdkTask({
      document: 'https://zilliverse.feishu.cn/wiki/doc',
      documentId: 'doc',
      taskDir: 'runs/doc-java',
      language: 'java'
    });

    expect(task.language).toBe('java');
    expect(task.languages).toEqual(['java']);
    expect(task.status).toBe('initialized');
    expect(task.milvusTarget).toBeNull();
    expect(task.localReview).toBeNull();
    expect(task.remotePush).toBeNull();
    expect(task.lane).toEqual(expect.objectContaining({
      language: 'java',
      prepared: false,
      authored: false,
      validated: false,
      localApplied: false,
      remoteWritten: false,
      audited: false
    }));
  });

  it('saves and loads task.json', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: dir,
      language: 'java'
    });

    await saveMultisdkTask(task);

    expect(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'))).toEqual(task);
    await expect(loadMultisdkTask(dir)).resolves.toEqual(task);
  });

  it('summarizes the task for status output', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id-java',
      language: 'java'
    });

    expect(summarizeMultisdkTask({
      ...task,
      status: 'validated',
      milvusTarget: { kind: 'released-version', version: '2.6.0' }
    })).toEqual({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id-java',
      language: 'java',
      status: 'validated',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      localReview: null,
      finalAuditPassed: false
    });
  });

  it('renders local review and push state in the handoff summary', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id-java',
      language: 'java'
    });

    const handoff = renderMultisdkHandoff({
      ...task,
      status: 'audited',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      lane: {
        ...task.lane,
        prepared: true,
        authored: true,
        validated: true,
        localApplied: true,
        remoteWritten: true,
        audited: true,
        evidence: [{
          runner: 'manta',
          command: 'mvn test',
          evidencePath: 'evidence/manta-job-123.log',
          recordedAt: '2026-05-31T00:00:00.000Z',
          milvusTarget: { kind: 'released-version', version: '2.6.0' },
          jobId: 'job-123'
        }]
      },
      localReview: {
        markdownPath: 'outputs/review.md',
        diffPath: 'outputs/review.diff',
        generatedAt: '2026-05-31T00:00:00.000Z'
      },
      remotePush: {
        writeAt: '2026-05-31T00:01:00.000Z',
        command: 'md2feishu push outputs/review.md doc-url --write -y'
      },
      finalAuditPassed: true
    });

    expect(handoff).toContain('Language: java');
    expect(handoff).toContain('Manta job: job-123');
    expect(handoff).toContain('markdown: outputs/review.md');
    expect(handoff).toContain('md2feishu push outputs/review.md doc-url --write -y');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-task-'));
  tempDirs.push(dir);
  return dir;
}
