import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAuthDoctorReport, loadCliEnv } from '../src/cli/env.js';

const tempDirs: string[] = [];

describe('CLI env loading', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('loads .env from the workspace root when invoked from another current directory', async () => {
    const repo = await repoFixture();
    const otherCwd = join(repo, 'scratch');
    await mkdir(otherCwd, { recursive: true });
    await writeFile(join(repo, '.env'), [
      'APP_ID=repo_app',
      'APP_SECRET=repo_secret',
      'FEISHU_HOST=https://repo.feishu.test'
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = {};

    const report = loadCliEnv({
      argv: ['node', 'index.js'],
      cwd: otherCwd,
      env,
      moduleUrl: pathToFileURL(join(repo, 'packages/cli/src/cli/index.ts')).href
    });

    expect(env.APP_ID).toBe('repo_app');
    expect(env.APP_SECRET).toBe('repo_secret');
    expect(env.FEISHU_HOST).toBe('https://repo.feishu.test');
    expect(report.loadedFiles).toContain(join(repo, '.env'));
  });

  it('lets --env-file override discovered dotenv files and reports auth without secrets', async () => {
    const repo = await repoFixture();
    await writeFile(join(repo, '.env'), [
      'APP_ID=repo_app',
      'APP_SECRET=repo_secret'
    ].join('\n'), 'utf8');
    const explicitEnv = join(repo, 'custom.env');
    await writeFile(explicitEnv, [
      'APP_ID=explicit_app',
      'APP_SECRET=explicit_secret'
    ].join('\n'), 'utf8');
    const env: NodeJS.ProcessEnv = {};

    const envReport = loadCliEnv({
      argv: ['node', 'index.js', '--env-file', explicitEnv],
      cwd: repo,
      env,
      moduleUrl: pathToFileURL(join(repo, 'packages/cli/dist/cli/index.js')).href
    });
    const authReport = buildAuthDoctorReport(envReport, env);

    expect(env.APP_ID).toBe('explicit_app');
    expect(env.APP_SECRET).toBe('explicit_secret');
    expect(envReport.explicitEnvFile).toBe(explicitEnv);
    expect(authReport.appId.present).toBe(true);
    expect(authReport.appSecret.present).toBe(true);
    expect(JSON.stringify(authReport)).not.toContain('explicit_secret');
  });
});

async function repoFixture(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'feishu-cli-env-'));
  tempDirs.push(repo);
  await mkdir(join(repo, 'packages/cli/src/cli'), { recursive: true });
  await mkdir(join(repo, 'packages/cli/dist/cli'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'repo',
    workspaces: ['packages/cli']
  }), 'utf8');
  await writeFile(join(repo, 'packages/cli/package.json'), JSON.stringify({
    name: 'feishu-md-sync'
  }), 'utf8');
  return repo;
}
