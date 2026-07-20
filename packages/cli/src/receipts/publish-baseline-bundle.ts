import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  hashText,
  publishReceiptPath,
  type PartialWriteCheckpoint,
  type PublishReceiptTarget,
  type PublishReceiptV4,
  type PublishReceiptV5,
  type SnapshotReference
} from './publish-receipt.js';
import type { SemanticDocument } from '../semantic/types.js';
import { stripExecutionMetadata } from '../semantic/normalize.js';

export async function writePublishBaselineBundle(input: {
  cwd: string;
  target: PublishReceiptTarget;
  localBaseline: string;
  publishBaseline: string;
  remoteSemantic: SemanticDocument;
  receipt: Omit<
    PublishReceiptV4,
    'version' | 'target' | 'localBaseSnapshot' | 'publishBaseSnapshot' | 'remoteSemanticSnapshot'
  > & { protectedResources?: PublishReceiptV5['protectedResources'] };
}): Promise<{
  receipt: PublishReceiptV4 | PublishReceiptV5;
  receiptPath: string;
}> {
  const remoteSerialized = `${JSON.stringify(stripExecutionMetadata(input.remoteSemantic), null, 2)}\n`;
  const localBaseSnapshot = snapshotReference(input.target, 'local', input.localBaseline, 'md');
  const publishBaseSnapshot = snapshotReference(input.target, 'publish', input.publishBaseline, 'md');
  const remoteSemanticSnapshot = snapshotReference(input.target, 'remote-semantic', remoteSerialized, 'json');
  const { protectedResources, ...receiptFields } = input.receipt;
  const common = {
    target: input.target,
    ...receiptFields,
    localBaseSnapshot,
    publishBaseSnapshot,
    remoteSemanticSnapshot
  };
  const receipt: PublishReceiptV4 | PublishReceiptV5 = protectedResources?.length
    ? { ...common, version: 5, protectedResources }
    : { ...common, version: 4 };
  const receiptPath = publishReceiptPath({ cwd: input.cwd, target: input.target });
  const writes = [
    { reference: localBaseSnapshot, content: input.localBaseline },
    { reference: publishBaseSnapshot, content: input.publishBaseline },
    { reference: remoteSemanticSnapshot, content: remoteSerialized }
  ];
  const temporaryPaths: string[] = [];
  try {
    for (const write of writes) {
      const finalPath = join(input.cwd, write.reference.path);
      await mkdir(dirname(finalPath), { recursive: true });
      const temporaryPath = `${finalPath}.tmp-${randomUUID()}`;
      temporaryPaths.push(temporaryPath);
      await writeFile(temporaryPath, write.content, 'utf8');
      await rename(temporaryPath, finalPath);
    }
    await mkdir(dirname(receiptPath), { recursive: true });
    const temporaryReceiptPath = `${receiptPath}.tmp-${randomUUID()}`;
    temporaryPaths.push(temporaryReceiptPath);
    await writeFile(temporaryReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporaryReceiptPath, receiptPath);
  } finally {
    await Promise.all(temporaryPaths.map(async (path) => {
      await rm(path, { force: true });
    }));
  }
  return { receipt, receiptPath };
}

export async function writePublishRemoteCheckpoint(input: {
  cwd: string;
  receipt: PublishReceiptV4 | PublishReceiptV5;
  remoteMarkdown: string;
  remoteRevision?: string;
  remoteSemantic: SemanticDocument;
  checkpoint: PartialWriteCheckpoint;
}): Promise<PublishReceiptV4 | PublishReceiptV5> {
  const remoteSerialized = `${JSON.stringify(stripExecutionMetadata(input.remoteSemantic), null, 2)}\n`;
  const remoteSemanticSnapshot = snapshotReference(
    input.receipt.target,
    'remote-semantic',
    remoteSerialized,
    'json'
  );
  const receipt = {
    ...input.receipt,
    remoteSnapshotHash: hashText(input.remoteMarkdown),
    ...(input.remoteRevision ? { remoteRevision: input.remoteRevision } : {}),
    remoteSemanticSnapshot,
    partialWriteCheckpoint: input.checkpoint,
    updatedAt: input.checkpoint.updatedAt
  } satisfies PublishReceiptV4 | PublishReceiptV5;
  const finalSemanticPath = join(input.cwd, remoteSemanticSnapshot.path);
  const receiptPath = publishReceiptPath({ cwd: input.cwd, target: input.receipt.target });
  const temporaryPaths: string[] = [];
  try {
    await mkdir(dirname(finalSemanticPath), { recursive: true });
    const temporarySemanticPath = `${finalSemanticPath}.tmp-${randomUUID()}`;
    temporaryPaths.push(temporarySemanticPath);
    await writeFile(temporarySemanticPath, remoteSerialized, 'utf8');
    await rename(temporarySemanticPath, finalSemanticPath);

    await mkdir(dirname(receiptPath), { recursive: true });
    const temporaryReceiptPath = `${receiptPath}.tmp-${randomUUID()}`;
    temporaryPaths.push(temporaryReceiptPath);
    await writeFile(temporaryReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await rename(temporaryReceiptPath, receiptPath);
  } finally {
    await Promise.all(temporaryPaths.map(async (path) => {
      await rm(path, { force: true });
    }));
  }
  return receipt;
}

function snapshotReference(
  target: PublishReceiptTarget,
  role: string,
  content: string,
  extension: string
): SnapshotReference {
  const hash = hashText(content);
  return {
    path: join(
      '.sync',
      'feishu-md-sync',
      'bases',
      `${target.kind}-${target.token}-${hash.slice(0, 16)}-${role}.${extension}`
    ),
    hash
  };
}
