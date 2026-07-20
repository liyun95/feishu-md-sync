import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { DialectDependency, DialectName } from '../dialects/types.js';
import type { ResolvedDocumentLink } from '../link-resolvers/types.js';
import type { SemanticLocator } from '../semantic/types.js';

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

export type WhiteboardReceiptEntry = {
  assetKey: string;
  pngPath: string;
  svgPath: string;
  svgHash: string;
  whiteboardToken: string;
  blockId: string;
  remoteStateHash: string;
  placementFingerprint: string;
};

export type PublishReceiptV3 = Omit<PublishReceiptV2, 'version'> & {
  version: 3;
  whiteboards: WhiteboardReceiptEntry[];
};

export type PublishReceiptV4 = {
  version: 4;
  target: PublishReceiptTarget;
  resolvedDocumentId?: string;
  profile: PublishProfileName;
  dialect: DialectName;
  dialectDraftHash: string;
  dialectDependencies: DialectDependency[];
  linkResolutionFingerprint: string;
  resolvedLinks: ResolvedDocumentLink[];
  localSourceHash: string;
  publishDraftHash: string;
  publishBaseSnapshot: SnapshotReference;
  remoteSnapshotHash: string;
  remoteRevision?: string;
  localBaseSnapshot: LocalBaseSnapshot;
  remoteSemanticSnapshot?: SnapshotReference;
  partialWriteCheckpoint?: PartialWriteCheckpoint;
  whiteboards: WhiteboardReceiptEntry[];
  updatedAt: string;
};

export type PartialWriteCheckpoint = {
  planFingerprint: string;
  completedOperations: Array<{
    kind: string;
    locator?: SemanticLocator;
    assetKey?: string;
  }>;
  remoteRevision?: string;
  updatedAt: string;
};

export type ProtectedResourceReceiptEntry = {
  kind: 'supademo';
  componentId: string;
  blockId: string;
  remoteShape: string;
  remoteToken?: string;
  sectionPath: string[];
  ordinal: number;
  previousFingerprint?: string;
  nextFingerprint?: string;
};

export type PublishReceiptV5 = Omit<PublishReceiptV4, 'version'> & {
  version: 5;
  protectedResources: ProtectedResourceReceiptEntry[];
};

export type PublishReceipt = PublishReceiptV1 | PublishReceiptV2 | PublishReceiptV3 | PublishReceiptV4 | PublishReceiptV5;

export function whiteboardEntries(receipt: PublishReceipt | undefined): WhiteboardReceiptEntry[] {
  return receipt?.version === 3 || receipt?.version === 4 || receipt?.version === 5
    ? receipt.whiteboards
    : [];
}

export function protectedResourceEntries(
  receipt: PublishReceipt | undefined
): ProtectedResourceReceiptEntry[] {
  return receipt?.version === 5 ? receipt.protectedResources : [];
}

export function receiptDialect(receipt: PublishReceipt): DialectName {
  return receipt.version === 4 || receipt.version === 5 ? receipt.dialect : 'gfm';
}

export function hasRemoteSemanticSnapshot(
  receipt: PublishReceipt | undefined
): receipt is PublishReceiptV2 | PublishReceiptV3 |
  ((PublishReceiptV4 | PublishReceiptV5) & { remoteSemanticSnapshot: SnapshotReference }) {
  return Boolean(
    receipt &&
    (receipt.version === 2 || receipt.version === 3 || receipt.version === 4 || receipt.version === 5) &&
    receipt.remoteSemanticSnapshot
  );
}

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

export function publishBaseSnapshotRelativePath(input: { target: PublishReceiptTarget }): string {
  return join('.sync', 'feishu-md-sync', 'bases', `${input.target.kind}-${input.target.token}-publish.md`);
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
  let markdown: string;
  try {
    markdown = await readFile(join(input.cwd, input.snapshot.path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (hashText(markdown) !== input.snapshot.hash) {
    throw new Error('Local base snapshot hash mismatch.');
  }
  return markdown;
}

export async function writePublishBaseSnapshot(input: {
  cwd: string;
  target: PublishReceiptTarget;
  markdown: string;
}): Promise<SnapshotReference> {
  const path = publishBaseSnapshotRelativePath({ target: input.target });
  await mkdir(dirname(join(input.cwd, path)), { recursive: true });
  await writeFile(join(input.cwd, path), input.markdown, 'utf8');
  return { path, hash: hashText(input.markdown) };
}

export async function readPublishBaseSnapshot(input: {
  cwd: string;
  snapshot: SnapshotReference;
}): Promise<string | undefined> {
  let markdown: string;
  try {
    markdown = await readFile(join(input.cwd, input.snapshot.path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (hashText(markdown) !== input.snapshot.hash) {
    throw new Error('Publish base snapshot hash mismatch.');
  }
  return markdown;
}

export function canUpgradeLegacyReceipt(input: {
  receipt: PublishReceiptV1;
  currentRemoteMarkdown: string;
}): boolean {
  return input.receipt.remoteSnapshotHash === hashText(input.currentRemoteMarkdown);
}
