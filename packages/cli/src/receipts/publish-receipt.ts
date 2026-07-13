import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';

export type PublishReceiptTarget = {
  kind: 'docx' | 'wiki' | 'folder';
  token: string;
};

export type LocalBaseSnapshot = {
  path: string;
  hash: string;
};

export type SnapshotReference = {
  path: string;
  hash: string;
};

export type PublishReceiptV1 = {
  version: 1;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  remoteRevision?: string;
  localBaseSnapshot?: LocalBaseSnapshot;
  updatedAt: string;
};

export type PublishReceiptV2 = {
  version: 2;
  target: PublishReceiptTarget;
  resolvedDocumentId: string;
  profile: PublishProfileName;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  remoteRevision?: string;
  localBaseSnapshot: LocalBaseSnapshot;
  remoteSemanticSnapshot: SnapshotReference;
  updatedAt: string;
};

export type PublishReceipt = PublishReceiptV1 | PublishReceiptV2;

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publishReceiptPath(input: { cwd: string; target: PublishReceiptTarget }): string {
  return join(input.cwd, '.sync', 'feishu-md-sync', `${input.target.kind}-${input.target.token}.json`);
}

export function baseSnapshotPath(input: { cwd: string; target: PublishReceiptTarget }): string {
  return join(input.cwd, baseSnapshotRelativePath({ target: input.target }));
}

export function baseSnapshotRelativePath(input: { target: PublishReceiptTarget }): string {
  return join('.sync', 'feishu-md-sync', 'bases', `${input.target.kind}-${input.target.token}-local.md`);
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

export async function writeLocalBaseSnapshot(input: {
  cwd: string;
  target: PublishReceiptTarget;
  markdown: string;
}): Promise<LocalBaseSnapshot> {
  const path = baseSnapshotPath({ cwd: input.cwd, target: input.target });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.markdown, 'utf8');
  return {
    path: baseSnapshotRelativePath({ target: input.target }),
    hash: hashText(input.markdown)
  };
}

export async function readLocalBaseSnapshot(input: {
  cwd: string;
  snapshot: LocalBaseSnapshot;
}): Promise<string | undefined> {
  try {
    return await readFile(join(input.cwd, input.snapshot.path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function canUpgradeLegacyReceipt(input: {
  receipt: PublishReceiptV1;
  currentRemoteMarkdown: string;
}): boolean {
  return input.receipt.remoteSnapshotHash === hashText(input.currentRemoteMarkdown);
}
