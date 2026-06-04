import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gradeHarnessTask } from '../src/harness/grade.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('harness grade dispatcher', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('dispatches multisdk aliases to the existing multisdk grader', async () => {
    const dir = await tempDir();
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir, language: 'java' }));

    const grade = await gradeHarnessTask({ workflow: 'multisdk-examples', taskDir: dir });

    expect(grade.workflow).toBe('multisdk');
    expect(grade.nextCommands[0]).toContain(`md2feishu multisdk environment ${dir} --milvus-version 2.6.0`);
  });

  it('dispatches non-multisdk workflows to conservative graders', async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });

    const grade = await gradeHarnessTask({ workflow: 'sdk-reference-web-content-release', taskDir: dir });

    expect(grade.workflow).toBe('sdk-reference-web-content-release');
    expect(grade.result).toBe('incomplete');
    expect(grade.nextCommands).toEqual(['md2feishu workflow show sdk-reference-web-content-release']);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-dispatch-'));
  tempDirs.push(dir);
  return dir;
}
