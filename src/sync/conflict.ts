import type { SyncReceipt } from '../receipts/receipt.js';

export type ConflictResult =
  | { ok: true; reason: 'no-receipt' | 'remote-unchanged' }
  | { ok: false; reason: 'remote-changed'; expectedHash: string; actualHash: string };

export function detectConflict(receipt: SyncReceipt | null, currentFeishuHash: string): ConflictResult {
  if (!receipt) {
    return { ok: true, reason: 'no-receipt' };
  }

  if (receipt.feishuStateHash !== currentFeishuHash) {
    return {
      ok: false,
      reason: 'remote-changed',
      expectedHash: receipt.feishuStateHash,
      actualHash: currentFeishuHash
    };
  }

  return { ok: true, reason: 'remote-unchanged' };
}
