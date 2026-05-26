import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';
import type { MultisdkLanguage } from './language.js';

export type MultisdkLanguageStatus =
  | 'pending'
  | 'exported'
  | 'ready'
  | 'dry-run-passed'
  | 'written'
  | 'audited'
  | 'blocked';

export type MultisdkEvidence = {
  path: string;
  command: string;
  recordedAt: string;
  profile?: string;
  sdkVersion?: string;
  sourceCommit?: string;
  endpoint?: string;
};

export type MultisdkSnippetHash = {
  file: string;
  contentHash: string;
};

export type MultisdkDocsLanding = {
  language: MultisdkLanguage;
  repo: string;
  target: string;
  reviewedBaselinePath: string;
  mode: 'write';
  baseRef?: string;
  branch?: string;
  commitMessage?: string;
  recordedAt: string;
};

export type MultisdkLanguageState = {
  status: MultisdkLanguageStatus;
  sourceVerified: boolean;
  snippetsReady: boolean;
  validated: boolean;
  dryRunPassed: boolean;
  dryRunHashes: MultisdkSnippetHash[];
  writePassed: boolean;
  auditPassed: boolean;
  evidence: MultisdkEvidence[];
  reason?: string;
};

export type MultisdkTask = {
  kind: 'feishu-multisdk-task';
  version: 1;
  document: string;
  documentId: string;
  taskDir: string;
  languageOrder: CanonicalCodeBlockLanguage[];
  languages: Record<MultisdkLanguage, MultisdkLanguageState>;
  docsLandings: MultisdkDocsLanding[];
  finalAuditPassed: boolean;
  cleanup: string[];
};

export type MultisdkTaskSummary = {
  document: string;
  documentId: string;
  taskDir: string;
  languages: Record<MultisdkLanguage, MultisdkLanguageStatus>;
  finalAuditPassed: boolean;
};

export function createInitialMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
}): MultisdkTask {
  return {
    kind: 'feishu-multisdk-task',
    version: 1,
    document: input.document,
    documentId: input.documentId,
    taskDir: input.taskDir,
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    languages: {
      java: initialLanguageState(),
      javascript: initialLanguageState(),
      go: initialLanguageState(),
      restful: initialLanguageState()
    },
    docsLandings: [],
    finalAuditPassed: false,
    cleanup: []
  };
}

export function markLanguageStatus(
  task: MultisdkTask,
  language: MultisdkLanguage,
  status: MultisdkLanguageStatus,
  reason?: string
): MultisdkTask {
  return {
    ...task,
    languages: {
      ...task.languages,
      [language]: {
        ...task.languages[language],
        status,
        reason
      }
    }
  };
}

export function summarizeMultisdkTask(task: MultisdkTask): MultisdkTaskSummary {
  return {
    document: task.document,
    documentId: task.documentId,
    taskDir: task.taskDir,
    languages: {
      java: task.languages.java.status,
      javascript: task.languages.javascript.status,
      go: task.languages.go.status,
      restful: task.languages.restful.status
    },
    finalAuditPassed: task.finalAuditPassed
  };
}

export async function loadMultisdkTask(taskDir: string): Promise<MultisdkTask> {
  const task = JSON.parse(await readFile(taskPath(taskDir), 'utf8')) as MultisdkTask;
  if (task.kind !== 'feishu-multisdk-task' || task.version !== 1) {
    throw new Error(`Invalid multisdk task at ${taskPath(taskDir)}.`);
  }
  return task;
}

export async function saveMultisdkTask(task: MultisdkTask): Promise<void> {
  await mkdir(task.taskDir, { recursive: true });
  await writeFile(taskPath(task.taskDir), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

export function taskPath(taskDir: string): string {
  return join(taskDir, 'task.json');
}

function initialLanguageState(): MultisdkLanguageState {
  return {
    status: 'pending',
    sourceVerified: false,
    snippetsReady: false,
    validated: false,
    dryRunPassed: false,
    dryRunHashes: [],
    writePassed: false,
    auditPassed: false,
    evidence: []
  };
}
