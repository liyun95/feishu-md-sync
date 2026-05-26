import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWebContentCommand, validateWebContentRepo } from '../src/reference/web-content.js';

describe('reference web-content adapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('builds the stale-link check command for SDK manuals', () => {
    const command = buildWebContentCommand({
      repo: '/Users/liyun/web-content',
      config: 'scripts/config.json',
      manual: 'java-v2.6.x',
      mode: 'check'
    });

    expect(command.cwd).toBe('/Users/liyun/web-content');
    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      'scripts/lark-docs/index.js',
      '--config',
      'scripts/config.json',
      '--manual',
      'java-v2.6.x',
      '--dry-run'
    ]);
  });

  it('builds a targeted pull command without adding --dry-run', () => {
    const command = buildWebContentCommand({
      repo: '/Users/liyun/web-content',
      config: 'scripts/config.json',
      manual: 'java-v2.6.x',
      mode: 'pull',
      doc: 'describeCollection()',
      output: 'MilvusClient/Collections/describeCollection.md',
      skipImageDown: true
    });

    expect(command.args).toContain('--doc');
    expect(command.args).toContain('describeCollection()');
    expect(command.args).toContain('--output');
    expect(command.args).toContain('MilvusClient/Collections/describeCollection.md');
    expect(command.args).toContain('--skipImageDown');
    expect(command.args).not.toContain('--dry-run');
  });

  it('validates the external repo has the lark docs script and config', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'web-content-'));
    tempDirs.push(repo);
    await mkdir(join(repo, 'scripts/lark-docs'), { recursive: true });
    await writeFile(join(repo, 'scripts/lark-docs/index.js'), '#!/usr/bin/env node\n', 'utf8');
    await writeFile(join(repo, 'scripts/config.json'), '{}\n', 'utf8');

    await expect(validateWebContentRepo({ repo, config: 'scripts/config.json' })).resolves.toEqual({
      repo,
      configPath: join(repo, 'scripts/config.json'),
      scriptPath: join(repo, 'scripts/lark-docs/index.js')
    });
  });
});
