import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gradeMultisdkTask,
  renderHarnessGradeMarkdown,
  writeHarnessGradeArtifacts
} from '../src/harness/multisdk-grade.js';
import { appendHarnessTraceEvent } from '../src/harness/trace.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk harness grader', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('grades a fresh task as incomplete and asks for the Milvus target', async () => {
    const dir = await tempDir();
    await saveMultisdkTask(createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    }));

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:00:00.000Z' });

    expect(grade.result).toBe('incomplete');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-environment',
      passed: false,
      severity: 'incomplete'
    }));
    expect(grade.nextCommands[0]).toContain(`md2feishu multisdk environment ${dir} --milvus-version 2.6.0`);
  });

  it('passes a single-language task after local review, remote push, and audit', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    });
    await saveMultisdkTask({
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
        dryRunAt: '2026-05-31T00:01:00.000Z',
        writeAt: '2026-05-31T00:02:00.000Z',
        command: 'md2feishu push outputs/review.md doc-url --write -y',
        resultPath: 'outputs/push-result.json'
      },
      finalAuditPassed: true
    });
    await appendHarnessTraceEvent({
      workflow: 'multisdk',
      taskDir: dir,
      tool: 'multisdk.audit',
      mode: 'readback-audit',
      status: 'passed',
      startedAt: '2026-05-31T00:02:00.000Z',
      endedAt: '2026-05-31T00:02:01.000Z',
      arguments: { language: 'java' },
      summary: 'java audit passed.',
      eventId: 'audit-java'
    });

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:03:00.000Z' });
    await writeHarnessGradeArtifacts(dir, grade);

    expect(grade.result).toBe('passed');
    expect(grade.nextCommands).toEqual([]);
    expect(renderHarnessGradeMarkdown(grade)).toContain('Result: passed');
    expect(JSON.parse(await readFile(join(dir, 'grade.json'), 'utf8')).result).toBe('passed');
  });

  it('suggests push dry-run after local review is generated', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      language: 'java'
    });
    await saveMultisdkTask({
      ...task,
      status: 'local-applied',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      lane: {
        ...task.lane,
        prepared: true,
        authored: true,
        validated: true,
        localApplied: true,
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
      }
    });

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:03:00.000Z' });

    expect(grade.result).toBe('incomplete');
    expect(grade.nextCommands).toContain('md2feishu push outputs/review.md doc-url');
  });

  it('suggests authoring snippets after verifier preparation', async () => {
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
      lane: {
        ...task.lane,
        prepared: true
      }
    });

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:03:00.000Z' });

    expect(grade.result).toBe('incomplete');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-author',
      passed: false,
      severity: 'incomplete'
    }));
    expect(grade.nextCommands[0]).toContain(`md2feishu multisdk author ${dir}`);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-grade-'));
  tempDirs.push(dir);
  return dir;
}
