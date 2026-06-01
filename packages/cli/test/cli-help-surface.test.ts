import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile('npx', ['tsx', 'src/cli/index.ts', ...args], {
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

describe('CLI help surface', () => {
  it('keeps top-level workflow commands discoverable', async () => {
    const { stdout } = await runCli(['--help']);

    for (const command of ['sync', 'status', 'pull', 'diff', 'merge', 'code-blocks', 'multisdk', 'reference', 'release', 'harness', 'workflow']) {
      expect(stdout).toContain(command);
    }
  });

  it('honors sync subcommand options before doing IO', async () => {
    const result = await runCli([
      'sync',
      '--markdown-engine',
      'invalid',
      'missing.md',
      'doccn123456789012345678901234'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --markdown-engine invalid');
  });

  it('lists scoped section sync options', async () => {
    const result = await runCli(['sync', '--help']);

    expect(result.stdout).toContain('--insert-section <heading>');
    expect(result.stdout).toContain('--before-section <heading>');
    expect(result.stdout).toContain('--after-section <heading>');
    expect(result.stdout).toContain('--before-heading <heading>');
  });

  it('rejects insert-section without a relative target', async () => {
    const result = await runCli(['sync', 'doc.md', 'doc1234567890123', '--insert-section', 'New']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--insert-section requires --before-section or --after-section.');
  });

  it('rejects before-section without insert-section', async () => {
    const result = await runCli(['sync', 'doc.md', 'doc1234567890123', '--before-section', 'Existing']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--before-section and --after-section require --insert-section.');
  });

  it('rejects multiple scoped sync modes', async () => {
    const result = await runCli([
      'sync',
      'doc.md',
      'doc1234567890123',
      '--section',
      'Existing',
      '--before-heading',
      'How it works'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Scoped sync options are mutually exclusive: --section, --before-heading.');
  });
});
