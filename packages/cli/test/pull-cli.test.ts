import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

describe('pull CLI', () => {
  it('documents the new-core target/profile options', async () => {
    const result = await runCli(['pull', '--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--target <url-or-token>');
    expect(result.stdout).toContain('--profile <profile>');
    expect(result.stdout).toContain('--write-receipt');
  });

  it('requires output for new-core target mode before lark-cli IO', async () => {
    const result = await runCli([
      'pull',
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'milvus'
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("required option '-o, --output <file>' not specified");
  });

  it('pulls through lark-cli and writes a profile-transformed snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-pull-cli-'));
    const binDir = join(dir, 'bin');
    await mkdir(binDir);
    const output = join(dir, 'doc.remote.md');
    const larkCli = join(binDir, 'lark-cli');
    await createFakeLarkCli(larkCli);

    const result = await runCli([
      'pull',
      '--target',
      'doccn123456789012345678901234',
      '--output',
      output,
      '--profile',
      'zilliz',
      '--write-receipt',
      '--format',
      'json'
    ], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"mode": "write"');
    expect(result.stdout).toContain('"profile": "zilliz"');
    expect(result.stdout).toContain('"receiptPath"');
    await expect(readFile(output, 'utf8')).resolves.toBe('# Remote\n\nZilliz Cloud stores vectors.');
  });
});

async function createFakeLarkCli(path: string): Promise<void> {
  await writeFile(path, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args[0] === "api") {',
    '  console.log(JSON.stringify({',
    '    ok: true,',
    '    data: {',
    '      items: [{ block_id: "doccn123456789012345678901234", block_type: 1, children: [] }],',
    '      has_more: false',
    '    }',
    '  }));',
    '  process.exit(0);',
    '}',
    'console.log(JSON.stringify({',
    '  ok: true,',
    '  data: {',
    '    document: {',
    '      content: "# Remote\\n\\n<include target=\\"milvus\\">Milvus</include><include target=\\"zilliz\\">Zilliz Cloud</include> stores vectors.",',
    '      document_id: "doccn123456789012345678901234",',
    '      revision_id: 7',
    '    }',
    '  }',
    '}));'
  ].join('\n'), 'utf8');
  await chmod(path, 0o755);
}
