import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SemanticDocument } from '../semantic/types.js';
import { stripExecutionMetadata } from '../semantic/normalize.js';
import { hashText, type PublishReceiptTarget, type SnapshotReference } from './publish-receipt.js';

export async function writeRemoteSemanticSnapshot(input: {
  cwd: string;
  target: PublishReceiptTarget;
  document: SemanticDocument;
}): Promise<SnapshotReference> {
  const path = remoteSemanticSnapshotRelativePath(input.target);
  const serialized = `${JSON.stringify(stripExecutionMetadata(input.document), null, 2)}\n`;
  await mkdir(dirname(join(input.cwd, path)), { recursive: true });
  await writeFile(join(input.cwd, path), serialized, 'utf8');
  return { path, hash: hashText(serialized) };
}

export async function readRemoteSemanticSnapshot(input: {
  cwd: string;
  snapshot: SnapshotReference;
}): Promise<SemanticDocument | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(input.cwd, input.snapshot.path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (hashText(raw) !== input.snapshot.hash) {
    throw new Error('Remote semantic snapshot hash mismatch.');
  }
  return JSON.parse(raw) as SemanticDocument;
}

function remoteSemanticSnapshotRelativePath(target: PublishReceiptTarget): string {
  return join('.sync', 'feishu-md-sync', 'bases', `${target.kind}-${target.token}-remote-semantic.json`);
}
