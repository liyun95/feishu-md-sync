import type { HarnessGrade } from '../../harness/task.js';

export async function gradeReferenceReleaseTask(input: { taskDir: string }): Promise<HarnessGrade> {
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: 'sdk-reference-web-content-release',
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete',
    checks: [
      {
        id: 'reference-release-harness-v1',
        passed: false,
        severity: 'incomplete',
        message: 'Reference release grading requires explicit human release intent plus Feishu audit and web-content export adapters.'
      }
    ],
    nextCommands: ['md2feishu workflow show sdk-reference-web-content-release']
  };
}
