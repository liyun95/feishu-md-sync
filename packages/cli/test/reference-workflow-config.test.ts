import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadReferenceReleaseWorkflowConfig } from '../src/reference/workflow-config.js';

describe('reference release workflow config', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('loads a minimal workflow config with explicit external repositories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-workflow-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      impactMatrix: 'impact.json',
      manifest: 'reference-manifest.json',
      reportsDir: 'reports',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        doc: 'describeCollection()'
      },
      pr: {
        base: 'master',
        branch: 'docs/java-v2.6.19-reference'
      }
    }, null, 2)}\n`, 'utf8');

    const config = await loadReferenceReleaseWorkflowConfig(configPath);

    expect(config.sdk).toBe('java');
    expect(config.webContent.repo).toBe('/Users/liyun/web-content');
    expect(config.webContent.manual).toBe('java-v2.6.x');
    expect(config.pr?.branch).toBe('docs/java-v2.6.19-reference');
  });

  it('rejects configs that try to treat web-content as a package workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-workflow-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      manifest: 'reference-manifest.json',
      webContent: {
        repo: 'packages/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        all: true
      }
    }, null, 2)}\n`, 'utf8');

    await expect(loadReferenceReleaseWorkflowConfig(configPath)).rejects.toThrow(/external repository/);
  });
});
