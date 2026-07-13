import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  baseSnapshotPath,
  hashText,
  publishReceiptPath,
  readLocalBaseSnapshot,
  readPublishReceipt,
  writeLocalBaseSnapshot,
  writePublishReceipt
} from '../src/receipts/publish-receipt.js';

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

  it('writes and reads a version 2 receipt with resolved and semantic baselines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-v2-'));
    const receipt = {
      version: 2 as const,
      target: { kind: 'wiki' as const, token: 'wiki_token' },
      resolvedDocumentId: 'doc_token',
      profile: 'none' as const,
      localSourceHash: 'source',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'local.md', hash: 'local' },
      remoteSemanticSnapshot: { path: 'remote.json', hash: 'semantic' },
      updatedAt: '2026-07-13T00:00:00.000Z'
    };

    await writePublishReceipt({ cwd: dir, receipt });
    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
  });

  it('stores local authoring markdown outside the receipt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-base-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const path = baseSnapshotPath({ cwd: dir, target });

    const snapshot = await writeLocalBaseSnapshot({
      cwd: dir,
      target,
      markdown: '# Title\n\nMilvus stores vectors.'
    });

    expect(snapshot).toEqual({
      path: '.sync/feishu-md-sync/bases/docx-doc_token-local.md',
      hash: hashText('# Title\n\nMilvus stores vectors.')
    });
    await expect(readFile(path, 'utf8')).resolves.toBe('# Title\n\nMilvus stores vectors.');
    await expect(readLocalBaseSnapshot({ cwd: dir, snapshot })).resolves.toBe('# Title\n\nMilvus stores vectors.');
  });
});
