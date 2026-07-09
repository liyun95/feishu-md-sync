import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('publish CLI', () => {
  it('shows publish in top-level help under the new command name', async () => {
    const result = await runCli(['--help']);

    expect(result.stdout).toContain('Usage: feishu-md-sync');
    expect(result.stdout).toContain('publish');
  });

  it('rejects document replace writes without confirm-destructive before doing IO', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'zilliz',
      '--write',
      '--strategy',
      'document-replace'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--confirm-destructive is required with --strategy document-replace --write');
  });

  it('rejects unknown profile names', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'cloud'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --profile cloud. Expected zilliz, milvus, or none.');
  });
});
