import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHarnessEnvironmentReport,
  writeHarnessEnvironment
} from '../src/harness/environment.js';

const tempDirs: string[] = [];

describe('harness environment report', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('reports runtime, package, auth presence, env files, validation profiles, and path checks without secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-env-'));
    tempDirs.push(dir);
    const repo = join(dir, 'milvus-docs');
    await mkdir(repo, { recursive: true });

    const report = await buildHarnessEnvironmentReport({
      envLoadReport: {
        cwd: dir,
        explicitEnvFile: join(dir, 'custom.env'),
        attemptedFiles: [join(dir, 'custom.env'), join(dir, '.env')],
        loadedFiles: [join(dir, 'custom.env')]
      },
      env: {
        APP_ID: 'cli_1234567890',
        APP_SECRET: 'super-secret',
        FEISHU_HOST: 'https://open.feishu.cn',
        npm_config_user_agent: 'npm/10.8.2 node/v20.19.0 darwin arm64'
      },
      cwd: dir,
      now: () => '2026-05-26T00:00:00.000Z',
      nodeVersion: 'v20.19.0',
      packageInfo: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      },
      pathChecks: [
        { name: 'milvusDocs', path: repo },
        { name: 'missingRepo', path: join(dir, 'missing') }
      ]
    });

    expect(report).toEqual(expect.objectContaining({
      kind: 'feishu-harness-environment',
      version: 1,
      generatedAt: '2026-05-26T00:00:00.000Z',
      node: 'v20.19.0',
      npm: '10.8.2',
      cwd: dir,
      cli: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      },
      feishu: {
        host: 'https://open.feishu.cn',
        appIdPresent: true,
        appSecretPresent: true
      }
    }));
    expect(report.envFiles).toEqual([
      { path: join(dir, 'custom.env'), loaded: true, explicit: true },
      { path: join(dir, '.env'), loaded: false, explicit: false }
    ]);
    expect(report.validationProfiles.map((profile) => profile.id)).toContain('manta-k8s-maven');
    expect(report.pathChecks).toEqual([
      { name: 'milvusDocs', path: repo, exists: true, type: 'directory' },
      { name: 'missingRepo', path: join(dir, 'missing'), exists: false, type: 'missing' }
    ]);
    expect(JSON.stringify(report)).not.toContain('super-secret');
  });

  it('writes environment.json into a task directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-env-write-'));
    tempDirs.push(dir);
    const report = await buildHarnessEnvironmentReport({
      envLoadReport: {
        cwd: dir,
        attemptedFiles: [],
        loadedFiles: []
      },
      env: {},
      cwd: dir,
      now: () => '2026-05-26T00:00:00.000Z',
      nodeVersion: 'v20.19.0',
      packageInfo: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      }
    });

    await writeHarnessEnvironment(dir, report);

    const saved = JSON.parse(await readFile(join(dir, 'environment.json'), 'utf8'));
    expect(saved.kind).toBe('feishu-harness-environment');
    expect(saved.feishu.appSecretPresent).toBe(false);
  });
});
