import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';

export type MergeStateFile = {
  version: 1;
  filePath: string;
  target?: PublishReceiptTarget;
  profile: PublishProfileName;
  startedAt: string;
};

export function mergeStateDir(input: { cwd: string; filePath: string }): string {
  const key = createHash('sha256').update(input.filePath).digest('hex').slice(0, 24);
  return join(input.cwd, '.sync', 'feishu-md-sync', 'merge-state', key);
}

export async function assertNoMergeState(input: { cwd: string; filePath: string }): Promise<void> {
  try {
    await readFile(join(mergeStateDir(input), 'state.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('A merge is already in progress for this file. Resolve it or run merge --abort before starting another merge.');
}

export async function writeMergeState(input: {
  cwd: string;
  filePath: string;
  originalMarkdown: string;
  target?: PublishReceiptTarget;
  profile: PublishProfileName;
}): Promise<{ statePath: string }> {
  await assertNoMergeState({ cwd: input.cwd, filePath: input.filePath });
  const dir = mergeStateDir({ cwd: input.cwd, filePath: input.filePath });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'original.md'), input.originalMarkdown, 'utf8');
  const state: MergeStateFile = {
    version: 1,
    filePath: relative(input.cwd, input.filePath),
    target: input.target,
    profile: input.profile,
    startedAt: new Date().toISOString()
  };
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { statePath };
}

export async function restoreMergeState(input: { cwd: string; filePath: string }): Promise<{
  restored: boolean;
  statePath: string;
}> {
  const dir = mergeStateDir(input);
  const statePath = join(dir, 'state.json');
  const originalPath = join(dir, 'original.md');
  const original = await readFile(originalPath, 'utf8');
  await mkdir(dirname(input.filePath), { recursive: true });
  await writeFile(input.filePath, original, 'utf8');
  await rm(dir, { recursive: true, force: true });
  return { restored: true, statePath };
}
