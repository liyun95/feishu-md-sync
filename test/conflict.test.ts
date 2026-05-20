import { describe, expect, it } from 'vitest';
import { detectConflict } from '../src/sync/conflict.js';
import type { SyncReceipt } from '../src/receipts/receipt.js';

const receipt: SyncReceipt = {
  sourcePath: '/tmp/doc.md',
  sourceHash: 'source',
  feishuDocId: 'doc',
  feishuStateHash: 'old-feishu',
  timestamp: '2026-05-20T00:00:00.000Z',
  blockCounts: { source: 1, feishuBefore: 1, feishuAfter: 1 },
  warnings: [],
  writeResult: { mode: 'write', deleted: 1, created: 1, skipped: false },
  verificationResult: { ok: true, expectedHash: 'old-feishu', actualHash: 'old-feishu' }
};

describe('detectConflict', () => {
  it('allows first sync without a receipt', () => {
    expect(detectConflict(null, 'current')).toEqual({ ok: true, reason: 'no-receipt' });
  });

  it('allows unchanged Feishu state', () => {
    expect(detectConflict(receipt, 'old-feishu')).toEqual({ ok: true, reason: 'remote-unchanged' });
  });

  it('fails closed when Feishu changed since the receipt', () => {
    expect(detectConflict(receipt, 'new-feishu')).toEqual({
      ok: false,
      reason: 'remote-changed',
      expectedHash: 'old-feishu',
      actualHash: 'new-feishu'
    });
  });

  it('classifies remote changes after a receipt as a blocking conflict', () => {
    expect(detectConflict(receipt, 'new-feishu')).toEqual({
      ok: false,
      reason: 'remote-changed',
      expectedHash: 'old-feishu',
      actualHash: 'new-feishu'
    });
  });

  it('allows no receipt but exposes that it is an initial baseline', () => {
    expect(detectConflict(null, 'anything')).toEqual({
      ok: true,
      reason: 'no-receipt'
    });
  });
});
