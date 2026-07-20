import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { writePublishBaselineBundle } from '../src/receipts/publish-baseline-bundle.js';
import {
  hashText,
  readLocalBaseSnapshot,
  readPublishBaseSnapshot,
  readPublishReceipt
} from '../src/receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot } from '../src/receipts/semantic-snapshot.js';

describe('publish baseline bundle', () => {
  it('keeps the previous receipt fully readable when a new sidecar commit fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-bundle-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const oldLocal = 'Old local.';
    const oldPublish = 'Old publish.';
    const oldRemote = semanticDocument('Old remote.');
    const old = await writePublishBaselineBundle({
      cwd,
      target,
      localBaseline: oldLocal,
      publishBaseline: oldPublish,
      remoteSemantic: oldRemote,
      receipt: receiptFields(oldLocal, oldPublish)
    });
    const newPublish = 'New publish.';
    const collidingPath = join(
      cwd,
      '.sync',
      'feishu-md-sync',
      'bases',
      `docx-doc_token-${hashText(newPublish).slice(0, 16)}-publish.md`
    );
    await mkdir(collidingPath, { recursive: true });

    await expect(writePublishBaselineBundle({
      cwd,
      target,
      localBaseline: 'New local.',
      publishBaseline: newPublish,
      remoteSemantic: semanticDocument('New remote.'),
      receipt: receiptFields('New local.', newPublish)
    })).rejects.toThrow();

    const receipt = await readPublishReceipt({ cwd, target });
    expect(receipt).toEqual(old.receipt);
    if (!receipt || (receipt.version !== 4 && receipt.version !== 5)) {
      throw new Error('expected current publish receipt');
    }
    await expect(readLocalBaseSnapshot({ cwd, snapshot: receipt.localBaseSnapshot }))
      .resolves.toBe(oldLocal);
    await expect(readPublishBaseSnapshot({ cwd, snapshot: receipt.publishBaseSnapshot }))
      .resolves.toBe(oldPublish);
    await expect(readRemoteSemanticSnapshot({ cwd, snapshot: receipt.remoteSemanticSnapshot! }))
      .resolves.toEqual(oldRemote);
  });
});

function receiptFields(local: string, publish: string) {
  return {
    resolvedDocumentId: 'doc_token',
    profile: 'none' as const,
    dialect: 'gfm' as const,
    dialectDraftHash: hashText(publish),
    dialectDependencies: [],
    linkResolutionFingerprint: hashText('links'),
    resolvedLinks: [],
    localSourceHash: hashText(local),
    publishDraftHash: hashText(publish),
    remoteSnapshotHash: hashText('remote markdown'),
    remoteRevision: 'rev-7',
    whiteboards: [],
    updatedAt: '2026-07-17T00:00:00.000Z'
  };
}

function semanticDocument(markdown: string) {
  return {
    nodes: [{
      kind: 'text' as const,
      locator: { sectionPath: [], kind: 'text' as const, ordinal: 0 },
      blockType: 2,
      markdown
    }]
  };
}
