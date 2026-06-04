import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadMultisdkTask, type MultisdkTask } from './task.js';

export type ActiveMultisdkTask = {
  taskDir: string;
  document: string;
  documentId: string;
  languages: Record<string, string>;
};

const MAX_RUNS_SCAN_DEPTH = 5;

export async function findActiveMultisdkTasks(rootDir: string, documentId: string): Promise<ActiveMultisdkTask[]> {
  const taskFiles = await findTaskFiles(join(rootDir, 'runs'), MAX_RUNS_SCAN_DEPTH);
  const tasks: ActiveMultisdkTask[] = [];

  for (const taskFile of taskFiles) {
    try {
      const taskDir = dirname(taskFile);
      const task = await loadMultisdkTask(taskDir);
      if (task.documentId === documentId && isActiveTask(task)) {
        tasks.push({
          taskDir,
          document: task.document,
          documentId: task.documentId,
          languages: { [task.language]: task.status }
        });
      }
    } catch {
      // Ignore non-multisdk task.json files under runs/.
    }
  }

  return tasks;
}

export function formatActiveMultisdkTaskWarning(tasks: ActiveMultisdkTask[]): string {
  const taskList = tasks.map((task) => task.taskDir).join(', ');
  return (
    `This document has an active multisdk task (${taskList}). ` +
    'Whole-document sync may replace non-target blocks. ' +
    'Use md2feishu multisdk apply-local <task-dir> and md2feishu push for reviewed Markdown.'
  );
}

function isActiveTask(task: MultisdkTask): boolean {
  if (!task.finalAuditPassed) return true;
  return task.status !== 'audited' || !task.lane.audited;
}

async function findTaskFiles(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'task.json') {
      files.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await findTaskFiles(entryPath, depth - 1));
    }
  }
  return files;
}
