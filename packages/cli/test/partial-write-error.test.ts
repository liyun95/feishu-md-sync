import { describe, expect, it } from 'vitest';
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
});
