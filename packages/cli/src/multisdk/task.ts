import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MultisdkLanguage } from './language.js';

export type MultisdkTaskStatus =
  | 'initialized'
  | 'environment-ready'
  | 'prepared'
  | 'authored'
  | 'validated'
  | 'local-applied'
  | 'remote-dry-run'
  | 'remote-written'
  | 'audited'
  | 'blocked';

export type MultisdkMilvusTarget =
  | {
    kind: 'released-version';
    version: string;
    sourceRepo?: undefined;
    sourceRef?: undefined;
  }
  | {
    kind: 'source-build';
    version: string;
    sourceRepo: string;
    sourceRef: string;
  };

export type MultisdkValidationRunner = 'manta' | 'local';

export type MultisdkValidation = {
  runner: MultisdkValidationRunner;
  command: string;
  evidencePath: string;
  recordedAt: string;
  milvusTarget: MultisdkMilvusTarget;
  jobId?: string;
};

export type MultisdkLaneState = {
  language: MultisdkLanguage;
  prepared: boolean;
  authored: boolean;
  validated: boolean;
  localApplied: boolean;
  remoteWritten: boolean;
  audited: boolean;
  evidence: MultisdkValidation[];
  reason?: string;
};

export type MultisdkLocalReview = {
  markdownPath: string;
  diffPath: string;
  generatedAt: string;
};

export type MultisdkRemotePush = {
  dryRunAt?: string;
  writeAt?: string;
  command?: string;
  resultPath?: string;
};

export type MultisdkTask = {
  kind: 'feishu-multisdk-task';
  version: 2;
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  languages: MultisdkLanguage[];
  status: MultisdkTaskStatus;
  milvusTarget: MultisdkMilvusTarget | null;
  runner: MultisdkValidationRunner;
  lane: MultisdkLaneState;
  localReview: MultisdkLocalReview | null;
  remotePush: MultisdkRemotePush | null;
  finalAuditPassed: boolean;
  cleanup: string[];
};

export type MultisdkTaskSummary = {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  status: MultisdkTaskStatus;
  milvusTarget: MultisdkMilvusTarget | null;
  localReview: MultisdkLocalReview | null;
  finalAuditPassed: boolean;
};

export function createInitialMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
}): MultisdkTask {
  return {
    kind: 'feishu-multisdk-task',
    version: 2,
    document: input.document,
    documentId: input.documentId,
    taskDir: input.taskDir,
    language: input.language,
    languages: [input.language],
    status: 'initialized',
    milvusTarget: null,
    runner: 'manta',
    lane: {
      language: input.language,
      prepared: false,
      authored: false,
      validated: false,
      localApplied: false,
      remoteWritten: false,
      audited: false,
      evidence: []
    },
    localReview: null,
    remotePush: null,
    finalAuditPassed: false,
    cleanup: []
  };
}

export function summarizeMultisdkTask(task: MultisdkTask): MultisdkTaskSummary {
  return {
    document: task.document,
    documentId: task.documentId,
    taskDir: task.taskDir,
    language: task.language,
    status: task.status,
    milvusTarget: task.milvusTarget,
    localReview: task.localReview,
    finalAuditPassed: task.finalAuditPassed
  };
}

export async function loadMultisdkTask(taskDir: string): Promise<MultisdkTask> {
  const task = JSON.parse(await readFile(taskPath(taskDir), 'utf8')) as MultisdkTask;
  if (task.kind !== 'feishu-multisdk-task' || task.version !== 2) {
    throw new Error(`Invalid multisdk task at ${taskPath(taskDir)}.`);
  }
  return {
    ...task,
    lane: {
      ...task.lane,
      authored: task.lane.authored ?? false
    }
  };
}

export async function saveMultisdkTask(task: MultisdkTask): Promise<void> {
  await mkdir(task.taskDir, { recursive: true });
  await writeFile(taskPath(task.taskDir), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

export function taskPath(taskDir: string): string {
  return join(taskDir, 'task.json');
}
