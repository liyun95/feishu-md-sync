import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assertNoMergeState,
  restoreMergeState,
  writeMergeState
} from '../src/merge/merge-state.js';

describe('merge state', () => {
  it('stores original local content and restores it on abort', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-state-'));
    const file = join(cwd, 'doc.md');
    await writeFile(file, 'before', 'utf8');

    const state = await writeMergeState({
      cwd,
      filePath: file,
      originalMarkdown: 'before',
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'milvus'
    });
    await writeFile(file, 'after merge', 'utf8');

    const result = await restoreMergeState({ cwd, filePath: file });

    expect(result.restored).toBe(true);
    expect(result.statePath).toBe(state.statePath);
    await expect(readFile(file, 'utf8')).resolves.toBe('before');
    await expect(assertNoMergeState({ cwd, filePath: file })).resolves.toBeUndefined();
  });

  it('refuses to overwrite existing merge state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-state-'));
    const file = join(cwd, 'doc.md');

    await writeMergeState({
      cwd,
      filePath: file,
      originalMarkdown: 'before',
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'milvus'
    });

    await expect(assertNoMergeState({ cwd, filePath: file })).rejects.toThrow('A merge is already in progress');
  });
});
