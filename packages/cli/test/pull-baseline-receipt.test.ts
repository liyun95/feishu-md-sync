import { describe, expect, it } from 'vitest';
import { buildPullBaselineReceipt } from '../src/cli/commands/sync.js';
import type { FeishuDocClient } from '../src/feishu/types.js';
import { pullRemoteMarkdownWithState } from '../src/sync/pull.js';

describe('pullRemoteMarkdownWithState', () => {
  it('returns exported markdown with the remote block hash needed for a baseline receipt', async () => {
    const client: FeishuDocClient = {
      getDocumentBlocks: async () => [
        { block_id: 'doc123', block_type: 1, children: ['heading1'] },
        { block_id: 'heading1', block_type: 3, heading1: { elements: [], style: {} } }
      ]
    } as unknown as FeishuDocClient;

    const result = await pullRemoteMarkdownWithState(client, 'doc123', {
      exportMarkdown: async () => ({ markdown: '# Remote\n' }),
      importMarkdown: async () => ({ blocks: [] })
    });

    expect(result.markdown).toBe('# Remote\n');
    expect(result.remoteBlockCount).toBe(1);
    expect(result.remoteHash).toHaveLength(64);
  });
});

describe('buildPullBaselineReceipt', () => {
  it('records a read-only baseline without pretending Feishu was written', async () => {
    const receipt = await buildPullBaselineReceipt({
      sourcePath: '/tmp/doc.md',
      sourceMarkdown: '# Remote\n',
      documentId: 'doc123',
      remoteHash: 'a'.repeat(64),
      remoteBlockCount: 3,
      timestamp: '2026-05-28T00:00:00.000Z'
    });

    expect(receipt.sourcePath).toBe('/tmp/doc.md');
    expect(receipt.sourceHash).toHaveLength(64);
    expect(receipt.feishuStateHash).toBe('a'.repeat(64));
    expect(receipt.sourceSnapshot).toBe('# Remote\n');
    expect(receipt.feishuMarkdownSnapshot).toBe('# Remote\n');
    expect(receipt.writeResult).toEqual({
      mode: 'dry-run',
      deleted: 0,
      created: 0,
      updated: 0,
      skipped: true
    });
    expect(receipt.verificationResult).toEqual({
      ok: true,
      expectedHash: 'a'.repeat(64),
      actualHash: 'a'.repeat(64)
    });
  });
});
