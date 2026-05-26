import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReferenceReleaseWorkflow } from '../src/reference/release-run.js';

describe('reference release run', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('runs dry-run phases and writes a durable report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-release-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'reports'), { recursive: true });
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      manifest: 'reference-manifest.json',
      reportsDir: 'reports',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'check'
      },
      pr: {
        base: 'master',
        branch: 'docs/java-v2.6.19-reference',
        title: 'Update Java SDK reference for v2.6.19'
      }
    }, null, 2)}\n`, 'utf8');

    const report = await runReferenceReleaseWorkflow({
      configPath,
      writeFeishu: false,
      pullWebContent: false,
      createPr: false,
      applyManifest: vi.fn().mockResolvedValue({ failed: [], mode: 'dry-run' }),
      auditManifest: vi.fn().mockResolvedValue({ passed: true }),
      runWebContent: vi.fn().mockResolvedValue({
        command: 'node scripts/lark-docs/index.js --dry-run',
        cwd: '/Users/liyun/web-content',
        exitCode: 0,
        stdout: 'No stale links found.\n',
        stderr: ''
      })
    });

    expect(report.phases.map((phase) => phase.name)).toEqual([
      'feishu-apply',
      'feishu-audit',
      'web-content-check',
      'pr-prepare'
    ]);
    expect(report.passed).toBe(true);

    const saved = JSON.parse(await readFile(join(dir, 'reports/reference-release-report.json'), 'utf8')) as {
      sdk?: string;
      passed?: boolean;
    };
    expect(saved.sdk).toBe('java');
    expect(saved.passed).toBe(true);
    expect(report.phases.at(-1)?.summary).toContain("--title 'Update Java SDK reference for v2.6.19'");
  });

  it('executes the PR command only when createPr is enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-release-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      manifest: 'reference-manifest.json',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        all: true
      },
      pr: {
        base: 'master',
        branch: 'docs/java-reference',
        title: 'Update Java SDK reference'
      }
    }, null, 2)}\n`, 'utf8');
    const runPr = vi.fn().mockResolvedValue({
      command: 'gh pr create --base master --head docs/java-reference',
      cwd: '/Users/liyun/web-content',
      exitCode: 0,
      stdout: 'https://github.com/milvus-io/web-content/pull/1\n',
      stderr: ''
    });

    const report = await runReferenceReleaseWorkflow({
      configPath,
      writeFeishu: true,
      pullWebContent: true,
      createPr: true,
      applyManifest: vi.fn().mockResolvedValue({ failed: [], mode: 'write' }),
      auditManifest: vi.fn().mockResolvedValue({ passed: true }),
      runWebContent: vi.fn().mockResolvedValue({
        command: 'node scripts/lark-docs/index.js --all',
        cwd: '/Users/liyun/web-content',
        exitCode: 0,
        stdout: 'Written: API_Reference/milvus-sdk-java/v2.6.x/v2/About.md\n',
        stderr: ''
      }),
      runPr
    });

    expect(runPr).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'master', branch: 'docs/java-reference' }),
      '/Users/liyun/web-content'
    );
    expect(report.phases.at(-1)).toEqual(expect.objectContaining({
      name: 'pr-prepare',
      passed: true,
      summary: 'https://github.com/milvus-io/web-content/pull/1'
    }));
  });

  it('does not create a PR when an earlier phase fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-release-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      manifest: 'reference-manifest.json',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        all: true
      },
      pr: {
        base: 'master',
        branch: 'docs/java-reference'
      }
    }, null, 2)}\n`, 'utf8');
    const runPr = vi.fn();

    const report = await runReferenceReleaseWorkflow({
      configPath,
      writeFeishu: true,
      pullWebContent: true,
      createPr: true,
      applyManifest: vi.fn().mockResolvedValue({ failed: [], mode: 'write' }),
      auditManifest: vi.fn().mockResolvedValue({ passed: false }),
      runWebContent: vi.fn().mockResolvedValue({
        command: 'node scripts/lark-docs/index.js --all',
        cwd: '/Users/liyun/web-content',
        exitCode: 0,
        stdout: 'Written: API_Reference/milvus-sdk-java/v2.6.x/v2/About.md\n',
        stderr: ''
      }),
      runPr
    });

    expect(runPr).not.toHaveBeenCalled();
    expect(report.passed).toBe(false);
    expect(report.phases.at(-1)).toEqual(expect.objectContaining({
      name: 'pr-prepare',
      passed: false,
      summary: 'Skipped PR creation because an earlier workflow phase failed.'
    }));
  });
});
