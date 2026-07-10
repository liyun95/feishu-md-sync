import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { pullReceiptPath, readPullReceipt, writePullReceipt } from '../src/receipts/pull-receipt.js';

describe('pull receipt', () => {
  it('writes and reads a pull snapshot receipt keyed by output path and target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-receipt-'));
    const receipt = {
      version: 1 as const,
      kind: 'pull-snapshot' as const,
      target: { kind: 'docx' as const, token: 'doc_token' },
      outputPath: 'doc.remote.md',
      profile: 'milvus' as const,
      remoteRevision: '11',
      remoteRawHash: 'raw',
      outputHash: 'output',
      pulledAt: '2026-07-09T00:00:00.000Z'
    };

    await writePullReceipt({ cwd: dir, receipt });

    const path = pullReceiptPath({ cwd: dir, outputPath: receipt.outputPath, target: receipt.target });
    expect(path).toContain('/.sync/feishu-md-sync/pulls/');
    await expect(readFile(path, 'utf8')).resolves.toContain('"kind": "pull-snapshot"');
    await expect(readPullReceipt({ cwd: dir, outputPath: receipt.outputPath, target: receipt.target })).resolves.toEqual(receipt);
  });

  it('does not collide with another output path for the same target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-receipt-'));

    expect(pullReceiptPath({
      cwd: dir,
      outputPath: 'one.remote.md',
      target: { kind: 'docx', token: 'doc_token' }
    })).not.toBe(pullReceiptPath({
      cwd: dir,
      outputPath: 'two.remote.md',
      target: { kind: 'docx', token: 'doc_token' }
    }));
  });

  it('returns undefined when a pull receipt does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-receipt-'));

    await expect(readPullReceipt({
      cwd: dir,
      outputPath: 'missing.remote.md',
      target: { kind: 'docx', token: 'missing' }
    })).resolves.toBeUndefined();
  });
});
