import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReceipt, receiptPath, receiptPathInDir, writeReceipt, type SyncReceipt } from '../src/receipts/receipt.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feishu-md-sync-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('receipts', () => {
  it('returns null for missing receipts', async () => {
    expect(await readReceipt(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('writes and reads receipt JSON', async () => {
    const file = receiptPath(dir, '/docs/My Doc.md', 'doc1234567890123');
    const receipt: SyncReceipt = {
      sourcePath: '/docs/My Doc.md',
      sourceHash: 'source',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: 'feishu',
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 0, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 1, skipped: false },
      verificationResult: { ok: true, expectedHash: 'feishu', actualHash: 'feishu' }
    };

    await writeReceipt(file, receipt);
    expect(await readReceipt(file)).toEqual(receipt);
  });

  it('builds explicit receipt paths directly inside a receipt directory', () => {
    expect(receiptPathInDir(path.join(dir, 'receipts'), '/docs/My Doc.md', 'doc1234567890123')).toBe(
      path.join(dir, 'receipts', 'My_Doc.md.doc1234567890123.json')
    );
  });

  it('reads receipts with optional markdown snapshots for future merge support', async () => {
    const file = receiptPath(dir, '/docs/My Doc.md', 'doc1234567890123');
    const receipt: SyncReceipt = {
      sourcePath: '/docs/My Doc.md',
      sourceHash: 'source',
      sourceSnapshot: '# Title\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: 'feishu',
      feishuMarkdownSnapshot: '# Title\n',
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 0, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 1, skipped: false },
      verificationResult: { ok: true, expectedHash: 'feishu', actualHash: 'feishu' }
    };

    await writeReceipt(file, receipt);
    await expect(readReceipt(file)).resolves.toMatchObject({
      sourceSnapshot: '# Title\n',
      feishuMarkdownSnapshot: '# Title\n'
    });
  });
});
