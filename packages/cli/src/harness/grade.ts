import { gradeReferenceAuthoringTask } from '../workflows/reference/grader.js';
import { gradeReferenceReleaseTask } from '../workflows/reference-release/grader.js';
import { gradeReleaseNotesTask } from '../workflows/release-notes/grader.js';
import { gradeSyncTask } from '../workflows/sync/grader.js';
import { gradeMultisdkTask } from './multisdk-grade.js';
import type { HarnessGrade, HarnessWorkflow } from './task.js';

export async function gradeHarnessTask(input: { workflow: HarnessWorkflow; taskDir: string }): Promise<HarnessGrade> {
  if (input.workflow === 'multisdk' || input.workflow === 'multisdk-examples') {
    return gradeMultisdkTask({ taskDir: input.taskDir });
  }
  if (input.workflow === 'baseline-sync' || input.workflow === 'publish-new' || input.workflow === 'push') {
    return gradeSyncTask({ taskDir: input.taskDir, workflow: input.workflow });
  }
  if (input.workflow === 'sdk-reference-authoring') return gradeReferenceAuthoringTask({ taskDir: input.taskDir });
  if (input.workflow === 'sdk-reference-web-content-release') return gradeReferenceReleaseTask({ taskDir: input.taskDir });
  return gradeReleaseNotesTask({ taskDir: input.taskDir });
}
