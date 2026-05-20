import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashBlocks } from '../src/core/hash.js';
import type { FeishuBlock, FeishuDocClient } from '../src/feishu/types.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { receiptPath, writeReceipt, type SyncReceipt } from '../src/receipts/receipt.js';
import { runSync } from '../src/sync/run-sync.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'feishu-md-sync-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runSync', () => {
  it('dry-runs by default and does not write a receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n\nBody\n');
    const client = fakeClient([]);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir
    });

    expect(result.mode).toBe('dry-run');
    expect(result.patchPlan.operation).toBe('replace-all');
    expect(client.deleteChildren).not.toHaveBeenCalled();
    await expect(readFile(result.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes, verifies readback, and stores a receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n\nBody\n');
    const desired = markdownToFeishuBlocks('# Title\n\nBody\n');
    const client = fakeClient(desired);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    });

    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired);
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as SyncReceipt;
    expect(receipt.writeResult).toMatchObject({ mode: 'write', created: 2 });
    expect(receipt.verificationResult.ok).toBe(true);
  });

  it('fails when verification readback does not match desired blocks', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const client = fakeClient([{ block_type: 2, text: { elements: [] } }]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    })).rejects.toThrow(/Verification mismatch/);
  });

  it('requires confirmation for writes without --yes', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const client = fakeClient([]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      confirm: async () => false
    })).rejects.toThrow(/cancelled/);
  });

  it('refuses initial write over non-empty Feishu doc unless forceInitialOverwrite is set', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const client = fakeClient(markdownToFeishuBlocks('# Title\n'), [
      { block_id: 'remote-1', block_type: 2, text: { elements: [] } }
    ]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    })).rejects.toThrow(/Initial write would replace existing Feishu content/);
  });

  it('allows initial write over non-empty Feishu doc with forceInitialOverwrite', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const desired = markdownToFeishuBlocks('# Title\n');
    const client = fakeClient(desired, [
      { block_id: 'remote-1', block_type: 2, text: { elements: [] } }
    ]);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      forceInitialOverwrite: true
    });

    expect(client.deleteChildren).toHaveBeenCalled();
    expect(client.createChildren).toHaveBeenCalled();
  });

  it('fails closed when a previous receipt hash does not match Feishu state', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    await mkdir(path.join(dir, '.sync', 'feishu'), { recursive: true });
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'source',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: 'stale',
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 1, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 1, skipped: false },
      verificationResult: { ok: true, expectedHash: 'stale', actualHash: 'stale' }
    });
    const client = fakeClient([]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    })).rejects.toThrow(/Refusing to sync/);
  });

  it('allows local-wins only when explicitly requested', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'New body\n');
    const desired = markdownToFeishuBlocks('New body\n');
    const existingChild = { block_id: 'old', block_type: 2, text: { elements: [] } };
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'source',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: 'stale',
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 1, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 1, skipped: false },
      verificationResult: { ok: true, expectedHash: 'stale', actualHash: 'stale' }
    });

    await expect(runSync(fakeClient(desired, [existingChild]), {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'fail'
    })).rejects.toThrow(/Feishu changed since the last receipt/);

    const client = fakeClient(desired, [existingChild]);
    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'local-wins'
    });

    expect(client.deleteChildren).toHaveBeenCalled();
  });

  it('strategy merge writes clean merged content when remote changed without conflicts', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'A\n\nLOCAL\n\nC\n');
    const baseBlocks = markdownToFeishuBlocks('A\n\nB\n\nC\n');
    const remoteBlocks = markdownToFeishuBlocks('A\n\nB\n\nREMOTE\n');
    const mergedBlocks = markdownToFeishuBlocks('A\n\nLOCAL\n\nREMOTE\n');
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: 'A\n\nB\n\nC\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(baseBlocks),
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 3, feishuBefore: 3, feishuAfter: 3 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 3, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(baseBlocks), actualHash: hashBlocks(baseBlocks) }
    });
    const client = fakeClient(mergedBlocks, remoteBlocks);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'merge'
    });

    expect(await readFile(sourcePath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', mergedBlocks);
  });

  it('strategy merge does not update the local file when confirmation is rejected', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'A\n\nLOCAL\n\nC\n');
    const baseBlocks = markdownToFeishuBlocks('A\n\nB\n\nC\n');
    const remoteBlocks = markdownToFeishuBlocks('A\n\nB\n\nREMOTE\n');
    const mergedBlocks = markdownToFeishuBlocks('A\n\nLOCAL\n\nREMOTE\n');
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: 'A\n\nB\n\nC\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(baseBlocks),
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 3, feishuBefore: 3, feishuAfter: 3 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 3, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(baseBlocks), actualHash: hashBlocks(baseBlocks) }
    });
    const client = fakeClient(mergedBlocks, remoteBlocks);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      strategy: 'merge',
      confirm: async () => false
    })).rejects.toThrow(/cancelled/);

    expect(await readFile(sourcePath, 'utf8')).toBe('A\n\nLOCAL\n\nC\n');
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('strategy merge writes merged file and refuses Feishu write when conflicts remain', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'A\n\nLOCAL\n\nC\n');
    const baseBlocks = markdownToFeishuBlocks('A\n\nB\n\nC\n');
    const remoteBlocks = markdownToFeishuBlocks('A\n\nREMOTE\n\nC\n');
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: 'A\n\nB\n\nC\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(baseBlocks),
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 3, feishuBefore: 3, feishuAfter: 3 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 3, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(baseBlocks), actualHash: hashBlocks(baseBlocks) }
    });
    const client = fakeClient(remoteBlocks, remoteBlocks);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'merge'
    })).rejects.toThrow(/Merge conflicts written/);

    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(await readFile(path.join(dir, 'doc.merged.md'), 'utf8')).toContain('<<<<<<< LOCAL');
  });

  it('syncs a resolved merged file using the original receipt without forceInitialOverwrite', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    const mergedPath = path.join(dir, 'doc.merged.md');
    await writeFile(sourcePath, 'A\n\nLOCAL\n\nC\n');
    await writeFile(mergedPath, 'A\n\nLOCAL\n\nREMOTE\n');
    const baseBlocks = markdownToFeishuBlocks('A\n\nB\n\nC\n');
    const remoteBlocks = markdownToFeishuBlocks('A\n\nREMOTE\n\nC\n');
    const mergedBlocks = markdownToFeishuBlocks('A\n\nLOCAL\n\nREMOTE\n');
    const originalStatePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(originalStatePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: 'A\n\nB\n\nC\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(baseBlocks),
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 3, feishuBefore: 3, feishuAfter: 3 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 3, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(baseBlocks), actualHash: hashBlocks(baseBlocks) }
    });
    const client = fakeClient(mergedBlocks, remoteBlocks);

    const result = await runSync(client, {
      sourcePath: mergedPath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'local-wins'
    });

    expect(result.receiptPath).toBe(originalStatePath);
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', mergedBlocks);
    expect(await readFile(sourcePath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
    expect(await readFile(mergedPath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
  });

  it('deletes and recreates changed existing blocks', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'New body\n');
    const existingChild = { block_id: 'old', block_type: 2, text: { elements: [] } };
    const desired = markdownToFeishuBlocks('New body\n');
    const currentHash = hashBlocks([existingChild]);
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'source',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: currentHash,
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 1, feishuBefore: 1, feishuAfter: 1 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 1, skipped: false },
      verificationResult: { ok: true, expectedHash: currentHash, actualHash: currentHash }
    });
    const client = fakeClient(desired, [existingChild]);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    });

    expect(client.deleteChildren).toHaveBeenCalledWith('doc1234567890123', 'page', 0, 1);
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired);
  });
});

function fakeClient(readbackChildren: FeishuBlock[], initialChildren: FeishuBlock[] = []): FeishuDocClient & {
  deleteChildren: ReturnType<typeof vi.fn>;
  createChildren: ReturnType<typeof vi.fn>;
} {
  let callCount = 0;
  const blockList = (children: FeishuBlock[]): FeishuBlock[] => [
    { block_id: 'page', block_type: 1, children: children.map((child, index) => child.block_id ?? `child-${index}`) },
    ...children.map((child, index) => ({ block_id: child.block_id ?? `child-${index}`, ...child }))
  ];

  return {
    getDocumentBlocks: vi.fn(async () => {
      callCount += 1;
      return callCount === 1 ? blockList(initialChildren) : blockList(readbackChildren);
    }),
    deleteChildren: vi.fn(async () => undefined),
    createChildren: vi.fn(async (_documentId: string, _parentBlockId: string, blocks: FeishuBlock[]) => blocks)
  };
}
