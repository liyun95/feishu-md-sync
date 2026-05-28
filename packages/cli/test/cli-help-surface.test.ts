import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI help surface', () => {
  it('keeps top-level workflow commands discoverable', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', '--help'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    });

    for (const command of ['sync', 'status', 'pull', 'diff', 'merge', 'code-blocks', 'multisdk', 'reference', 'release', 'harness', 'workflow']) {
      expect(stdout).toContain(command);
    }
  });

  it('honors sync subcommand options before doing IO', async () => {
    await expect(execFileAsync('npx', [
      'tsx',
      'src/cli/index.ts',
      'sync',
      '--markdown-engine',
      'invalid',
      'missing.md',
      'doccn123456789012345678901234'
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid --markdown-engine invalid')
    });
  });
});
