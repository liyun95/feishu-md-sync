import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('harness CLI commands', () => {
  it('documents the push command and hides the old section option', async () => {
    const result = await runCli(['sync', '--help']);

    expect(result.stdout).not.toContain('--section <heading>');

    const pushHelp = await runCli(['push', '--help']);
    expect(pushHelp.stdout).toContain('--scope <scope>');
    expect(pushHelp.stdout).toContain('--replace-all');
  });

  it('prints the multisdk tools registry as JSON', async () => {
    const result = await runCli(['harness', 'tools', '--workflow', 'multisdk', '--format', 'json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.kind).toBe('feishu-harness-tools');
    expect(parsed.workflow).toBe('multisdk');
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain('multisdk apply-local');
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain('push');
  });

  it('tells agents to ask the user when multisdk init has no language', async () => {
    const result = await runCliFailure(['multisdk', 'init', 'doc-token', '--out', '/tmp/multisdk-no-language']);

    expect(result.stderr).toContain('Ask the user which target SDK language to complete');
  });

  it('prints the SDK reference release tools registry as JSON', async () => {
    const result = await runCli(['harness', 'tools', '--workflow', 'sdk-reference-web-content-release', '--format', 'json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.workflow).toBe('sdk-reference-web-content-release');
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain('reference export');
  });

  it('prints the environment report without secrets', async () => {
    const result = await runCli(['harness', 'env', '--format', 'json'], {
      APP_ID: 'cli_test_app',
      APP_SECRET: 'cli_test_secret'
    });
    const parsed = JSON.parse(result.stdout);

    expect(parsed.kind).toBe('feishu-harness-environment');
    expect(parsed.feishu.appIdPresent).toBe(true);
    expect(parsed.feishu.appSecretPresent).toBe(true);
    expect(result.stdout).not.toContain('cli_test_secret');
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runCliFailure(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    await runCli(args);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
  throw new Error('Expected CLI command to fail.');
}
