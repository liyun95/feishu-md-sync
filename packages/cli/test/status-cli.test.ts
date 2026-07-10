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

describe('status CLI', () => {
  it('documents the new-core target mode only', async () => {
    const result = await runCli(['status', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target <url-or-token>');
    expect(result.stdout).toContain('--profile <profile>');
    expect(result.stdout).not.toContain('legacy Feishu docx ID or URL');
  });

  it('rejects status without --target before lark-cli IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-cli-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const result = await runCli(['status', file]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required option '--target <url-or-token>' not specified");
  });

  it('checks new-core publish status through lark-cli markdown fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-status-cli-'));
    const binDir = join(dir, 'bin');
    await mkdir(binDir);
    const larkCli = join(binDir, 'lark-cli');
    await createFakeLarkCli(larkCli);
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vector data.', 'utf8');

    const result = await runCli([
      'status',
      file,
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'zilliz',
      '--format',
      'json'
    ], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"state": "untracked"');
    expect(result.stdout).toContain('"contentMatchesRemote": true');
    expect(result.stdout).toContain('"action": "publish-dry-run"');
  });
});

async function createFakeLarkCli(path: string): Promise<void> {
  await writeFile(path, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({',
    '  ok: true,',
    '  data: {',
    '    document: {',
    '      content: "<include target=\\"milvus\\">Milvus</include><include target=\\"zilliz\\">Zilliz Cloud</include> stores vector data.\\n",',
    '      document_id: "doccn123456789012345678901234",',
    '      revision_id: 9',
    '    }',
    '  }',
    '}));'
  ].join('\n'), 'utf8');
  await chmod(path, 0o755);
}
