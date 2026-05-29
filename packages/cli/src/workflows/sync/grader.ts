import type { HarnessGrade } from '../../harness/task.js';

export async function gradeSyncTask(input: {
  taskDir: string;
  workflow: 'baseline-sync' | 'push';
}): Promise<HarnessGrade> {
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: input.workflow,
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete',
    checks: [
      {
        id: 'sync-harness-v1',
        passed: false,
        severity: 'incomplete',
        message: 'Sync harness grading requires receipt and patch-plan adapters before this workflow can be graded as passed.'
      }
    ],
    nextCommands: [`md2feishu workflow show ${input.workflow}`]
  };
}
