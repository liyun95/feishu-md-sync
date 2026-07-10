import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import { hashText, type PublishReceiptTarget } from './publish-receipt.js';

export type PullReceipt = {
  version: 1;
  kind: 'pull-snapshot';
  target: PublishReceiptTarget;
  outputPath: string;
  profile: PublishProfileName;
  remoteRevision?: string;
  remoteRawHash: string;
  outputHash: string;
  pulledAt: string;
};

export function pullReceiptPath(input: {
  cwd: string;
  outputPath: string;
  target: PublishReceiptTarget;
}): string {
  const outputKey = hashText(resolve(input.cwd, input.outputPath)).slice(0, 16);
  return join(
    input.cwd,
    '.sync',
    'feishu-md-sync',
    'pulls',
    `${outputKey}-${input.target.kind}-${input.target.token}.json`
  );
}

export function normalizeReceiptOutputPath(input: { cwd: string; outputPath: string }): string {
  const absolute = resolve(input.cwd, input.outputPath);
  const relativePath = relative(input.cwd, absolute);
  return relativePath.startsWith('..') ? absolute : relativePath;
}

export async function readPullReceipt(input: {
  cwd: string;
  outputPath: string;
  target: PublishReceiptTarget;
}): Promise<PullReceipt | undefined> {
  const path = pullReceiptPath(input);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as PullReceipt;
}

export async function writePullReceipt(input: {
  cwd: string;
  receipt: PullReceipt;
}): Promise<void> {
  const path = pullReceiptPath({ cwd: input.cwd, outputPath: input.receipt.outputPath, target: input.receipt.target });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(input.receipt, null, 2)}\n`, 'utf8');
}
