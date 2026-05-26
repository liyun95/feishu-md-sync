import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caseConflictingPaths,
  classifyGitStatus,
  collectReferenceExportDocTitles,
  exportReferenceToWebContent,
  loadWebContentManualConfig,
  parseGitStatus,
  type CommandRunner
} from '../src/reference/export.js';
import type { ReferenceManifest } from '../src/reference/manifest.js';

describe('reference web-content export', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('loads web-content manual config and rejects missing fields', async () => {
    const dir = await tempDir();
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, `${JSON.stringify({
      milvus: {
        manuals: {
          'java-v3.0.x': {
            base: 'base:tbl',
            targets: { outputDir: 'API_Reference/milvus-sdk-java/v3.0.x/v2' }
          },
          broken: {
            base: 'base:tbl',
            targets: {}
          }
        }
      }
    }, null, 2)}\n`, 'utf8');

    await expect(loadWebContentManualConfig(configPath, 'java-v3.0.x')).resolves.toEqual({
      base: 'base:tbl',
      outputDir: 'API_Reference/milvus-sdk-java/v3.0.x/v2'
    });
    await expect(loadWebContentManualConfig(configPath, 'missing')).rejects.toThrow(/was not found/);
    await expect(loadWebContentManualConfig(configPath, 'broken')).rejects.toThrow(/targets\.outputDir/);
  });

  it('collects changed doc titles from manifest doc actions', () => {
    const manifest: ReferenceManifest = {
      kind: 'sdk-reference-publish-manifest',
      sdk: 'java',
      actions: [
        {
          id: 'create-a',
          action: 'createDoc',
          title: 'createCollection()'
        },
        {
          id: 'update-b',
          action: 'patchDoc',
          markdownFile: 'update.md',
          tracker: { fields: { '文档/接口': 'addCollectionField()' } }
        },
        {
          id: 'copy-c',
          action: 'copyDoc',
          title: 'describeCollection()',
          then: [{ action: 'patchDoc', markdownFile: 'copy.md' }]
        },
        {
          id: 'deprecate-d',
          action: 'updateRecord',
          fields: { Progress: 'Deprecated' }
        }
      ]
    };

    expect(collectReferenceExportDocTitles(manifest)).toEqual([
      'createCollection()',
      'addCollectionField()',
      'describeCollection()'
    ]);
  });

  it('classifies git status into related output files and unrelated dirty files', () => {
    const entries = parseGitStatus([
      ' M API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md',
      '?? API_Reference/milvus-sdk-java/v3.0.x/v2/Volume/index.md',
      ' D API_Reference/milvus-sdk-java/v2.6.x/v2/DataImport/BulkImport/bulkImport.md',
      ' M scripts/config.json'
    ].join('\n'));

    expect(classifyGitStatus(
      entries,
      'API_Reference/milvus-sdk-java/v3.0.x/v2',
      new Set(['API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md'])
    )).toEqual({
      changedFiles: ['API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md'],
      untrackedFiles: [],
      unrelatedDirtyFiles: [
        'API_Reference/milvus-sdk-java/v2.6.x/v2/DataImport/BulkImport/bulkImport.md',
        'API_Reference/milvus-sdk-java/v3.0.x/v2/Volume/index.md',
        'scripts/config.json'
      ],
      suggestedStagingFiles: ['API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md']
    });
  });

  it('detects case-conflicting tracked paths before export on case-insensitive filesystems', async () => {
    const { repo, manifestPath } = await writeExportFixture();
    const runner: CommandRunner = async (file, args) => {
      if (file === 'git' && args.join(' ') === 'ls-files') {
        return { stdout: 'API_Reference/CreateSchema.md\nAPI_Reference/createSchema.md\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };

    expect(caseConflictingPaths(['a/CreateSchema.md', 'a/createSchema.md'])).toEqual([
      'a/CreateSchema.md',
      'a/createSchema.md'
    ]);
    await expect(exportReferenceToWebContent({
      manifestPath,
      webContentRepo: repo,
      manual: 'java-v3.0.x',
      configPath: 'scripts/config.json',
      caseSensitive: false,
      runCommand: runner
    })).rejects.toThrow(/case-insensitive filesystem/);
  });

  it('runs changed-scope export commands and writes a handoff report', async () => {
    const { repo, manifestPath } = await writeExportFixture();
    const outPath = join(repo, 'runs/reference/java-v3.0.x/web-content-export.json');
    const calls: string[] = [];
    const runner: CommandRunner = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'node') {
        return {
          stdout: `Written: ${repo}/API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md\n`,
          stderr: ''
        };
      }
      if (file === 'git' && args.join(' ') === 'diff --check') return { stdout: '', stderr: '' };
      if (file === 'git' && args.join(' ') === 'status --porcelain') {
        return {
          stdout: [
            ' M API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md',
            '?? API_Reference/milvus-sdk-java/v3.0.x/v2/Volume/index.md',
            ' M README.md'
          ].join('\n'),
          stderr: ''
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };

    const report = await exportReferenceToWebContent({
      manifestPath,
      webContentRepo: repo,
      manual: 'java-v3.0.x',
      configPath: 'scripts/config.json',
      outPath,
      caseSensitive: true,
      runCommand: runner
    });

    expect(calls[0]).toContain('--doc addCollectionField() --skipImageDown');
    expect(report.docTitles).toEqual(['addCollectionField()']);
    expect(report.changedFiles).toEqual([
      'API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md'
    ]);
    expect(report.untrackedFiles).toEqual([]);
    expect(report.unrelatedDirtyFiles).toEqual([
      'API_Reference/milvus-sdk-java/v3.0.x/v2/Volume/index.md',
      'README.md'
    ]);
    expect(report.suggestedStagingFiles).toEqual([
      'API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md'
    ]);
  });

  it('uses one all-scope command for full manual rebuilds', async () => {
    const { repo, manifestPath } = await writeExportFixture();
    const runner: CommandRunner = async (file, args) => {
      if (file === 'node') return { stdout: '', stderr: '' };
      if (file === 'git' && args.join(' ') === 'diff --check') return { stdout: '', stderr: '' };
      if (file === 'git' && args.join(' ') === 'status --porcelain') return { stdout: '', stderr: '' };
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };

    const report = await exportReferenceToWebContent({
      manifestPath,
      webContentRepo: repo,
      manual: 'java-v3.0.x',
      configPath: 'scripts/config.json',
      scope: 'all',
      caseSensitive: true,
      runCommand: runner
    });

    expect(report.commands).toHaveLength(1);
    expect(report.commands[0].args).toContain('--all');
    expect(report.docTitles).toEqual([]);
  });

  async function writeExportFixture(): Promise<{ repo: string; manifestPath: string }> {
    const repo = await tempDir();
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await writeFile(join(repo, 'scripts/config.json'), `${JSON.stringify({
      milvus: {
        manuals: {
          'java-v3.0.x': {
            base: 'AOFDbSmwma9XrNsLa8KcQgt9ngc:tbl63oNrbGDCXorc',
            targets: { outputDir: 'API_Reference/milvus-sdk-java/v3.0.x/v2' }
          }
        }
      }
    }, null, 2)}\n`, 'utf8');
    await mkdir(join(repo, 'reference/java'), { recursive: true });
    await writeFile(join(repo, 'reference/java/addCollectionField.md'), '# addCollectionField\n', 'utf8');
    const manifestPath = join(repo, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      kind: 'sdk-reference-publish-manifest',
      sdk: 'java',
      targets: { releaseAuditBaseToken: 'audit-base' },
      actions: [{
        id: 'update-add-collection-field',
        action: 'patchDoc',
        documentId: 'doc',
        markdownFile: 'reference/java/addCollectionField.md',
        tracker: { fields: { '文档/接口': 'addCollectionField()' } }
      }]
    }, null, 2)}\n`, 'utf8');
    return { repo, manifestPath };
  }

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-export-'));
    tempDirs.push(dir);
    return dir;
  }
});
