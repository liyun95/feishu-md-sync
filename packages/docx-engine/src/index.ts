export const ENGINE_VERSION = '0.1.0';
export const ENGINE_SCHEMA_VERSION = 1;
export const ENGINE_CAPABILITIES = [
  'nested-list-create-v1',
  'native-table-create-v1',
  'whiteboard-overwrite-v1',
  'partial-write-evidence-v1',
] as const;

export { canonicalHash } from './hash.js';
export {
  PartialMutationError,
  type ApplyMutationInput,
  type AssessRecoveryInput,
  type DesiredListNode,
  type DesiredNode,
  type DocumentSelector,
  type DocumentSnapshot,
  type FeishuDocxEngine,
  type InlineContent,
  type MutationIntent,
  type MutationJournal,
  type MutationOutcome,
  type PartialMutationEvidence,
  type PreparedMutationBatch,
  type PreparedMutationStep,
  type PrepareMutationInput,
  type RecoveryAssessment,
  type SnapshotNode,
  type VerifiedOperationEvidence,
} from './model.js';
