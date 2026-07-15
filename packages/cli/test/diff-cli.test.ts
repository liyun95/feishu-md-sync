import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, FEISHU_MD_SYNC_LARK_AS: '', ...env }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('diff CLI', () => {
  it('documents the new-core target mode only', async () => {
    const result = await runCli(['diff', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target <url-or-token>');
    expect(result.stdout).toContain('--profile <profile>');
    expect(result.stdout).toContain('--sync-whiteboards');
    expect(result.stdout).not.toContain('legacy Feishu docx ID or URL');
  });

  it('rejects diff without --target before lark-cli IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-cli-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const result = await runCli(['diff', file]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("required option '--target <url-or-token>' not specified");
  });

  it('diffs remote current to publish draft through lark-cli markdown fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-diff-cli-'));
    const binDir = join(dir, 'bin');
    await mkdir(binDir);
    const larkCli = join(binDir, 'lark-cli');
    await createFakeLarkCli(larkCli);
    const file = join(dir, 'doc.md');
    await writeFile(file, 'New local sentence.', 'utf8');

    const result = await runCli([
      'diff',
      file,
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'none',
      '--format',
      'json'
    ], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"mode": "read-only"');
    expect(result.stdout).toContain('"hasDiff": true');
    expect(result.stdout).toContain('--- remote-current');
    expect(result.stdout).toContain('+++ publish-draft');
    expect(result.stdout).toContain('-Old remote sentence.');
    expect(result.stdout).toContain('+New local sentence.');
  });
});

async function createFakeLarkCli(path: string): Promise<void> {
  await writeFile(path, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({',
    '  ok: true,',
    '  data: {',
    '    document: {',
    '      content: "Old remote sentence.",',
    '      document_id: "doccn123456789012345678901234",',
    '      revision_id: 9',
    '    }',
    '  }',
    '}));'
  ].join('\n'), 'utf8');
  await chmod(path, 0o755);
}
