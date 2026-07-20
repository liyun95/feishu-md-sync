export type CliFailureType =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'config'
  | 'network'
  | 'confirmation_required'
  | 'conflict'
  | 'verification'
  | 'internal';

export type CliFailureDetails = {
  type: CliFailureType;
  subtype: string;
  message: string;
  hint?: string;
  requiredFlags?: string[];
  retryable: boolean;
  providerCode?: number;
  missingScopes?: string[];
  consoleUrl?: string;
  partialWrite?: {
    completedOperations: unknown[];
    failedOperation: unknown;
    pendingOperations: unknown[];
    receiptWritten: false;
    recoveryCheckpointWritten?: boolean;
    recoveryCheckpointRevision?: string;
    cause?: unknown;
    document?: { documentId: string; url?: string };
  };
};

export class CliFailure extends Error {
  readonly details: CliFailureDetails;
  readonly exitCode: number;

  constructor(details: CliFailureDetails, options: ErrorOptions = {}) {
    super(details.message, options);
    this.name = 'CliFailure';
    this.details = details;
    this.exitCode = exitCodeForType(details.type);
  }
}

export function validationFailure(input: {
  subtype?: string;
  message: string;
  hint?: string;
}): CliFailure {
  return new CliFailure({
    type: 'validation',
    subtype: input.subtype ?? 'invalid_argument',
    message: input.message,
    hint: input.hint,
    retryable: false
  });
}

export function confirmationRequired(input: {
  subtype: string;
  message: string;
  hint: string;
  requiredFlags: string[];
}): CliFailure {
  return new CliFailure({
    type: 'confirmation_required',
    subtype: input.subtype,
    message: input.message,
    hint: input.hint,
    requiredFlags: input.requiredFlags,
    retryable: false
  });
}

export function normalizeCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;

  const partialWrite = partialWriteDetails(error);
  if (partialWrite) {
    const recoveryTarget = partialWrite.document?.url ?? partialWrite.document?.documentId;
    return new CliFailure({
      type: 'verification',
      subtype: 'partial_write',
      message: error instanceof Error ? error.message : String(error),
      hint: recoveryTarget
        ? `inspect the partially written document at ${recoveryTarget}, then rerun a dry-run before retrying`
        : 'inspect the partially written document state, then rerun a dry-run before retrying',
      retryable: false,
      partialWrite
    }, { cause: error instanceof Error ? error : undefined });
  }

  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  if (/readback|verification failed|hash mismatch/i.test(message)) {
    return new CliFailure({
      type: 'verification',
      subtype: 'readback_failed',
      message,
      hint: 'inspect the remote document and rerun a dry-run before retrying',
      retryable: false
    }, { cause });
  }
  if (/\bblocked\b|\bconflict\b/i.test(message)) {
    return new CliFailure({
      type: 'conflict',
      subtype: 'sync_conflict',
      message,
      hint: 'review status and diff, then resolve the overlapping local or remote change',
      retryable: false
    }, { cause });
  }
  if (isValidationMessage(message)) {
    return validationFailure({ message });
  }
  return new CliFailure({
    type: 'internal',
    subtype: 'unexpected_error',
    message,
    hint: 'rerun with the same inputs after inspecting the dry-run and local configuration',
    retryable: false
  }, { cause });
}

function partialWriteDetails(error: unknown): CliFailureDetails['partialWrite'] | undefined {
  if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'PartialWriteError') {
    return undefined;
  }
  const record = error as {
    completedOperations?: unknown;
    failedOperation?: unknown;
    pendingOperations?: unknown;
    receiptWritten?: unknown;
    recoveryCheckpointWritten?: unknown;
    recoveryCheckpointRevision?: unknown;
    causeDetails?: unknown;
    document?: unknown;
  };
  if (!Array.isArray(record.completedOperations) || !record.failedOperation ||
    !Array.isArray(record.pendingOperations) || record.receiptWritten !== false) {
    return undefined;
  }
  const document = record.document && typeof record.document === 'object' &&
    typeof (record.document as { documentId?: unknown }).documentId === 'string'
    ? record.document as { documentId: string; url?: string }
    : undefined;
  return {
    completedOperations: record.completedOperations,
    failedOperation: record.failedOperation,
    pendingOperations: record.pendingOperations,
    receiptWritten: false,
    ...(record.recoveryCheckpointWritten === true ? { recoveryCheckpointWritten: true } : {}),
    ...(typeof record.recoveryCheckpointRevision === 'string'
      ? { recoveryCheckpointRevision: record.recoveryCheckpointRevision }
      : {}),
    ...(record.causeDetails && typeof record.causeDetails === 'object'
      ? { cause: record.causeDetails }
      : {}),
    ...(document ? { document } : {})
  };
}

function exitCodeForType(type: CliFailureType): number {
  if (type === 'validation') return 2;
  if (type === 'authentication' || type === 'authorization' || type === 'config') return 3;
  if (type === 'network') return 4;
  if (type === 'verification' || type === 'internal') return 5;
  if (type === 'confirmation_required') return 10;
  return 1;
}

function isValidationMessage(message: string): boolean {
  return /^(?:error:\s*)?(?:unknown command\b|invalid\b|expected\b|choose only\b|.+\brequires?\b|.+\baccepts only\b|.+\bdoes not support\b|.+\bdoes not exist\b|could not find a supported feishu token)/i.test(message);
}
