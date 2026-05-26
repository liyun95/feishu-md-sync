import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { planReleaseApply, writeReleaseApply } from '../src/release/apply.js';
import { approveReleaseTask, createInitialReleaseTask, hashReleaseReport } from '../src/release/task.js';

describe('release apply gate', () => {
  it('dry-runs release notes and variables changes without writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-apply-'));
    try {
      await mkdir(join(dir, 'site/en'), { recursive: true });
      await writeFile(join(dir, 'site/en/release_notes.md'), '# Release Notes\n\n## v2.6.16\n\nOld\n', 'utf8');
      await writeFile(join(dir, 'site/en/Variables.json'), '{\n  "milvus_sdk_java_version": "2.6.16"\n}\n', 'utf8');

      const plan = await planReleaseApply({
        milvusDocsPath: dir,
        releaseNotesSection: '## v2.6.17\n\n- Added ARRAY_REMOVE support.\n',
        variableChanges: [{ variable: 'milvus_sdk_java_version', expectedValue: '2.6.17' }]
      });

      expect(plan.files.map((file) => file.path)).toEqual(['site/en/release_notes.md', 'site/en/Variables.json']);
      expect(await readFile(join(dir, 'site/en/Variables.json'), 'utf8')).toContain('2.6.16');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves local release metadata and linked bullets when merging an existing section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-replace-'));
    try {
      await mkdir(join(dir, 'site/en'), { recursive: true });
      await writeFile(
        join(dir, 'site/en/release_notes.md'),
        [
          '# Release Notes',
          '',
          '## v2.6.17',
          '',
          'Release date: May 22, 2026',
          '',
          '| Milvus Version | Java SDK Version |',
          '| -------------- | ---------------- |',
          '| 2.6.17         | 2.6.20           |',
          '',
          'Local intro.',
          '',
          '### Improvements',
          '',
          '- Added [`ARRAY_APPEND` and `ARRAY_REMOVE` partial update operators](upsert-entities.md#Upsert-ARRAY-fields-with-partial-update-operators) for Array fields ([#49328](https://github.com/milvus-io/milvus/pull/49328), [#49724](https://github.com/milvus-io/milvus/pull/49724))',
          '',
          '### Bug fixes',
          '',
          '- Existing bug fix ([#49703](https://github.com/milvus-io/milvus/pull/49703))',
          '',
          '## v2.6.16',
          '',
          'Old'
        ].join('\n'),
        'utf8'
      );
      await writeFile(join(dir, 'site/en/Variables.json'), '{\n  "milvus_sdk_java_version": "2.6.16"\n}\n', 'utf8');

      const plan = await planReleaseApply({
        milvusDocsPath: dir,
        releaseNotesSection: [
          '## v2.6.17',
          '',
          'Remote intro.',
          '',
          '## Improvements',
          '',
          '- Added ARRAY_APPEND and ARRAY_REMOVE partial update operators for Array fields ([#49328](https://github.com/milvus-io/milvus/pull/49328), [#49724](https://github.com/milvus-io/milvus/pull/49724))',
          '',
          '- Added a new feature ([#49999](https://github.com/milvus-io/milvus/pull/49999))',
          '',
          '## Bug Fixes',
          '',
          '- Existing bug fix ([#49703](https://github.com/milvus-io/milvus/pull/49703))'
        ].join('\n'),
        variableChanges: []
      });

      const releaseNotes = plan.files.find((file) => file.path === 'site/en/release_notes.md')?.after;
      expect(releaseNotes?.match(/## v2\.6\.17/g)).toHaveLength(1);
      expect(releaseNotes).toContain('Release date: May 22, 2026');
      expect(releaseNotes).toContain('| 2.6.17         | 2.6.20           |');
      expect(releaseNotes).toContain('[`ARRAY_APPEND` and `ARRAY_REMOVE` partial update operators](upsert-entities.md#Upsert-ARRAY-fields-with-partial-update-operators)');
      expect(releaseNotes).toContain('- Added a new feature ([#49999](https://github.com/milvus-io/milvus/pull/49999))');
      expect(releaseNotes).not.toContain('Remote intro.');
      expect(releaseNotes).toContain('([#49703](https://github.com/milvus-io/milvus/pull/49703))\n\n## v2.6.16');
      expect(releaseNotes).toContain('## v2.6.16');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses writes without an approved matching report hash and dry-run state', async () => {
    const task = createInitialReleaseTask({
      releaseLine: '2.6.x',
      releaseVersion: '2.6.17',
      releaseDoc: 'doc',
      documentId: 'doc',
      milvusDocsPath: '/repo',
      taskDir: '/run',
      userDocs: [],
      linkMapPath: undefined
    });

    await expect(writeReleaseApply({
      task,
      currentReportHash: 'sha256:abc',
      plan: { files: [] }
    })).rejects.toThrow('requires approval');
  });

  it('writes after approval and dry-run state are current', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-write-'));
    try {
      await mkdir(join(dir, 'site/en'), { recursive: true });
      await writeFile(join(dir, 'site/en/release_notes.md'), '# Release Notes\n\n## v2.6.16\n\nOld\n', 'utf8');
      await writeFile(join(dir, 'site/en/Variables.json'), '{\n  "milvus_sdk_java_version": "2.6.16"\n}\n', 'utf8');
      const reportHash = hashReleaseReport({ reportJson: '{}\n', reportMarkdown: '# Report\n' });
      const approved = approveReleaseTask(createInitialReleaseTask({
        releaseLine: '2.6.x',
        releaseVersion: '2.6.17',
        releaseDoc: 'doc',
        documentId: 'doc',
        milvusDocsPath: dir,
        taskDir: '/run',
        userDocs: [],
        linkMapPath: undefined
      }), {
        reportHash,
        approvedBy: 'owner',
        approvedAt: '2026-05-25T00:00:00.000Z'
      });
      const task = { ...approved, status: 'dry-run-passed' as const, steps: { ...approved.steps, dryRunPassed: true } };
      const plan = await planReleaseApply({
        milvusDocsPath: dir,
        releaseNotesSection: '## v2.6.17\n\n- Added ARRAY_REMOVE support.\n',
        variableChanges: [{ variable: 'milvus_sdk_java_version', expectedValue: '2.6.17' }]
      });

      const written = await writeReleaseApply({ task, currentReportHash: reportHash, plan });

      expect(written.steps.writePassed).toBe(true);
      expect(await readFile(join(dir, 'site/en/Variables.json'), 'utf8')).toContain('2.6.17');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
