import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ReleaseTaskStatus =
  | 'initialized'
  | 'pulled'
  | 'scanned'
  | 'audited'
  | 'approved'
  | 'dry-run-passed'
  | 'written'
  | 'blocked';

export type ReleaseUserDoc = {
  localPath: string;
  feishuDoc: string;
};

export type ReleaseApproval = {
  reportHash: string;
  approvedBy: string;
  approvedAt: string;
};

export type ReleaseTask = {
  kind: 'feishu-release-task';
  version: 1;
  releaseLine: string;
  releaseVersion: string;
  releaseDoc: string;
  documentId: string;
  milvusDocsPath: string;
  taskDir: string;
  userDocs: ReleaseUserDoc[];
  linkMapPath?: string;
  status: ReleaseTaskStatus;
  steps: {
    pulledReleaseNotes: boolean;
    scannedSdkTags: boolean;
    audited: boolean;
    approved: boolean;
    dryRunPassed: boolean;
    writePassed: boolean;
  };
  reportHash: string | null;
  approval: ReleaseApproval | null;
  blockedReason?: string;
};

export type ReleaseTaskSummary = {
  releaseLine: string;
  releaseVersion: string;
  taskDir: string;
  status: ReleaseTaskStatus;
  steps: ReleaseTask['steps'];
  reportHash: string | null;
};

export function createInitialReleaseTask(input: {
  releaseLine: string;
  releaseVersion: string;
  releaseDoc: string;
  documentId: string;
  milvusDocsPath: string;
  taskDir: string;
  userDocs: ReleaseUserDoc[];
  linkMapPath?: string;
}): ReleaseTask {
  return {
    kind: 'feishu-release-task',
    version: 1,
    releaseLine: input.releaseLine,
    releaseVersion: input.releaseVersion,
    releaseDoc: input.releaseDoc,
    documentId: input.documentId,
    milvusDocsPath: input.milvusDocsPath,
    taskDir: input.taskDir,
    userDocs: input.userDocs,
    linkMapPath: input.linkMapPath,
    status: 'initialized',
    steps: {
      pulledReleaseNotes: false,
      scannedSdkTags: false,
      audited: false,
      approved: false,
      dryRunPassed: false,
      writePassed: false
    },
    reportHash: null,
    approval: null
  };
}

export function summarizeReleaseTask(task: ReleaseTask): ReleaseTaskSummary {
  return {
    releaseLine: task.releaseLine,
    releaseVersion: task.releaseVersion,
    taskDir: task.taskDir,
    status: task.status,
    steps: task.steps,
    reportHash: task.reportHash
  };
}

export async function loadReleaseTask(taskDir: string): Promise<ReleaseTask> {
  const task = JSON.parse(await readFile(releaseTaskPath(taskDir), 'utf8')) as ReleaseTask;
  if (task.kind !== 'feishu-release-task' || task.version !== 1) {
    throw new Error(`Invalid release task at ${releaseTaskPath(taskDir)}.`);
  }
  return task;
}

export async function saveReleaseTask(task: ReleaseTask): Promise<void> {
  await mkdir(task.taskDir, { recursive: true });
  await writeFile(releaseTaskPath(task.taskDir), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

export function approveReleaseTask(task: ReleaseTask, approval: ReleaseApproval): ReleaseTask {
  return {
    ...task,
    status: 'approved',
    reportHash: approval.reportHash,
    approval,
    steps: {
      ...task.steps,
      approved: true,
      dryRunPassed: false,
      writePassed: false
    }
  };
}

export function blockReleaseTask(task: ReleaseTask, reason: string): ReleaseTask {
  return {
    ...task,
    status: 'blocked',
    blockedReason: reason
  };
}

export function hashReleaseReport(input: { reportJson: string; reportMarkdown: string }): string {
  const digest = createHash('sha256')
    .update(input.reportJson)
    .update('\0')
    .update(input.reportMarkdown)
    .digest('hex');
  return `sha256:${digest}`;
}

export function releaseTaskPath(taskDir: string): string {
  return join(taskDir, 'task.json');
}
