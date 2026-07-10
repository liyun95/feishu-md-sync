import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseFeishuTarget } from '../src/core/doc-id.js';

const runLive = process.env.FEISHU_MD_SYNC_LIVE === '1';

describe.skipIf(!runLive)('live Feishu merge', () => {
  it('uses a live test doc as remote setup and merges fetched changes into a local file', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-merge-'));
    const file = join(dir, 'doc.md');

    await writeFile(file, '# lark-cli-test\n\nMilvus stores vector data.\n', 'utf8');

    const seed = await runCli([
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
      '--confirm-untracked-remote',
      '--format',
      'json'
    ]);
    assertCliSuccess(seed, 'seed publish');

    await writeFile(file, '# lark-cli-test\n\nMilvus stores vector data.\n\nLocal live merge line.\n', 'utf8');
    await overwriteRemoteMarkdown(target, '# lark-cli-test\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vector data.\n\nRemote live merge line.');

    const merge = await runCli([
      'merge',
      file,
      '--target',
      target,
      '--profile',
      'milvus',
      '--format',
      'json'
    ]);

    assertCliSuccess(merge, 'live merge');
    expect(merge.stdout).toContain('"state": "merged"');
    const merged = await readFile(file, 'utf8');
    expect(merged).toContain('Local live merge line.');
    expect(merged).toContain('Remote live merge line.');
  }, 30_000);
});

function overwriteRemoteMarkdown(target: string, markdown: string): Promise<void> {
  const doc = parseFeishuTarget(target).token;
  const args = [
    'docs',
    '+update',
    '--doc',
    doc,
    '--command',
    'overwrite',
    '--doc-format',
    'markdown',
    '--content',
    markdown,
    '--format',
    'json'
  ];
  const identity = process.env.FEISHU_MD_SYNC_LARK_AS;
  if (identity === 'bot' || identity === 'user') args.push('--as', identity);

  return new Promise((resolve, reject) => {
    execFile('lark-cli', args, { encoding: 'utf8', timeout: 25_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`remote setup failed\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

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
      env: process.env,
      timeout: 25_000
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}
