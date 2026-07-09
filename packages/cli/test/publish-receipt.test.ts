import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hashText, publishReceiptPath, readPublishReceipt, writePublishReceipt } from '../src/receipts/publish-receipt.js';

describe('publish receipt', () => {
  it('hashes text deterministically', () => {
    expect(hashText('hello')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('world'));
  });

  it('writes and reads a publish receipt for a target doc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-'));
    const receipt = {
      version: 1 as const,
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'zilliz' as const,
      localSourceHash: 'source',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      remoteRevision: 'rev1',
      updatedAt: '2026-07-09T00:00:00.000Z'
    };

    await writePublishReceipt({ cwd: dir, receipt });

    const path = publishReceiptPath({ cwd: dir, target: receipt.target });
    await expect(readFile(path, 'utf8')).resolves.toContain('"remoteSnapshotHash": "remote"');
    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
  });

  it('returns undefined when a receipt does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-'));

    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'missing' } })).resolves.toBeUndefined();
  });
});
