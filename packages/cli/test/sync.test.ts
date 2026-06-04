import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashBlocks } from '../src/core/hash.js';
import type { FeishuBlock, FeishuDocClient } from '../src/feishu/types.js';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { createMarkdownEngine } from '../src/markdown/engine.js';
import { receiptPath, writeReceipt, type SyncReceipt } from '../src/receipts/receipt.js';
import { runSync } from '../src/sync/run-sync.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';

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
    expect(result.patchPlan.operation).toBe('replace-document');
    expect(client.deleteChildren).not.toHaveBeenCalled();
    await expect(readFile(result.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('dry-run rejects generated Feishu blocks with local Markdown links', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'For details, see [JSON Shredding](./json-shredding) and [Compatibility reference](#compatibility-reference).\n');
    const client = fakeClient([]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir
    })).rejects.toThrow(/unsupported Feishu link URL "\.\/json-shredding"/);
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('rewrites local Markdown links before Feishu write preflight when link base URL is configured', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'For details, see [NGRAM](ngram.md).\n');
    const desired = markdownToFeishuBlocks('For details, see [NGRAM](https://milvus.io/docs/ngram.md).\n');
    const client = fakeClient(desired);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      publishTransform: { linkBaseUrl: 'https://milvus.io/docs/' }
    });

    expect(result.preflight.passed).toBe(true);
    expect(result.patchPlan.desiredHash).toBe(hashBlocks(desired));
  });

  it('write rejects invalid Feishu links before deleting existing content', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'For details, see [JSON Shredding](./json-shredding).\n');
    const client = fakeClient([], [
      { block_id: 'remote-1', block_type: 2, text: { elements: [] } }
    ]);

    await expect(runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      forceInitialOverwrite: true
    })).rejects.toThrow(/unsupported Feishu link URL "\.\/json-shredding"/);
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(client.createChildren).not.toHaveBeenCalled();
  });

  it('allows absolute http links through preflight', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, 'For details, see [Milvus docs](https://milvus.io/docs/json-indexing.md).\n');
    const desired = markdownToFeishuBlocks('For details, see [Milvus docs](https://milvus.io/docs/json-indexing.md).\n');
    const client = fakeClient(desired);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    });

    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired);
  });

  it('dry-runs a named section replacement without writing', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `# Title

Local intro should not sync

## Target

New local body

## Other

Local other should not sync
`);
    const remote = markdownToFeishuBlocks(`# Title

Remote intro

## Target

Old remote body

## Other

Remote-only content
`);
    const client = fakeClient(remote, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      section: 'Target'
    });

    expect(result.patchPlan.operation).toBe('replace-section');
    expect(result.patchPlan.section).toMatchObject({
      title: 'Target',
      remoteStartIndex: 2,
      remoteEndIndex: 4,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(result.blockLevelSectionPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'update', remoteIndex: 3, desiredIndex: 1 })
    ]);
    expect(result.receipt.blockCounts.source).toBe(2);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });

  it('writes only a named section and preserves remote blocks outside the section', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `# Title

Local intro should not sync

## Target

New local body

## Other

Local other should not sync
`);
    const remote = markdownToFeishuBlocks(`# Title

Remote intro

## Target

Old remote body

## Other

Remote-only content
`);
    const local = markdownToFeishuBlocks(await readFile(sourcePath, 'utf8'));
    const expected = [
      ...remote.slice(0, 2),
      ...local.slice(2, 4),
      ...remote.slice(4)
    ];
    const client = fakeClient(expected, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      section: 'Target'
    });

    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc1234567890123', [
      expect.objectContaining({ block_id: 'child-3' })
    ]);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
    await expect(readFile(result.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.receiptWritten).toBe(false);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Scoped push used Feishu block-level patching.',
      'Scoped push does not update the whole-document receipt.'
    ]));
  });

  it('preflights only the selected section during scoped push', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `## Target

Safe body

## Other

[Local link outside target](./local-only)
`);
    const remote = markdownToFeishuBlocks('## Target\n\nOld body\n\n## Other\n\nRemote other\n');
    const local = markdownToFeishuBlocks(await readFile(sourcePath, 'utf8'));
    const expected = [
      ...local.slice(0, 2),
      ...remote.slice(2)
    ];
    const client = fakeClient(expected, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      section: 'Target'
    });

    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc1234567890123', [
      expect.objectContaining({ block_id: 'child-1' })
    ]);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });

  it('creates only an inserted block during scoped push', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `## FAQ

Inserted answer

Old answer

## Other

Local ignored
`);
    const remote = markdownToFeishuBlocks('## FAQ\n\nOld answer\n\n## Other\n\nKeep\n');
    const expected = markdownToFeishuBlocks('## FAQ\n\nInserted answer\n\nOld answer\n\n## Other\n\nKeep\n');
    const client = fakeClient(expected, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      section: 'FAQ'
    });

    expect(result.blockLevelSectionPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'create', index: 1, desiredStartIndex: 1, desiredEndIndex: 2 })
    ]);
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', [
      expect.objectContaining({ block_type: 2 })
    ], { index: 1 });
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(client.batchUpdateBlocks).not.toHaveBeenCalled();
  });

  it('uses local section rendering for auto-mode block-level planning', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '## FAQ\n\nInserted answer\n\nOld answer\n\n## Other\n\nLocal ignored\n');
    const remote = markdownToFeishuBlocks('## FAQ\n\nOld answer\n\n## Other\n\nKeep\n');
    const expected = markdownToFeishuBlocks('## FAQ\n\nInserted answer\n\nOld answer\n\n## Other\n\nKeep\n');
    const officialImport = vi.fn(async () => [
      markdownToFeishuBlocks('## FAQ\n\nOld answer\n')[0],
      markdownToFeishuBlocks('## FAQ\n\nOld answer\n')[1],
      markdownToFeishuBlocks('Inserted answer\n')[0]
    ]);
    const client = fakeClient(expected, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      section: 'FAQ',
      markdownEngine: createMarkdownEngine({
        mode: 'auto',
        official: {
          getMarkdownContent: vi.fn(),
          markdownToBlocks: officialImport
        }
      })
    });

    expect(officialImport).not.toHaveBeenCalled();
    expect(result.blockLevelSectionPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'create', index: 1 })
    ]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Scoped push used the local Markdown renderer')
    ]));
  });

  it('scoped push uses current remote content even when the whole-document receipt is stale', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '## Target\n\nNew body\n\n## Other\n\nLocal other\n');
    const baseBlocks = markdownToFeishuBlocks('## Target\n\nOld body\n\n## Other\n\nBase other\n');
    const remoteBlocks = markdownToFeishuBlocks('## Target\n\nOld body\n\n## Other\n\nRemote changed other\n');
    const localBlocks = markdownToFeishuBlocks(await readFile(sourcePath, 'utf8'));
    const expected = [
      ...localBlocks.slice(0, 2),
      ...remoteBlocks.slice(2)
    ];
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: '## Target\n\nOld body\n\n## Other\n\nBase other\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(baseBlocks),
      timestamp: '2026-05-20T00:00:00.000Z',
      blockCounts: { source: 4, feishuBefore: 4, feishuAfter: 4 },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: 4, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(baseBlocks), actualHash: hashBlocks(baseBlocks) }
    });
    const client = fakeClient(expected, remoteBlocks);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      section: 'Target'
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Feishu changed since the last receipt; scoped push will write only section "Target"')
    ]));
    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc1234567890123', [
      expect.objectContaining({ block_id: 'child-1' })
    ]);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
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

  it('writes receipts to an explicit receipt directory', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    const receiptDir = path.join(dir, 'custom-receipts');
    await writeFile(sourcePath, '# Title\n');
    const desired = markdownToFeishuBlocks('# Title\n');
    const client = fakeClient(desired);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: path.join(dir, 'cwd-root'),
      receiptDir,
      dryRun: false,
      yes: true
    });

    expect(result.receiptPath).toBe(path.join(receiptDir, 'doc.md.doc1234567890123.json'));
    await expect(readFile(result.receiptPath, 'utf8')).resolves.toContain('"feishuDocId": "doc1234567890123"');
  });

  it('applies a publish transform before planning Feishu blocks', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `---
title: "JSON Indexing"
---

# JSON Indexing

Milvus 3.0 updates Milvus behavior.
`);
    const desired = markdownToFeishuBlocks('<include target="milvus">Milvus 3.0</include> updates <include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> behavior.\n');
    const client = fakeClient(desired);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      publishTransform: { profile: 'milvus' }
    });

    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired);
    expect(result.receipt.blockCounts.source).toBe(1);
    expect(result.reviewDraftChecks).toEqual({ passed: true, issues: [] });
  });

  it('updates aligned whole-document text blocks in place after a publish transform', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `---
title: "Pattern Matching"
---

# Pattern Matching

## Overview

Milvus supports pattern matching.

## Reference

Milvus 3.0 keeps existing behavior.
`);
    const remote = markdownToFeishuBlocks(`## Overview

Milvus supports pattern matching.

## Reference

Milvus 3.0 keeps existing behavior.
`);
    const desired = markdownToFeishuBlocks(`## Overview

<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports pattern matching.

## Reference

<include target="milvus">Milvus 3.0</include> keeps existing behavior.
`);
    const statePath = receiptPath(dir, sourcePath, 'doc1234567890123');
    await writeReceipt(statePath, {
      sourcePath,
      sourceHash: 'old-source',
      sourceSnapshot: '## Overview\n\nMilvus supports pattern matching.\n\n## Reference\n\nMilvus 3.0 keeps existing behavior.\n',
      feishuDocId: 'doc1234567890123',
      feishuStateHash: hashBlocks(remote),
      timestamp: '2026-06-03T00:00:00.000Z',
      blockCounts: { source: remote.length, feishuBefore: remote.length, feishuAfter: remote.length },
      warnings: [],
      writeResult: { mode: 'write', deleted: 0, created: remote.length, skipped: false },
      verificationResult: { ok: true, expectedHash: hashBlocks(remote), actualHash: hashBlocks(remote) }
    });
    const client = fakeClient(desired, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      publishTransform: { profile: 'milvus' }
    });

    expect(result.blockLevelDocumentPatch?.operations).toEqual([
      expect.objectContaining({ kind: 'update', remoteIndex: 1, desiredIndex: 1 }),
      expect.objectContaining({ kind: 'update', remoteIndex: 3, desiredIndex: 3 })
    ]);
    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc1234567890123', [
      expect.objectContaining({ block_id: 'child-1' }),
      expect.objectContaining({ block_id: 'child-3' })
    ]);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(result.receipt.writeResult).toMatchObject({ mode: 'write', updated: 2, created: 0, deleted: 0 });
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

  it('warns on dry-run and refuses write when the document has an active multisdk task', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const taskDir = path.join(dir, 'runs', 'doc1234567890123');
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc1234567890123',
      taskDir,
      language: 'java'
    });
    await saveMultisdkTask({
      ...task,
      status: 'prepared',
      lane: { ...task.lane, prepared: true }
    });
    const desired = markdownToFeishuBlocks('# Title\n');

    const dryRun = await runSync(fakeClient(desired), {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir
    });

    expect(dryRun.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('active multisdk task')
    ]));
    await expect(runSync(fakeClient(desired), {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true
    })).rejects.toThrow(/active multisdk task/);
  });

  it('finds an active multisdk task from the source workspace when cwd root differs', async () => {
    const workspaceDir = path.join(dir, 'task-workspace');
    const sourcePath = path.join(workspaceDir, 'docs', 'doc.md');
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '# Title\n');
    const taskDir = path.join(workspaceDir, 'runs', 'doc1234567890123');
    await saveMultisdkTask(createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc1234567890123',
      taskDir,
      language: 'java'
    }));
    const desired = markdownToFeishuBlocks('# Title\n');

    await expect(runSync(fakeClient(desired), {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: path.join(dir, 'other-cwd'),
      dryRun: false,
      yes: true
    })).rejects.toThrow(/active multisdk task/);
  });

  it('allows whole-document sync over an active multisdk task only when explicitly forced', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Title\n');
    const taskDir = path.join(dir, 'runs', 'doc1234567890123');
    await saveMultisdkTask(createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc1234567890123',
      taskDir,
      language: 'java'
    }));
    const desired = markdownToFeishuBlocks('# Title\n');
    const client = fakeClient(desired);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      forceWholeDocumentSync: true
    });

    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired);
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

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      strategy: 'merge'
    });

    expect(await readFile(sourcePath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
    expect(result.patchPlan.operation).toBe('replace-contiguous-blocks');
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', mergedBlocks.slice(1, 2), { index: 2 });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc1234567890123', 'page', 1, 2);
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
    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc1234567890123', [
      expect.objectContaining({ block_id: 'child-1' }),
      expect.objectContaining({ block_id: 'child-2' })
    ]);
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(await readFile(sourcePath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
    expect(await readFile(mergedPath, 'utf8')).toBe('A\n\nLOCAL\n\nREMOTE\n');
  });

  it('creates replacement blocks before deleting changed existing blocks', async () => {
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

    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', desired, { index: 1 });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc1234567890123', 'page', 0, 1);
    expect(client.createChildren.mock.invocationCallOrder[0]).toBeLessThan(client.deleteChildren.mock.invocationCallOrder[0]);
  });
});

function fakeClient(readbackChildren: FeishuBlock[], initialChildren: FeishuBlock[] = []): FeishuDocClient & {
  deleteChildren: ReturnType<typeof vi.fn>;
  createChildren: ReturnType<typeof vi.fn>;
  batchUpdateBlocks: ReturnType<typeof vi.fn>;
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
    createChildren: vi.fn(async (_documentId: string, _parentBlockId: string, blocks: FeishuBlock[]) => blocks),
    batchUpdateBlocks: vi.fn(async () => [])
  };
}
