import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSdkTagMatrixMarkdown, type SdkTagMatrix } from './sdk-tags.js';
import {
  approveReleaseTask,
  createInitialReleaseTask,
  hashReleaseReport,
  loadReleaseTask,
  saveReleaseTask,
  summarizeReleaseTask,
  type ReleaseApproval,
  type ReleaseTask,
  type ReleaseTaskSummary,
  type ReleaseUserDoc
} from './task.js';

export type ReleaseWorkflowApprovalLog = {
  kind: 'feishu-release-approvals';
  version: 1;
  approvals: ReleaseApproval[];
};

export async function initReleaseWorkflow(input: {
  releaseLine: string;
  releaseVersion: string;
  releaseDoc: string;
  documentId: string;
  milvusDocsPath: string;
  taskDir: string;
  userDocs: ReleaseUserDoc[];
  linkMapPath?: string;
}): Promise<ReleaseTask> {
  const task = createInitialReleaseTask(input);
  await Promise.all([
    mkdir(join(input.taskDir, 'feishu'), { recursive: true }),
    mkdir(join(input.taskDir, 'sdk'), { recursive: true }),
    mkdir(join(input.taskDir, 'audit'), { recursive: true })
  ]);
  await saveReleaseTask(task);
  return task;
}

export async function pullReleaseNotesWorkflow(input: {
  taskDir: string;
  markdown: string;
}): Promise<ReleaseTask> {
  const task = await loadReleaseTask(input.taskDir);
  await mkdir(join(input.taskDir, 'feishu'), { recursive: true });
  await writeFile(join(input.taskDir, 'feishu/release-notes.remote.md'), input.markdown, 'utf8');

  const updated: ReleaseTask = {
    ...task,
    status: 'pulled',
    steps: {
      ...task.steps,
      pulledReleaseNotes: true,
      audited: false,
      approved: false,
      dryRunPassed: false,
      writePassed: false
    },
    reportHash: null,
    approval: null
  };
  await saveReleaseTask(updated);
  return updated;
}

export async function scanSdkTagsWorkflow(input: {
  taskDir: string;
  matrix: SdkTagMatrix;
}): Promise<ReleaseTask> {
  const task = await loadReleaseTask(input.taskDir);
  await mkdir(join(input.taskDir, 'sdk'), { recursive: true });
  await writeFile(join(input.taskDir, 'sdk/tags.json'), `${JSON.stringify(input.matrix, null, 2)}\n`, 'utf8');
  await writeFile(join(input.taskDir, 'sdk/matrix.md'), renderSdkTagMatrixMarkdown(input.matrix), 'utf8');

  const updated: ReleaseTask = {
    ...task,
    status: 'scanned',
    steps: {
      ...task.steps,
      scannedSdkTags: true,
      audited: false,
      approved: false,
      dryRunPassed: false,
      writePassed: false
    },
    reportHash: null,
    approval: null
  };
  await saveReleaseTask(updated);
  return updated;
}

export async function approveReleaseWorkflow(input: {
  taskDir: string;
  approvedBy: string;
  approvedAt?: string;
}): Promise<ReleaseTask> {
  const task = await loadReleaseTask(input.taskDir);
  const [reportJson, reportMarkdown] = await Promise.all([
    readFile(join(input.taskDir, 'audit/report.json'), 'utf8'),
    readFile(join(input.taskDir, 'audit/report.md'), 'utf8')
  ]);
  const approval: ReleaseApproval = {
    reportHash: hashReleaseReport({ reportJson, reportMarkdown }),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt ?? new Date().toISOString()
  };
  const updated = approveReleaseTask(task, approval);
  await saveReleaseTask(updated);
  await saveApproval(input.taskDir, approval);
  return updated;
}

export async function statusReleaseWorkflow(taskDir: string): Promise<ReleaseTaskSummary> {
  return summarizeReleaseTask(await loadReleaseTask(taskDir));
}

async function saveApproval(taskDir: string, approval: ReleaseApproval): Promise<void> {
  const approvalsPath = join(taskDir, 'approvals.json');
  const current = await loadApprovalLog(approvalsPath);
  const next: ReleaseWorkflowApprovalLog = {
    ...current,
    approvals: [...current.approvals, approval]
  };
  await writeFile(approvalsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

async function loadApprovalLog(approvalsPath: string): Promise<ReleaseWorkflowApprovalLog> {
  try {
    const parsed = JSON.parse(await readFile(approvalsPath, 'utf8')) as ReleaseWorkflowApprovalLog;
    if (parsed.kind === 'feishu-release-approvals' && parsed.version === 1 && Array.isArray(parsed.approvals)) {
      return parsed;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return {
    kind: 'feishu-release-approvals',
    version: 1,
    approvals: []
  };
}
