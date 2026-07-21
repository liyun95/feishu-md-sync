import type { MutationJournal, VerifiedOperationEvidence } from 'feishu-docx-engine';
import type { PublishWriteOperationSummary } from './partial-write-error.js';

export function createDocxEngineJournal<T>(input: {
  operationsById: ReadonlyMap<string, T>;
  completedOperations: PublishWriteOperationSummary[];
  verifiedOperations: T[];
  recordCheckpoint?: (
    completedOperations: PublishWriteOperationSummary[],
    verifiedOperations: T[],
  ) => Promise<void>;
  summarize: (operation: T) => PublishWriteOperationSummary;
  onVerified?: (operation: T, evidence: VerifiedOperationEvidence) => void | Promise<void>;
}): MutationJournal {
  return {
    async recordVerified(evidence): Promise<void> {
      const operation = input.operationsById.get(evidence.operationId);
      if (!operation) {
        throw new Error(`Docx engine journal cannot resolve operation ${evidence.operationId}.`);
      }
      const completedLength = input.completedOperations.length;
      const verifiedLength = input.verifiedOperations.length;
      input.completedOperations.push(input.summarize(operation));
      input.verifiedOperations.push(operation);
      try {
        await input.onVerified?.(operation, evidence);
        await input.recordCheckpoint?.(input.completedOperations, input.verifiedOperations);
      } catch (error) {
        input.completedOperations.splice(completedLength);
        input.verifiedOperations.splice(verifiedLength);
        throw error;
      }
    },
  };
}
