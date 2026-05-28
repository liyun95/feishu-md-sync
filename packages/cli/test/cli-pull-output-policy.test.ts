import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPullOutputWritable } from '../src/cli/commands/sync.js';

describe('pull output policy', () => {
  it('refuses to overwrite an existing output unless --overwrite is explicit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'md2feishu-pull-policy-'));
    const output = join(dir, 'doc.md');
    await writeFile(output, 'local draft\n', 'utf8');

    await expect(assertPullOutputWritable(output, false)).rejects.toThrow(/Refusing to overwrite existing output/);
    expect(await readFile(output, 'utf8')).toBe('local draft\n');
  });

  it('allows a missing output path without --overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'md2feishu-pull-policy-'));
    await expect(assertPullOutputWritable(join(dir, 'new.md'), false)).resolves.toBeUndefined();
  });
});
