import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMultisdkTask, type MultisdkTask } from '../multisdk/task.js';
import type { HarnessGrade, HarnessGradeCheck, HarnessGradeSeverity } from './task.js';
import { readHarnessTraceEvents } from './trace.js';

export type GradeMultisdkTaskOptions = {
  taskDir: string;
  now?: () => string;
};

export async function gradeMultisdkTask(options: GradeMultisdkTaskOptions): Promise<HarnessGrade> {
  const checks: HarnessGradeCheck[] = [];
  const nextCommands: string[] = [];
  let task: MultisdkTask;

  try {
    task = await loadMultisdkTask(options.taskDir);
    checks.push(pass('task-valid', 'task.json is a valid feishu-multisdk-task.'));
  } catch (error) {
    checks.push(fail('task-valid', 'blocked', `Cannot read a valid multisdk task: ${(error as Error).message}`));
    return grade(options, checks, nextCommands);
  }

  gradeLanguage(task, checks, nextCommands);

  const traceEvents = await readHarnessTraceEvents(options.taskDir);
  if (traceEvents.length > 0) {
    checks.push(pass('trace-exists', `Trace contains ${traceEvents.length} event(s).`));
  } else if (task.finalAuditPassed) {
    checks.push(fail('trace-exists', 'blocked', 'Trace is missing even though finalAuditPassed is true.'));
  } else {
    checks.push(fail('trace-exists', 'incomplete', 'Trace is missing for this in-progress or legacy task.'));
  }

  return grade(options, checks, nextCommands);
}

export async function writeHarnessGradeArtifacts(taskDir: string, gradeResult: HarnessGrade): Promise<void> {
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'grade.json'), `${JSON.stringify(gradeResult, null, 2)}\n`, 'utf8');
  await writeFile(join(taskDir, 'grade.md'), renderHarnessGradeMarkdown(gradeResult), 'utf8');
}

