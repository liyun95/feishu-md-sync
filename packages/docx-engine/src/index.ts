export const ENGINE_CAPABILITIES = [
  'nested-list-create-v1',
  'native-table-create-v1',
  'whiteboard-overwrite-v1',
  'partial-write-evidence-v1',
] as const;

export { canonicalHash } from './hash.js';
export { calloutToXml, tableToXml, toProviderBlock, toProviderTree } from './codec.js';
export {
  ENGINE_SCHEMA_VERSION,
  ENGINE_VERSION,
  assertPreparedMutationBatchIntegrity,
  MutationPreflightError,
  preparedMutationBatchFingerprint,
  prepareMutationBatch,
  type MutationPreflightErrorCode,
  type MutationPreflightErrorOptions,
} from './prepare.js';
export {
  createDocumentSnapshot,
  type CreateDocumentSnapshotInput,
} from './snapshot.js';
export {
  LarkCliProviderError,
  LarkCliTransport,
  type LarkCliErrorEnvelope,
  type LarkCliExecInput,
  type LarkCliExecResult,
  type LarkCliExecutor,
  type LarkCliIdentity,
  type LarkCliProviderErrorDetails,
} from './lark-cli-transport.js';
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
  type PreparedInsertSegment,
  type PreparedMutationAction,
  type PreparedMutationAssertions,
  type PreparedMutationBatch,
  type PreparedPreflightAssertion,
  type PreparedProviderBlock,
  type PreparedReadbackAssertion,
  type PreparedMutationStep,
  type PrepareMutationInput,
  type RecoveryAssessment,
  type SnapshotNode,
  type VerifiedOperationEvidence,
} from './model.js';
export type {
  CreateChildrenInput,
  CreatedChildrenResult,
  CreateDocumentInput,
  CreatedDocumentResult,
  DocxTransport,
  OverwriteWhiteboardInput,
  ProviderBlock,
  ProviderMutationInput,
  ProviderMutationResult,
} from './transport.js';
