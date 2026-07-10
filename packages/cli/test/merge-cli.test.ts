import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

const cli = new URL('../src/cli/index.ts', import.meta.url).pathname;
const tsxLoader = new URL('../../../node_modules/tsx/dist/esm/index.mjs', import.meta.url).pathname;

function runCli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', tsxLoader, cli, ...args], {
      cwd,
      env: { ...process.env, APP_ID: '', APP_SECRET: '', ...env }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('merge CLI', () => {
  it('documents new-core merge options only', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-cli-'));

    const result = await runCli(cwd, ['merge', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target <url-or-token>');
    expect(result.stdout).toContain('--remote <file>');
    expect(result.stdout).toContain('--abort');
    expect(result.stdout).not.toContain('legacy Feishu docx ID or URL');
  });

  it('writes conflict JSON and exits 1 when merge conflicts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-cli-'));
    const file = join(cwd, 'doc.md');
    const remote = join(cwd, 'doc.remote.md');
    await writeFile(file, 'Local\n', 'utf8');
    await writeFile(remote, 'Remote\n', 'utf8');

    const result = await runCli(cwd, [
      'merge',
      file,
      '--remote',
      remote,
      '--profile',
      'none',
      '--format',
      'json'
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"state": "conflict"');
    expect(result.stdout).toContain('"conflicts": 1');
    await expect(readFile(file, 'utf8')).resolves.toContain('<<<<<<< LOCAL');
  });

  it('aborts a conflicted merge and exits 0', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-merge-cli-'));
    const file = join(cwd, 'doc.md');
    const remote = join(cwd, 'doc.remote.md');
    await writeFile(file, 'Local\n', 'utf8');
    await writeFile(remote, 'Remote\n', 'utf8');

    await runCli(cwd, ['merge', file, '--remote', remote, '--profile', 'none']);
    const result = await runCli(cwd, ['merge', file, '--abort', '--profile', 'none', '--format', 'json']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"state": "aborted"');
    await expect(readFile(file, 'utf8')).resolves.toBe('Local\n');
  });
});
