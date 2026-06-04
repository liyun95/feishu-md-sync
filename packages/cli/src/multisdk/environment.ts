import type { MultisdkMilvusTarget } from './task.js';

export type ParseMilvusTargetInput = {
  milvusVersion?: string;
  milvusSourceRepo?: string;
  milvusSourceRef?: string;
};

export function parseMilvusTarget(input: ParseMilvusTargetInput): MultisdkMilvusTarget {
  const version = input.milvusVersion?.trim();
  if (!version) {
    throw new Error('Milvus target requires --milvus-version. Ask the user to confirm the Milvus target: which released version, or which source repo and branch/tag/commit for an unreleased build.');
  }

  const sourceRepo = input.milvusSourceRepo?.trim();
  const sourceRef = input.milvusSourceRef?.trim();
  if (sourceRepo || sourceRef) {
    if (!sourceRepo) throw new Error('Milvus source build target requires --milvus-source-repo.');
    if (!sourceRef) throw new Error('Milvus source build target requires --milvus-source-ref.');
    return {
      kind: 'source-build',
      version,
      sourceRepo,
      sourceRef
    };
  }

  return {
    kind: 'released-version',
    version
  };
}
