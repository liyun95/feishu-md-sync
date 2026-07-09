import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const runLive = process.env.FEISHU_MD_SYNC_LIVE === '1';

describe.skipIf(!runLive)('live Feishu publish', () => {
  it('publishes a Zilliz draft to an existing test doc with guarded document replace', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const dryRun = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--format',
      'json'
    ]);

    assertCliSuccess(dryRun, 'dry-run publish');
    expect(dryRun.stdout).toContain('"strategy": "document-replace"');

    const write = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--write',
      '--strategy',
      'document-replace',
      '--confirm-destructive',
      '--format',
      'json'
    ]);

    assertCliSuccess(write, 'guarded write publish');
    expect(write.stdout).toContain('"mode": "write"');
  });
});

function assertCliSuccess(result: { stdout: string; stderr: string; status: number | null }, label: string): void {
  if (result.status === 0) return;
  throw new Error(`${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live Feishu tests.`);
  return value;
}

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: process.env
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}
