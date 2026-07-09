import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';

export type PublishReceiptTarget = {
  kind: 'docx' | 'wiki' | 'folder';
  token: string;
};

export type PublishReceipt = {
  version: 1;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  remoteRevision?: string;
  updatedAt: string;
};

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publishReceiptPath(input: { cwd: string; target: PublishReceiptTarget }): string {
  return join(input.cwd, '.sync', 'feishu-md-sync', `${input.target.kind}-${input.target.token}.json`);
}

export async function readPublishReceipt(input: {
  cwd: string;
  target: PublishReceiptTarget;
}): Promise<PublishReceipt | undefined> {
  const path = publishReceiptPath(input);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as PublishReceipt;
}

export async function writePublishReceipt(input: {
  cwd: string;
  receipt: PublishReceipt;
}): Promise<void> {
  const path = publishReceiptPath({ cwd: input.cwd, target: input.receipt.target });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(input.receipt, null, 2)}\n`, 'utf8');
}
