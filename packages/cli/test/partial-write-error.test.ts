import { describe, expect, it } from 'vitest';
import { CliFailure, normalizeCliFailure } from '../src/core/cli-failure.js';
import { PartialWriteError } from '../src/publish/partial-write-error.js';

describe('PartialWriteError', () => {
  it('reports completed scoped writes before a Whiteboard failure', () => {
    const error = new PartialWriteError({
      completedOperations: [{ kind: 'update', locator: { sectionPath: [], kind: 'text', ordinal: 0 } }],
      failedOperation: {
        kind: 'whiteboard-update',
        assetKey: 'assets/cagra.png',
        locator: { sectionPath: [], kind: 'asset', ordinal: 0 }
      },
      pendingOperations: [{ kind: 'callout-delete', locator: { sectionPath: [], kind: 'callout', ordinal: 0 } }],
      cause: new Error('network failed')
    });

    expect(error.message).toBe('Publish partially failed at whiteboard-update: network failed');
    expect(error).toMatchObject({
      name: 'PartialWriteError',
      receiptWritten: false,
      completedOperations: [expect.objectContaining({ kind: 'update' })],
      failedOperation: expect.objectContaining({ kind: 'whiteboard-update', assetKey: 'assets/cagra.png' }),
      pendingOperations: [expect.objectContaining({ kind: 'callout-delete' })]
    });
  });

  it('preserves partial-write operations and created document recovery details in CLI JSON', () => {
    const error = new PartialWriteError({
      completedOperations: [{ kind: 'document-create' }],
      failedOperation: { kind: 'created-document-readback' },
      pendingOperations: [{
        kind: 'authoring-token-create',
        locator: { sectionPath: ['Create'], kind: 'authoring-token', ordinal: 1 }
      }],
      document: {
        documentId: 'doc_created',
        url: 'https://example.feishu.cn/docx/doc_created'
      },
      cause: new Error('boundary differs')
    });

    expect(normalizeCliFailure(error).details).toMatchObject({
      type: 'verification',
      subtype: 'partial_write',
      partialWrite: {
        receiptWritten: false,
        completedOperations: [{ kind: 'document-create' }],
        failedOperation: { kind: 'created-document-readback' },
        pendingOperations: [expect.objectContaining({ kind: 'authoring-token-create' })],
        document: {
          documentId: 'doc_created',
          url: 'https://example.feishu.cn/docx/doc_created'
        }
      }
    });
  });

  it('preserves the structured underlying failure and recovery checkpoint in CLI JSON', () => {
    const error = new PartialWriteError({
      completedOperations: [{ kind: 'update' }],
      failedOperation: { kind: 'create' },
      recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '2264',
      cause: new CliFailure({
        type: 'network',
        subtype: 'rate_limited',
        message: 'Too many requests',
        retryable: true
      })
    });

    expect(normalizeCliFailure(error).details.partialWrite).toMatchObject({
      receiptWritten: false,
      recoveryCheckpointWritten: true,
      recoveryCheckpointRevision: '2264',
      cause: {
        type: 'network',
        subtype: 'rate_limited',
        retryable: true
      }
    });
  });
});
