import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseFeishuTarget } from '../src/core/doc-id.js';
import { publishReceiptPath } from '../src/receipts/publish-receipt.js';

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
      '--strategy',
      'document-replace',
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
  }, 30_000);

  it('adopts and publishes mixed text plus HTML table changes through scoped block writes', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    await runLarkCli([
      'docs',
      '+update',
      '--doc',
      target,
      '--command',
      'overwrite',
      '--doc-format',
      'xml',
      '--content',
      '<p>Baseline paragraph.</p><table><thead><tr><th><p>Parameter</p></th><th><p>Description</p></th></tr></thead><tbody><tr><td><p><code>build_algo</code></p></td><td><p>Possible values:</p><ul><li><code>IVF_PQ</code>: Higher quality.</li><li><code>NN_DESCENT</code>: Faster.</li></ul></td></tr></tbody></table>',
      '--format',
      'json'
    ]);
    await rm(publishReceiptPath({ cwd, target: targetIdentity }), { force: true });

    const dir = await mkdtemp(join(tmpdir(), 'fms-live-table-'));
    const file = join(dir, 'doc.md');
    const baseline = `Baseline paragraph.\n\n${htmlTable(false)}`;
    await writeFile(file, baseline, 'utf8');

    const adopt = await runCli([
      'publish', file, '--target', target, '--profile', 'none', '--write', '--confirm-untracked-remote', '--format', 'json'
    ]);
    assertCliSuccess(adopt, 'adopt scoped table baseline');
    expect(adopt.stdout).toContain('"strategy": "no-op"');

    await writeFile(file, `Updated paragraph.\n\n${htmlTable(true)}`, 'utf8');
    const dryRun = await runCli(['publish', file, '--target', target, '--profile', 'none', '--format', 'json']);
    assertCliSuccess(dryRun, 'dry-run mixed scoped publish');
    expect(dryRun.stdout).toContain('"kind": "update"');
    expect(dryRun.stdout).toContain('"kind": "table-replace"');
    expect(dryRun.stdout).toContain('"key": "num_random_samplings"');

    const write = await runCli([
      'publish', file, '--target', target, '--profile', 'none', '--write', '--confirm-collaboration-risk', '--format', 'json'
    ]);
    assertCliSuccess(write, 'write mixed scoped publish');
    expect(write.stdout).toContain('"mode": "write"');

    const status = await runCli(['status', file, '--target', target, '--profile', 'none', '--format', 'json']);
    assertCliSuccess(status, 'status after mixed scoped publish');
    expect(status.stdout).toContain('"state": "clean"');
  }, 60_000);

  it.runIf(process.env.FEISHU_MD_SYNC_TEST_CREATE_PARENT)('creates a Zilliz draft under a test parent', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_CREATE_PARENT');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-create-'));
    const file = join(dir, 'doc.md');
    const title = `fms-live-create-${Date.now()}`;
    await writeFile(file, `# ${title}\n\nMilvus stores vectors.`, 'utf8');

    const dryRun = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--create',
      '--profile',
      'zilliz',
      '--format',
      'json'
    ]);

    assertCliSuccess(dryRun, 'dry-run create publish');
    expect(dryRun.stdout).toContain('"strategy": "create-document"');

    const write = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--create',
      '--profile',
      'zilliz',
      '--write',
      '--format',
      'json'
    ]);

    assertCliSuccess(write, 'write create publish');
    expect(write.stdout).toContain('"mode": "write"');
    expect(write.stdout).toContain('"documentId"');
  }, 30_000);
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

function runLarkCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const identity = process.env.FEISHU_MD_SYNC_LARK_AS;
    const fullArgs = identity === 'bot' || identity === 'user' ? [...args, '--as', identity] : args;
    execFile('lark-cli', fullArgs, { env: process.env, timeout: 25_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`lark-cli setup failed\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

function htmlTable(includeNewRow: boolean): string {
  return `<table>\n  <tr><th><p>Parameter</p></th><th><p>Description</p></th></tr>\n  <tr><td><p><code>build_algo</code></p></td><td><p>Possible values:</p><ul><li><code>IVF_PQ</code>: Higher quality.</li><li><code>NN_DESCENT</code>: Faster.</li></ul></td></tr>${includeNewRow ? '\n  <tr><td><p><code>num_random_samplings</code></p></td><td><p>Initial random seed iterations.</p></td></tr>' : ''}\n</table>`;
}
