import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MULTISDK_LANGUAGES, type MultisdkLanguage } from '../multisdk/language.js';
import { loadMultisdkTask, type MultisdkTask } from '../multisdk/task.js';
import { readHarnessTraceEvents, type HarnessTraceEvent } from './trace.js';

export type HarnessGradeResult = 'passed' | 'blocked' | 'incomplete';
export type HarnessGradeSeverity = 'passed' | 'blocked' | 'incomplete';

export type HarnessGradeCheck = {
  id: string;
  passed: boolean;
  severity: HarnessGradeSeverity;
  message: string;
};

export type HarnessGrade = {
  kind: 'feishu-harness-grade';
  version: 1;
  workflow: 'multisdk';
  taskDir: string;
  generatedAt: string;
  result: HarnessGradeResult;
  checks: HarnessGradeCheck[];
  nextCommands: string[];
};

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

  const traceEvents = await readHarnessTraceEvents(options.taskDir);
  for (const language of MULTISDK_LANGUAGES) {
    gradeLanguage(task, language, traceEvents, checks, nextCommands);
  }

  if (traceEvents.length > 0) {
    checks.push(pass('trace-exists', `Trace contains ${traceEvents.length} event(s).`));
  } else if (task.finalAuditPassed) {
    checks.push(fail('trace-exists', 'blocked', 'Trace is missing even though finalAuditPassed is true.'));
  } else {
    checks.push(fail('trace-exists', 'incomplete', 'Trace is missing for this in-progress or legacy task.'));
  }

  if (task.finalAuditPassed) {
    const handoffExists = await exists(join(options.taskDir, 'handoff.md'));
    checks.push(handoffExists
      ? pass('handoff-exists', 'handoff.md exists.')
      : fail('handoff-exists', 'blocked', 'handoff.md is required when finalAuditPassed is true.'));
  } else {
    checks.push(fail('final-audit', 'incomplete', 'Final multi-SDK audit has not passed.'));
    if (!nextCommands.includes(`md2feishu multisdk finalize ${options.taskDir}`)) {
      nextCommands.push(`md2feishu multisdk finalize ${options.taskDir}`);
    }
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
  language: MultisdkLanguage,
  traceEvents: HarnessTraceEvent[],
  checks: HarnessGradeCheck[],
  nextCommands: string[]
): void {
  const state = task.languages[language];
  if (state.status === 'blocked') {
    checks.push(fail(`${language}-status`, 'blocked', state.reason ?? `${language} is blocked.`));
    return;
  }

  if (state.status === 'pending') {
    checks.push(fail(`${language}-status`, 'incomplete', `${language} has not been exported.`));
    nextCommands.push(`md2feishu multisdk export ${task.taskDir} --language ${language}`);
    return;
  }

  checks.push(pass(`${language}-status`, `${language} status is ${state.status}.`));

  if (!state.snippetsReady) {
    checks.push(fail(`${language}-snippets`, 'blocked', `${language} is beyond pending but snippetsReady is false.`));
    nextCommands.push(`md2feishu multisdk export ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-snippets`, `${language} snippets are ready.`));

  if (!state.validated || state.evidence.length === 0) {
    const severity: HarnessGradeSeverity = state.writePassed || state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-evidence`, severity, `${language} validation evidence is missing.`));
    nextCommands.push(`md2feishu multisdk verify ${task.taskDir} --language ${language} --evidence <file> --command "<command>"`);
    return;
  }
  checks.push(pass(`${language}-evidence`, `${language} has validation evidence.`));

  if (!state.dryRunPassed) {
    const severity: HarnessGradeSeverity = state.writePassed || state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-dry-run`, severity, `${language} dry-run has not passed.`));
    nextCommands.push(`md2feishu multisdk apply ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-dry-run`, `${language} dry-run passed.`));

  if (!state.writePassed) {
    const severity: HarnessGradeSeverity = state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-write`, severity, `${language} write has not passed.`));
    nextCommands.push(`md2feishu multisdk apply ${task.taskDir} --language ${language} --write -y`);
    return;
  }
  checks.push(pass(`${language}-write`, `${language} write passed.`));

  if (!state.auditPassed || state.status !== 'audited') {
    checks.push(fail(`${language}-audit`, 'incomplete', `${language} readback audit has not passed.`));
    nextCommands.push(`md2feishu multisdk audit ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-audit`, `${language} readback audit passed.`));

  for (const expected of expectedTracePhases(language)) {
    if (hasTraceEvent(traceEvents, expected)) {
      checks.push(pass(expected.id, `${language} trace contains ${expected.tool} ${expected.mode}.`));
    } else {
      checks.push(fail(expected.id, 'blocked', `${language} trace is missing ${expected.tool} ${expected.mode}.`));
    }
  }
}

function expectedTracePhases(language: MultisdkLanguage): Array<{
  id: string;
  tool: string;
  mode: string;
  language: MultisdkLanguage;
}> {
  return [
    { id: `${language}-trace-verify`, tool: 'multisdk.verify', mode: 'record-evidence', language },
    { id: `${language}-trace-dry-run`, tool: 'multisdk.apply', mode: 'dry-run', language },
    { id: `${language}-trace-write`, tool: 'multisdk.apply', mode: 'write', language },
    { id: `${language}-trace-audit`, tool: 'multisdk.audit', mode: 'readback-audit', language }
  ];
}

function hasTraceEvent(
  events: HarnessTraceEvent[],
  expected: { tool: string; mode: string; language: MultisdkLanguage }
): boolean {
  return events.some((event) =>
    event.status === 'passed' &&
    event.tool === expected.tool &&
    event.mode === expected.mode &&
    isTraceArgumentsRecord(event.arguments) &&
    event.arguments.language === expected.language
  );
}

function isTraceArgumentsRecord(value: unknown): value is { language?: unknown } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
