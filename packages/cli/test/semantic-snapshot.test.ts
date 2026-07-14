import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readRemoteSemanticSnapshot, writeRemoteSemanticSnapshot } from '../src/receipts/semantic-snapshot.js';
import type { SemanticDocument } from '../src/semantic/types.js';

describe('remote semantic snapshots', () => {
  it('stores semantic baselines without execution-only block IDs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-semantic-'));
    const target = { kind: 'wiki' as const, token: 'wiki_token' };
    const document: SemanticDocument = {
      nodes: [{
        kind: 'text',
        locator: { sectionPath: [], kind: 'text', ordinal: 0 },
        blockType: 2,
        markdown: 'Remote text.',
        remoteBlockId: 'block1'
      }]
    };

    const snapshot = await writeRemoteSemanticSnapshot({ cwd, target, document });
    expect(snapshot.path).toBe('.sync/feishu-md-sync/bases/wiki-wiki_token-remote-semantic.json');
    const raw = await readFile(join(cwd, snapshot.path), 'utf8');
    expect(raw).not.toContain('remoteBlockId');
    await expect(readRemoteSemanticSnapshot({ cwd, snapshot })).resolves.toEqual({
      nodes: [expect.objectContaining({ kind: 'text', markdown: 'Remote text.' })]
    });
  });

  it('rejects snapshot files whose content no longer matches the receipt hash', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-semantic-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const snapshot = await writeRemoteSemanticSnapshot({ cwd, target, document: { nodes: [] } });
    await writeFile(join(cwd, snapshot.path), '{"nodes":[{"changed":true}]}\n', 'utf8');

    await expect(readRemoteSemanticSnapshot({ cwd, snapshot })).rejects.toThrow('Remote semantic snapshot hash mismatch.');
  });

  it('stores Callout type and body semantics without runtime block IDs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-semantic-'));
    const target = { kind: 'docx' as const, token: 'doc_token' };
    const document: SemanticDocument = {
      nodes: [{
        kind: 'callout',
        locator: { sectionPath: [], kind: 'callout', ordinal: 0 },
        calloutType: 'note',
        title: { markdown: 'Notes', remoteBlockId: 'title1' },
        children: [{ ordinal: 0, blockType: 2, markdown: 'Body', remoteBlockId: 'body1' }],
        remoteBlockId: 'callout1',
        shell: { emojiId: '📘' },
        unsupported: []
      }]
    };

    const snapshot = await writeRemoteSemanticSnapshot({ cwd, target, document });
    const raw = await readFile(join(cwd, snapshot.path), 'utf8');

    expect(raw).toContain('"kind": "callout"');
    expect(raw).toContain('"calloutType": "note"');
    expect(raw).toContain('"markdown": "Body"');
    expect(raw).not.toContain('remoteBlockId');
  });
});
