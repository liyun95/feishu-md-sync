import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ExecResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runNode(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('root dist CLI deprecation', () => {
  it('installs a fail-fast shim for the stale root dist entrypoint', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'feishu-md-sync-root-dist-'));
    await mkdir(join(repoRoot, 'dist/cli'), { recursive: true });
    await writeFile(join(repoRoot, 'dist/cli/index.js'), 'old cli', { mode: 0o644 });
    const deprecationScript = fileURLToPath(new URL('../../../scripts/deprecate-root-dist-cli.mjs', import.meta.url));

    const install = await runNode([deprecationScript, repoRoot], process.cwd());

    expect(install.status).toBe(0);
    expect(install.stdout).toContain('Deprecated root dist CLI shim installed');

    const shim = await runNode([join(repoRoot, 'dist/cli/index.js'), '--help'], repoRoot);

    expect(shim.status).toBe(1);
    expect(shim.stderr).toContain('Deprecated md2feishu entrypoint.');
    expect(shim.stderr).toContain('/Users/liyun/feishu-md-sync/packages/cli/dist/cli/index.js');
    expect((await stat(join(repoRoot, 'dist/cli/index.js'))).mode & 0o777).toBe(0o755);
  });
});
