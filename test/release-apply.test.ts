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
