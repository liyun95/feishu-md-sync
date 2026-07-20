import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

const visibleCommands = ['publish', 'status', 'pull', 'diff', 'merge', 'baseline', 'doctor'];
const retiredCommands = ['sync', 'push', 'publish-new', 'workflow', 'harness', 'multisdk', 'reference', 'release', 'code-blocks', 'review-draft'];

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

describe('CLI help surface', () => {
  it('exposes only the new-core command surface', async () => {
    const result = await runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: feishu-md-sync');
    for (const command of visibleCommands) {
      expect(result.stdout).toMatch(new RegExp(`\\n  ${command}(?:\\s|$)`));
    }
    for (const command of retiredCommands) {
      expect(result.stdout).not.toMatch(new RegExp(`\\n  ${command}(?:\\s|$)`));
    }
  });

  it.each(retiredCommands)('does not register retired command %s', async (command) => {
    const result = await runCli([command]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`unknown command '${command}'`);
  });

  it.each(retiredCommands)('does not show top-level help for retired command %s --help', async (command) => {
    const result = await runCli([command, '--help']);

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('Usage: feishu-md-sync');
    expect(result.stderr).toContain(`unknown command '${command}'`);
  });

  it.each(['status', 'diff', 'publish', 'merge'])('documents source dialects for %s', async (command) => {
    const result = await runCli([command, '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--dialect <dialect>');
    expect(result.stdout.replace(/\s+/g, ' ')).toContain(
      'gfm | zdoc-authoring | milvus-authoring'
    );
  });

  it('does not add source dialects to pull', async () => {
    const result = await runCli(['pull', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('--dialect <dialect>');
  });

  it('documents the explicit local-only baseline adoption workflow', async () => {
    const result = await runCli(['baseline', 'adopt', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: feishu-md-sync baseline adopt');
    expect(result.stdout).toContain('--local-baseline <file>');
    expect(result.stdout).toContain('--git-ref <ref>');
    expect(result.stdout).toContain('--apply');
    expect(result.stdout).toContain('--confirm-baseline-adoption <fingerprint>');
    expect(result.stdout).not.toContain('--write');
    expect(result.stdout).not.toContain('--confirm-destructive');
  });

});
