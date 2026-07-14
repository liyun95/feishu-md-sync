import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('rejects unknown publish strategies before doing IO', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--strategy',
      'merge'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --strategy merge. Expected auto, block-patch, or document-replace.');
  });

  it('documents block-patch confirmation flags in publish help', async () => {
    const result = await runCli(['publish', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('auto | block-patch |');
    expect(result.stdout).toContain('document-replace');
    expect(result.stdout).toContain('--confirm-collaboration-risk');
    expect(result.stdout).toContain('--confirm-untracked-remote');
  });

  it('documents Whiteboard opt-in and asset-specific overwrite confirmation', async () => {
    const result = await runCli(['publish', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--sync-whiteboards');
    expect(result.stdout).toContain('--confirm-remote-whiteboard-overwrite <asset-key>');
  });

  it('rejects Whiteboard sync with create mode before doing IO', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'https://example.feishu.cn/drive/folder/fldcn8qL4qcQk4wabc123456789',
      '--create',
      '--sync-whiteboards'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--sync-whiteboards is not supported with --create');
  });

  it('rejects Whiteboard sync with document replacement before doing IO', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--strategy',
      'document-replace',
      '--sync-whiteboards'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--sync-whiteboards is not supported with --strategy document-replace');
  });

  it('dry-runs new document creation for a Drive folder URL without lark-cli IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-publish-cli-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, '# New Doc\n\nMilvus stores vectors.', 'utf8');

    const result = await runCli([
      'publish',
      file,
      '--target',
      'https://example.feishu.cn/drive/folder/fldcn8qL4qcQk4wabc123456789',
      '--profile',
      'zilliz',
      '--format',
      'json'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"strategy": "create-document"');
    expect(result.stdout).toContain('"kind": "folder"');
  });

  it('dry-runs new document creation for a Wiki parent URL only with --create', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-publish-cli-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, '# New Wiki Child\n\nMilvus stores vectors.', 'utf8');

    const result = await runCli([
      'publish',
      file,
      '--target',
      'https://example.feishu.cn/wiki/Kz5rwMmxCixx78kWWnnc5teanzd',
      '--create',
      '--profile',
      'zilliz',
      '--format',
      'json'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"strategy": "create-document"');
    expect(result.stdout).toContain('"kind": "wiki"');
  });
});
