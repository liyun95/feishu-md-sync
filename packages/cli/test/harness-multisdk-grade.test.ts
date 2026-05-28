import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gradeMultisdkTask,
  renderHarnessGradeMarkdown,
  writeHarnessGradeArtifacts
} from '../src/harness/multisdk-grade.js';
import { appendHarnessTraceEvent } from '../src/harness/trace.js';
import { MULTISDK_LANGUAGES } from '../src/multisdk/language.js';
import { createInitialMultisdkTask, saveMultisdkTask, type MultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk harness grader', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('grades a fresh task as incomplete and suggests the next export command', async () => {
    const dir = await tempDir();
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('incomplete');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-status',
      passed: false,
      severity: 'incomplete'
    }));
    expect(grade.nextCommands[0]).toBe(`md2feishu multisdk export ${dir} --language java`);
  });

  it('blocks a written language that has no validation evidence', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: {
          ...task.languages.java,
          status: 'written',
          snippetsReady: true,
          validated: false,
          dryRunPassed: true,
          writePassed: true,
          evidence: []
        }
      }
    });

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('blocked');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-evidence',
      passed: false,
      severity: 'blocked'
    }));
  });

  it('blocks a final-passed task when trace is missing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'handoff.md'), '# handoff\n', 'utf8');
    await saveMultisdkTask(completedTask(dir, true));

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('blocked');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'trace-exists',
      passed: false,
      severity: 'blocked'
    }));
  });

  it('passes a completed task with final audit, handoff, evidence, and trace', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'handoff.md'), '# handoff\n', 'utf8');
    await writeFile(join(dir, 'evidence/evidence.json'), JSON.stringify({
      kind: 'feishu-multisdk-evidence',
      version: 1,
      items: MULTISDK_LANGUAGES.map((language) => ({
        language,
        path: `evidence/${language}.log`,
        command: `${language} smoke`,
        recordedAt: '2026-05-26T00:00:00.000Z'
      }))
    }, null, 2), 'utf8');
    await saveMultisdkTask(completedTask(dir, true));
    for (const language of MULTISDK_LANGUAGES) {
      await appendHarnessTraceEvent({
        workflow: 'multisdk',
        taskDir: dir,
        tool: 'multisdk.verify',
        mode: 'record-evidence',
        status: 'passed',
        startedAt: '2026-05-26T00:00:00.000Z',
        endedAt: '2026-05-26T00:00:01.000Z',
        arguments: { language },
        summary: `${language} verification recorded.`,
        eventId: `verify-${language}`
      });
      await appendHarnessTraceEvent({
        workflow: 'multisdk',
        taskDir: dir,
        tool: 'multisdk.apply',
        mode: 'dry-run',
        status: 'passed',
        startedAt: '2026-05-26T00:00:01.000Z',
        endedAt: '2026-05-26T00:00:02.000Z',
        arguments: { language, write: false },
        summary: `${language} apply dry-run passed.`,
        eventId: `dry-run-${language}`
      });
      await appendHarnessTraceEvent({
        workflow: 'multisdk',
        taskDir: dir,
        tool: 'multisdk.apply',
        mode: 'write',
        status: 'passed',
        startedAt: '2026-05-26T00:00:02.000Z',
        endedAt: '2026-05-26T00:00:03.000Z',
        arguments: { language, write: true },
        summary: `${language} apply write passed.`,
        eventId: `write-${language}`
      });
      await appendHarnessTraceEvent({
        workflow: 'multisdk',
        taskDir: dir,
        tool: 'multisdk.audit',
        mode: 'readback-audit',
        status: 'passed',
        startedAt: '2026-05-26T00:00:00.000Z',
        endedAt: '2026-05-26T00:00:01.000Z',
        arguments: { language },
        summary: `${language} audit passed.`,
        eventId: `audit-${language}`
      });
    }

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });
    await writeHarnessGradeArtifacts(dir, grade);

    expect(grade.result).toBe('passed');
    expect(grade.nextCommands).toEqual([]);
    expect(renderHarnessGradeMarkdown(grade)).toContain('Result: passed');
    expect(JSON.parse(await readFile(join(dir, 'grade.json'), 'utf8')).result).toBe('passed');
    await expect(readFile(join(dir, 'grade.md'), 'utf8')).resolves.toContain('Result: passed');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-grade-'));
  tempDirs.push(dir);
  return dir;
}

function completedTask(taskDir: string, finalAuditPassed: boolean): MultisdkTask {
  const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir });
  for (const language of MULTISDK_LANGUAGES) {
    task.languages[language] = {
      status: 'audited',
      sourceVerified: true,
      snippetsReady: true,
      validated: true,
      dryRunPassed: true,
      dryRunHashes: [{ file: `snippets/${language}.txt`, contentHash: `sha256:${language}` }],
      writePassed: true,
      auditPassed: true,
      evidence: [{
        path: `evidence/${language}.log`,
        command: `${language} smoke`,
        recordedAt: '2026-05-26T00:00:00.000Z'
      }]
    };
  }
  return {
    ...task,
    finalAuditPassed
  };
}
