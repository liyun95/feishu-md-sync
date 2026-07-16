import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  baseSnapshotPath,
  hashText,
  publishReceiptPath,
  readPublishBaseSnapshot,
  readLocalBaseSnapshot,
  readPublishReceipt,
  receiptDialect,
  protectedResourceEntries,
  whiteboardEntries,
  writePublishBaseSnapshot,
  writeLocalBaseSnapshot,
  writePublishReceipt,
  type PublishReceiptV3,
  type PublishReceiptV4,
  type PublishReceiptV5
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

  it('writes and reads a version 3 receipt with Whiteboard baselines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-v3-'));
    const receipt: PublishReceiptV3 = {
      version: 3,
      target: { kind: 'docx', token: 'doc_token' },
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      localSourceHash: 'local',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'base.md', hash: 'base' },
      remoteSemanticSnapshot: { path: 'remote.json', hash: 'semantic' },
      whiteboards: [{
        assetKey: 'assets/cagra.png',
        pngPath: 'assets/cagra.png',
        svgPath: 'assets/cagra.svg',
        svgHash: 'svg',
        whiteboardToken: 'wb',
        blockId: 'block',
        remoteStateHash: 'raw',
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-13T00:00:00.000Z'
    };

    await writePublishReceipt({ cwd: dir, receipt });

    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
    expect(whiteboardEntries(receipt)).toEqual(receipt.whiteboards);
  });

  it('stores dialect metadata and an exact prior publish draft snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-v4-'));
    const snapshot = await writePublishBaseSnapshot({
      cwd: dir,
      target: { kind: 'wiki', token: 'wiki_token' },
      markdown: '# Published\n\nResolved [link](https://example.feishu.cn/wiki/next).\n'
    });
    const receipt: PublishReceiptV4 = {
      version: 4,
      target: { kind: 'wiki', token: 'wiki_token' },
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      dialect: 'zdoc-authoring',
      dialectDraftHash: 'dialect',
      dialectDependencies: [],
      linkResolutionFingerprint: 'links',
      resolvedLinks: [],
      localSourceHash: 'source',
      publishDraftHash: 'publish',
      publishBaseSnapshot: snapshot,
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'local.md', hash: 'local' },
      remoteSemanticSnapshot: { path: 'remote.json', hash: 'semantic' },
      whiteboards: [],
      updatedAt: '2026-07-15T00:00:00.000Z'
    };
    await writePublishReceipt({ cwd: dir, receipt });
    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
    await expect(readPublishBaseSnapshot({ cwd: dir, snapshot })).resolves.toContain('Resolved [link]');
  });

  it('writes and reads version 5 protected resource mappings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-v5-'));
    const receipt: PublishReceiptV5 = {
      version: 5,
      target: { kind: 'docx', token: 'doc_token' },
      resolvedDocumentId: 'doc_token',
      profile: 'none',
      dialect: 'zdoc-authoring',
      dialectDraftHash: 'dialect',
      dialectDependencies: [],
      linkResolutionFingerprint: 'links',
      resolvedLinks: [],
      localSourceHash: 'source',
      publishDraftHash: 'publish',
      publishBaseSnapshot: { path: 'publish.md', hash: 'publish' },
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'local.md', hash: 'local' },
      whiteboards: [],
      protectedResources: [{
        kind: 'supademo',
        componentId: 'demo',
        blockId: 'isv1',
        remoteShape: 'add-ons:supademo',
        sectionPath: ['Demo'],
        ordinal: 0,
        previousFingerprint: 'before',
        nextFingerprint: 'after'
      }],
      updatedAt: '2026-07-16T00:00:00.000Z'
    };

    await writePublishReceipt({ cwd: dir, receipt });

    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
    expect(protectedResourceEntries(receipt)).toEqual(receipt.protectedResources);
  });

  it('treats legacy receipts as gfm and keeps V3 Whiteboards readable', () => {
    expect(receiptDialect({
      version: 1,
      target: { kind: 'docx', token: 'legacy' },
      profile: 'none',
      localSourceHash: 'local',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      updatedAt: '2026-07-13T00:00:00.000Z'
    })).toBe('gfm');
    expect(whiteboardEntries({
      version: 3,
      target: { kind: 'docx', token: 'doc' },
      resolvedDocumentId: 'doc',
      profile: 'none',
      localSourceHash: 'local',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'base.md', hash: 'base' },
      remoteSemanticSnapshot: { path: 'remote.json', hash: 'semantic' },
      whiteboards: [{
        assetKey: 'assets/diagram.png',
        pngPath: 'assets/diagram.png',
        svgPath: 'assets/diagram.svg',
        svgHash: 'svg',
        whiteboardToken: 'whiteboard',
        blockId: 'block',
        remoteStateHash: 'remote-state',
        placementFingerprint: 'placement'
      }],
      updatedAt: '2026-07-13T00:00:00.000Z'
    })).toHaveLength(1);
  });

  it('treats legacy receipts as having no Whiteboard entries', () => {
    expect(whiteboardEntries(undefined)).toEqual([]);
    expect(whiteboardEntries({
      version: 1,
      target: { kind: 'docx', token: 'doc' },
      profile: 'none',
      localSourceHash: 'local',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      updatedAt: '2026-07-13T00:00:00.000Z'
    })).toEqual([]);
    expect(whiteboardEntries({
      version: 2,
      target: { kind: 'docx', token: 'doc' },
      resolvedDocumentId: 'doc',
      profile: 'none',
      localSourceHash: 'local',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      localBaseSnapshot: { path: 'base.md', hash: 'base' },
      remoteSemanticSnapshot: { path: 'remote.json', hash: 'semantic' },
      updatedAt: '2026-07-13T00:00:00.000Z'
    })).toEqual([]);
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
