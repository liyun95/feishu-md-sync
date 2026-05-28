import type { HarnessGrade } from '../../harness/task.js';

export async function gradeReleaseNotesTask(input: { taskDir: string }): Promise<HarnessGrade> {
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: 'release-notes',
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete',
    checks: [
      {
        id: 'release-notes-harness-v1',
        passed: false,
        severity: 'incomplete',
        message: 'Release notes grading requires release task, audit report, approval hash, and apply-state adapters.'
      }
    ],
    nextCommands: ['md2feishu workflow show release-notes']
  };
}
