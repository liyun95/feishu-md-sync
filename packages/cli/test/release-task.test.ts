import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  approveReleaseTask,
  createInitialReleaseTask,
  hashReleaseReport,
  loadReleaseTask,
  releaseTaskPath,
  saveReleaseTask
} from '../src/release/task.js';

describe('release task state', () => {
  it('creates and persists an initialized task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'release-task-'));
    try {
      const task = createInitialReleaseTask({
        releaseLine: '2.6.x',
        releaseVersion: '2.6.17',
        releaseDoc: 'https://zilliverse.feishu.cn/docx/YCLkdsNq8oW5JuxjWgRcEDNonAh',
        documentId: 'doc-token',
        milvusDocsPath: '/repo/milvus-docs',
        taskDir: dir,
        userDocs: [
          {
            localPath: 'site/en/userGuide/insert-and-delete/upsert-entities.md',
            feishuDoc: 'https://zilliverse.feishu.cn/wiki/YtJPwEVETiTaPMkWSfAccjXTnge'
          }
        ],
        linkMapPath: 'release-links.json'
      });

      await saveReleaseTask(task);
      const saved = JSON.parse(await readFile(releaseTaskPath(dir), 'utf8'));
      const loaded = await loadReleaseTask(dir);

      expect(saved.kind).toBe('feishu-release-task');
      expect(loaded.releaseVersion).toBe('2.6.17');
      expect(loaded.steps).toEqual({
        pulledReleaseNotes: false,
        scannedSdkTags: false,
        audited: false,
        approved: false,
        dryRunPassed: false,
        writePassed: false
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hashes report content and records approval metadata', async () => {
    const hash = hashReleaseReport({
      reportJson: '{"ok":true}\n',
      reportMarkdown: '# Report\n'
    });
    const task = createInitialReleaseTask({
      releaseLine: '3.0.x',
      releaseVersion: '3.0.0',
      releaseDoc: 'docx-token',
      documentId: 'docx-token',
      milvusDocsPath: '/repo/milvus-docs',
      taskDir: '/tmp/release-task',
      userDocs: [],
      linkMapPath: undefined
    });
    const approved = approveReleaseTask(task, {
      reportHash: hash,
      approvedBy: 'release-owner',
      approvedAt: '2026-05-25T00:00:00.000Z'
    });

    expect(hash).toMatch(/^sha256:/);
    expect(approved.status).toBe('approved');
    expect(approved.steps.approved).toBe(true);
    expect(approved.reportHash).toBe(hash);
    expect(approved.approval?.approvedBy).toBe('release-owner');
  });
});