export function renderHarnessGradeMarkdown(gradeResult: HarnessGrade): string {
  const lines = [
    '# Harness Grade',
    '',
    `Workflow: ${gradeResult.workflow}`,
    `Task: ${gradeResult.taskDir}`,
    `Generated: ${gradeResult.generatedAt}`,
    `Result: ${gradeResult.result}`,
    '',
    '## Checks',
    ''
  ];
  for (const check of gradeResult.checks) {
    lines.push(`- ${check.passed ? 'PASS' : check.severity.toUpperCase()}: ${check.id} - ${check.message}`);
  }
  if (gradeResult.nextCommands.length > 0) {
    lines.push('', '## Next Commands', '');
    for (const command of gradeResult.nextCommands) lines.push(`- \`${command}\``);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function gradeLanguage(
  task: MultisdkTask,
  checks: HarnessGradeCheck[],
  nextCommands: string[]
): void {
  const language = task.language;

  if (task.status === 'blocked') {
    checks.push(fail(`${language}-status`, 'blocked', task.lane.reason ?? `${language} is blocked.`));
    return;
  }
  checks.push(pass(`${language}-status`, `${language} status is ${task.status}.`));

  if (!task.milvusTarget) {
    checks.push(fail(`${language}-environment`, 'incomplete', `${language} Milvus target is missing.`));
    nextCommands.push(`Ask the user to confirm the Milvus target, then run: md2feishu multisdk environment ${task.taskDir} --milvus-version 2.6.0`);
    return;
  }
  checks.push(pass(`${language}-environment`, `${language} Milvus target is ${task.milvusTarget.version}.`));

  if (!task.lane.prepared) {
    checks.push(fail(`${language}-prepare`, 'incomplete', `${language} verifier artifacts are missing.`));
    nextCommands.push(`md2feishu multisdk prepare ${task.taskDir} --remote-markdown ${task.taskDir}/inputs/remote.md --snippet ${task.taskDir}/snippets/${snippetHint(language)}`);
    return;
  }
  checks.push(pass(`${language}-prepare`, `${language} verifier artifacts are prepared.`));

  if (!task.lane.authored) {
    checks.push(fail(`${language}-author`, task.lane.validated || task.lane.localApplied || task.lane.remoteWritten || task.lane.audited ? 'blocked' : 'incomplete', `${language} snippets have not been authored from Python context.`));
    nextCommands.push(`md2feishu multisdk author ${task.taskDir} --snippet ${task.taskDir}/snippets/${snippetHint(language)}`);
    return;
  }
  checks.push(pass(`${language}-author`, `${language} snippets are authored.`));

  if (!task.lane.validated || task.lane.evidence.length === 0) {
    checks.push(fail(`${language}-validation`, task.lane.localApplied || task.lane.remoteWritten || task.lane.audited ? 'blocked' : 'incomplete', `${language} live Milvus validation evidence is missing.`));
    nextCommands.push(`md2feishu multisdk validate ${task.taskDir} --runner manta --command "${defaultValidationCommand(language)}"`);
    return;
  }
  checks.push(pass(`${language}-validation`, `${language} has live validation evidence.`));

  if (!task.localReview || !task.lane.localApplied) {
    checks.push(fail(`${language}-local-review`, task.lane.remoteWritten || task.lane.audited ? 'blocked' : 'incomplete', `${language} local review Markdown is missing.`));
    nextCommands.push(`md2feishu multisdk apply-local ${task.taskDir} --remote-markdown ${task.taskDir}/inputs/remote.md --snippet ${task.taskDir}/snippets/${snippetHint(language)}`);
    return;
  }
  checks.push(pass(`${language}-local-review`, `${language} local review Markdown exists.`));

  if (!task.remotePush?.dryRunAt) {
    checks.push(fail(`${language}-push-dry-run`, task.lane.remoteWritten || task.lane.audited ? 'blocked' : 'incomplete', `${language} push dry-run has not been recorded.`));
    nextCommands.push(`md2feishu push ${task.localReview.markdownPath} ${task.document}`);
    return;
  }
  checks.push(pass(`${language}-push-dry-run`, `${language} push dry-run is recorded.`));

  if (!task.remotePush?.writeAt || !task.lane.remoteWritten) {
    checks.push(fail(`${language}-push-write`, task.lane.audited ? 'blocked' : 'incomplete', `${language} push write has not been recorded.`));
    nextCommands.push(`md2feishu push ${task.localReview.markdownPath} ${task.document} --write -y`);
    return;
  }
  checks.push(pass(`${language}-push-write`, `${language} push write is recorded.`));

  if (!task.lane.audited || task.status !== 'audited' || !task.finalAuditPassed) {
    checks.push(fail(`${language}-audit`, 'incomplete', `${language} readback audit has not passed.`));
    nextCommands.push(`md2feishu multisdk audit ${task.taskDir}`);
    return;
  }
  checks.push(pass(`${language}-audit`, `${language} readback audit passed.`));
}

function snippetHint(language: string): string {
  if (language === 'javascript') return 'javascript-01.js';
  if (language === 'go') return 'go-01.go';
  if (language === 'restful') return 'restful-01.sh';
  return 'java-01-create-index.java';
}

function defaultValidationCommand(language: string): string {
  if (language === 'javascript') return 'npm test';
  if (language === 'go') return 'go test ./...';
  if (language === 'restful') return 'bash test-rest.sh';
  return 'mvn test';
}

function grade(
  options: GradeMultisdkTaskOptions,
  checks: HarnessGradeCheck[],
  nextCommands: string[]
): HarnessGrade {
  const result = checks.some((check) => !check.passed && check.severity === 'blocked')
    ? 'blocked'
    : checks.some((check) => !check.passed && check.severity === 'incomplete')
      ? 'incomplete'
      : 'passed';
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: 'multisdk',
    taskDir: options.taskDir,
    generatedAt: options.now?.() ?? new Date().toISOString(),
    result,
    checks,
    nextCommands: Array.from(new Set(nextCommands))
  };
}

function pass(id: string, message: string): HarnessGradeCheck {
  return { id, passed: true, severity: 'passed', message };
}

function fail(id: string, severity: Exclude<HarnessGradeSeverity, 'passed'>, message: string): HarnessGradeCheck {
  return { id, passed: false, severity, message };
}
