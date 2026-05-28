import type { HarnessGrade } from '../../harness/task.js';

export async function gradeReferenceAuthoringTask(input: { taskDir: string }): Promise<HarnessGrade> {
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: 'sdk-reference-authoring',
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete',
    checks: [
      {
        id: 'reference-authoring-harness-v1',
        passed: false,
        severity: 'incomplete',
        message: 'Reference authoring grading requires manifest, Feishu apply, and Feishu audit adapters before this workflow can be graded as passed.'
      }
    ],
    nextCommands: ['md2feishu workflow show sdk-reference-authoring']
  };
}
