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
      env: { ...process.env, FEISHU_MD_SYNC_LARK_AS: '' }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('CLI error contract', () => {
  it('prints Commander validation failures as JSON on stderr', async () => {
    const result = await runCli(['status', 'README.md', '--format', 'json']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        type: 'validation',
        subtype: 'invalid_argument',
        retryable: false
      }
    });
  });

  it('returns a typed confirmation requirement for destructive writes', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--write',
      '--strategy',
      'document-replace',
      '--format',
      'json'
    ]);

    expect(result.status).toBe(10);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: {
        type: 'confirmation_required',
        subtype: 'destructive_write',
        requiredFlags: ['--confirm-destructive'],
        retryable: false
      }
    });
  });

  it('keeps pretty errors human-readable and singular', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--strategy',
      'merge'
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid --strategy merge. Expected auto, block-patch, or document-replace.');
    expect(result.stderr).not.toContain('"ok"');
    expect(result.stderr.match(/Invalid --strategy/g)).toHaveLength(1);
  });

  it('rejects unsupported output formats before command execution', async () => {
    const result = await runCli(['doctor', 'auth', '--format', 'yaml']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid --format yaml. Expected pretty or json.');
  });
});
