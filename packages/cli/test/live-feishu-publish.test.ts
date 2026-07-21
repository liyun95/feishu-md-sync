import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createFeishuDocxEngine,
  type DesiredNode,
  type MutationJournal,
  type SnapshotNode,
} from 'feishu-docx-engine';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { parseFeishuTarget } from '../src/core/doc-id.js';
import type { FeishuBlock } from '../src/feishu/types.js';
import {
  publishReceiptPath,
  readPublishReceipt,
  type PublishReceiptV4
} from '../src/receipts/publish-receipt.js';
import {
  disposableCleanupRequest,
  larkCliArgsWithIdentity,
  resolveDisposableLiveIdentities,
  type ExplicitLiveIdentity,
} from './support/live-feishu-cleanup.js';

const runLive = process.env.FEISHU_MD_SYNC_LIVE === '1';
const runDisposableEngineWrite = runLive &&
  process.env.FEISHU_MD_SYNC_ENGINE_LIVE_WRITE === '1' &&
  Boolean(process.env.FEISHU_MD_SYNC_ENGINE_TEST_PARENT);
const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const LIVE_COMMAND_TIMEOUT_MS = 120_000;

describe.skipIf(!runLive)('live Feishu publish', () => {
  it('publishes a Zilliz draft to an existing test doc with guarded document replace', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const dryRun = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--strategy',
      'document-replace',
      '--format',
      'json'
    ]);

    assertCliSuccess(dryRun, 'dry-run publish');
    expect(dryRun.stdout).toContain('"strategy": "document-replace"');

    const write = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--write',
      '--strategy',
      'document-replace',
      '--confirm-destructive',
      '--format',
      'json'
    ]);

    assertCliSuccess(write, 'guarded write publish');
    expect(write.stdout).toContain('"mode": "write"');
  }, 30_000);

  it('adopts and publishes mixed text plus HTML table changes through scoped block writes', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    await runLarkCli([
      'docs',
      '+update',
      '--doc',
      target,
      '--command',
      'overwrite',
      '--doc-format',
      'xml',
      '--content',
      '<p>Baseline paragraph.</p><table><thead><tr><th><p>Parameter</p></th><th><p>Description</p></th></tr></thead><tbody><tr><td><p><code>build_algo</code></p></td><td><p>Possible values:</p><ul><li><code>IVF_PQ</code>: Higher quality.</li><li><code>NN_DESCENT</code>: Faster.</li></ul></td></tr></tbody></table>',
      '--format',
      'json'
    ]);
    await rm(publishReceiptPath({ cwd, target: targetIdentity }), { force: true });

    const dir = await mkdtemp(join(tmpdir(), 'fms-live-table-'));
    const file = join(dir, 'doc.md');
    const baseline = `Baseline paragraph.\n\n${htmlTable(false)}`;
    await writeFile(file, baseline, 'utf8');

    const adopt = await runCli([
      'publish', file, '--target', target, '--profile', 'none', '--write', '--confirm-untracked-remote', '--format', 'json'
    ]);
    assertCliSuccess(adopt, 'adopt scoped table baseline');
    expect(adopt.stdout).toContain('"strategy": "no-op"');

    await writeFile(file, `Updated paragraph.\n\n${htmlTable(true)}`, 'utf8');
    const dryRun = await runCli(['publish', file, '--target', target, '--profile', 'none', '--format', 'json']);
    assertCliSuccess(dryRun, 'dry-run mixed scoped publish');
    expect(dryRun.stdout).toContain('"kind": "update"');
    expect(dryRun.stdout).toContain('"kind": "table-replace"');
    expect(dryRun.stdout).toContain('"key": "num_random_samplings"');

    const write = await runCli([
      'publish', file, '--target', target, '--profile', 'none', '--write', '--confirm-collaboration-risk', '--format', 'json'
    ]);
    assertCliSuccess(write, 'write mixed scoped publish');
    expect(write.stdout).toContain('"mode": "write"');

    const status = await runCli(['status', file, '--target', target, '--profile', 'none', '--format', 'json']);
    assertCliSuccess(status, 'status after mixed scoped publish');
    expect(status.stdout).toContain('"state": "clean"');
  }, 180_000);

  it('round-trips tracked Callout bodies while preserving presentation and container identity', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    const adapter = new LarkCliAdapter();
    const documentId = await retryRateLimited(() => {
      return adapter.resolveDocumentId({ target: targetIdentity });
    });
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-callout-'));
    const file = join(dir, 'doc.md');
    const pulled = join(dir, 'pulled.md');
    const baseline = calloutMarkdown({
      note: ['Note first.', 'Note second.'],
      warning: ['Warning first.', 'Warning second.']
    });

    try {
      await runLarkCli([
        'docs',
        '+update',
        '--doc',
        documentId,
        '--command',
        'overwrite',
        '--doc-format',
        'xml',
        '--content',
        '<callout emoji="📘" background-color="light-orange" border-color="orange"><p>Notes</p><p>Note first.</p><p>Note second.</p></callout>' +
          '<callout emoji="❗" background-color="light-red" border-color="red"><p>Warning</p><p>Warning first.</p><p>Warning second.</p></callout>',
        '--format',
        'json'
      ]);
      await rm(publishReceiptPath({ cwd, target: targetIdentity }), { force: true });
      await writeFile(file, baseline, 'utf8');

      const adopt = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-untracked-remote', '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(adopt, 'adopt Callout baseline');
      expect(adopt.stdout).toContain('"strategy": "no-op"');

      const adopted = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      const note = adopted.find((callout) => callout.title === 'Notes');
      const warning = adopted.find((callout) => callout.title === 'Warning');
      expect(note).toMatchObject({ body: ['Note first.', 'Note second.'] });
      expect(warning).toMatchObject({ body: ['Warning first.', 'Warning second.'] });
      if (!note || !warning) throw new Error('live Callout setup did not create note and warning containers');
      expect(note.emoji).toBeTruthy();
      expect(warning.emoji).toBeTruthy();

      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note second.'],
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const bodyUpdate = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(bodyUpdate, 'publish Callout body update');
      const afterBodyUpdate = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      expect(afterBodyUpdate.find((callout) => callout.title === 'Notes')).toMatchObject({
        blockId: note.blockId,
        title: 'Notes',
        emoji: note.emoji,
        body: ['Note local v1.', 'Note second.']
      });

      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: warning.bodyBlockIds[0]!,
        content: 'Warning remote edit.',
        format: 'markdown'
      }));
      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note local edit.'],
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const disjoint = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(disjoint, 'publish disjoint Callout edits');
      const afterDisjoint = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      expect(afterDisjoint.find((callout) => callout.title === 'Notes')).toMatchObject({
        blockId: note.blockId,
        emoji: note.emoji,
        body: ['Note local v1.', 'Note local edit.']
      });
      expect(afterDisjoint.find((callout) => callout.title === 'Warning')).toMatchObject({
        blockId: warning.blockId,
        emoji: warning.emoji,
        body: ['Warning remote edit.', 'Warning second.']
      });

      const currentNote = afterDisjoint.find((callout) => callout.title === 'Notes');
      if (!currentNote) throw new Error('live Callout note disappeared before conflict test');
      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: currentNote.bodyBlockIds[1]!,
        content: 'Note remote conflict.',
        format: 'markdown'
      }));
      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note local conflict.'],
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const conflict = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--format', 'json'
      ]);
      expect(conflict.status).toBe(1);
      expect(conflict.stdout).toContain('"strategy": "blocked"');
      expect(conflict.stdout).toContain('"code": "remote-callout-conflict"');

      const conflictedNote = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      })).find((callout) => callout.title === 'Notes');
      if (!conflictedNote) throw new Error('live Callout note disappeared before conflict recovery');
      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: conflictedNote.bodyBlockIds[1]!,
        content: 'Note local edit.',
        format: 'markdown'
      }));
      const restored = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      expect(restored.find((callout) => callout.title === 'Notes')?.body).toEqual([
        'Note local v1.', 'Note local edit.'
      ]);
      expect(restored.find((callout) => callout.title === 'Warning')?.body).toEqual([
        'Warning remote edit.', 'Warning second.'
      ]);
      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note local edit.'],
        warning: ['Warning remote edit.', 'Warning second.']
      }), 'utf8');
      const refresh = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write', '--format', 'json'
      ]);
      assertCliSuccess(refresh, 'refresh resolved Callout baseline');
      expect(refresh.stdout).toContain('"strategy": "no-op"');

      await writeFile(file, calloutMarkdown({
        warning: ['Warning remote edit.', 'Warning second.']
      }), 'utf8');
      const deletion = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(deletion, 'delete tracked Callout');
      expect(deletion.stdout).toContain('"kind": "callout-delete"');
      const afterDeletion = findCallouts(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      expect(afterDeletion.some((callout) => callout.blockId === note.blockId)).toBe(false);
      expect(afterDeletion).toHaveLength(1);
      expect(afterDeletion[0]).toMatchObject({
        blockId: warning.blockId,
        title: 'Warning',
        emoji: warning.emoji,
        body: ['Warning remote edit.', 'Warning second.']
      });

      const pull = await runCli([
        'pull', '--target', target, '--output', pulled, '--profile', 'none', '--format', 'json'
      ]);
      assertCliSuccess(pull, 'pull canonical Callout');
      const pulledMarkdown = await readFile(pulled, 'utf8');
      expect(pulledMarkdown).toContain('<div class="alert warning">');
      expect(pulledMarkdown).toContain('Warning remote edit.');
      expect(pulledMarkdown).not.toContain('\nWarning\n');
      expect(pulledMarkdown).not.toContain('<callout');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('round-trips Code content, language, captions, movement, conflicts, and deletion', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    const adapter = new LarkCliAdapter();
    const documentId = await retryRateLimited(() => {
      return adapter.resolveDocumentId({ target: targetIdentity });
    });
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-code-'));
    const file = join(dir, 'doc.md');

    try {
      await runLarkCli([
        'docs', '+update', '--doc', documentId, '--command', 'overwrite', '--doc-format', 'xml',
        '--content', '<h1>Build</h1><pre lang="python" caption="Example"><code>print("old")</code></pre>' +
          '<h1>Search</h1><pre lang="bash"><code>echo old</code></pre>',
        '--format', 'json'
      ]);
      await rm(publishReceiptPath({ cwd, target: targetIdentity }), { force: true });

      const pull = await runCli([
        'pull', '--target', target, '--output', file, '--profile', 'none', '--format', 'json'
      ]);
      assertCliSuccess(pull, 'pull Code baseline');
      const pulledBaseline = await readFile(file, 'utf8');
      const baseline = pulledBaseline.replace(/^<title>[^\n]+<\/title>\n\n/, '');
      await writeFile(file, baseline, 'utf8');
      expect(baseline).toContain('```python');
      expect(baseline).toContain('```bash');

      const adopt = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-untracked-remote', '--format', 'json'
      ]);
      assertCliSuccess(adopt, 'adopt Code baseline');
      expect(adopt.stdout).toContain('"strategy": "no-op"');
      const adopted = await findCodeBlocks(adapter, documentId);
      expect(adopted).toHaveLength(2);
      expect(adopted[0]).toMatchObject({ content: 'print("old")', caption: 'Example' });

      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: adopted[0]!.blockId,
        content: '<pre lang="go" caption="Example"><code>print("old")</code></pre>',
        format: 'xml'
      }));
      await writeFile(file, baseline.replace('print("old")', 'print("local")'), 'utf8');
      const disjoint = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(disjoint, 'merge disjoint Code content and language');
      const afterDisjoint = await findCodeBlocks(adapter, documentId);
      expect(afterDisjoint[0]).toMatchObject({ content: 'print("local")', language: 'go', caption: 'Example' });

      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: afterDisjoint[0]!.blockId,
        content: '<pre lang="go" caption="Example"><code>print("remote conflict")</code></pre>',
        format: 'xml'
      }));
      await writeFile(file, baseline.replace('print("old")', 'print("local conflict")'), 'utf8');
      const conflict = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--format', 'json'
      ]);
      expect(conflict.status).toBe(1);
      expect(conflict.stdout).toContain('"code": "remote-code-conflict"');

      const conflicted = await findCodeBlocks(adapter, documentId);
      await retryRateLimited(() => adapter.replaceBlock({
        doc: documentId,
        blockId: conflicted[0]!.blockId,
        content: '<pre lang="go" caption="Example"><code>print("local")</code></pre>',
        format: 'xml'
      }));
      const localAfterDisjoint = baseline.replace('print("old")', 'print("local")');
      await writeFile(file, localAfterDisjoint, 'utf8');
      const refresh = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write', '--format', 'json'
      ]);
      assertCliSuccess(refresh, 'refresh Code baseline after conflict recovery');

      const beforeMove = await findCodeBlocks(adapter, documentId);
      const buildFence = '```python\nprint("local")\n```';
      const searchFence = '```bash\necho old\n```';
      const movedMarkdown = localAfterDisjoint
        .replace(buildFence, '__FMS_CODE_A__')
        .replace(searchFence, buildFence)
        .replace('__FMS_CODE_A__', searchFence);
      await writeFile(file, movedMarkdown, 'utf8');
      const move = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(move, 'move Code blocks across sections');
      expect(move.stdout).toContain('"kind": "code-move"');
      const afterMove = await findCodeBlocks(adapter, documentId);
      expect(afterMove.map((code) => code.blockId).sort()).toEqual(beforeMove.map((code) => code.blockId).sort());

      const rewrittenFence = '```bash\necho rewritten\n```';
      const reconciledMarkdown = movedMarkdown
        .replace(`${searchFence}\n\n`, '')
        .replace(buildFence, `${buildFence}\n\n${rewrittenFence}`);
      await writeFile(file, reconciledMarkdown, 'utf8');
      const reconcile = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(reconcile, 'reconcile moved and rewritten Code block');
      expect(reconcile.stdout).toContain('"kind": "code-section-reconcile"');
      const afterReconcile = await findCodeBlocks(adapter, documentId);
      expect(afterReconcile).toHaveLength(2);
      expect(afterReconcile).toContainEqual(expect.objectContaining({ content: 'echo rewritten' }));
      expect(afterReconcile).toContainEqual(expect.objectContaining({
        content: 'print("local")',
        caption: 'Example'
      }));

      const deleteMarkdown = reconciledMarkdown.replace(rewrittenFence, '');
      await writeFile(file, deleteMarkdown, 'utf8');
      const deletion = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(deletion, 'delete tracked Code block');
      expect(deletion.stdout).toContain('"kind": "code-delete"');
      expect(await findCodeBlocks(adapter, documentId)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it('creates and tracks an SVG Whiteboard from an existing image block', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    const adapter = new LarkCliAdapter();
    const documentId = await retryRateLimited(() => {
      return adapter.resolveDocumentId({ target: targetIdentity });
    });
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-whiteboard-'));
    const file = join(dir, 'doc.md');
    const png = join(dir, 'architecture.png');
    const svg = join(dir, 'architecture.svg');
    const assetKey = 'architecture.png';

    try {
      await runLarkCli([
        'docs',
        '+update',
        '--doc',
        documentId,
        '--command',
        'overwrite',
        '--doc-format',
        'xml',
        '--content',
        '<p>Whiteboard baseline.</p>',
        '--format',
        'json'
      ]);
      await rm(publishReceiptPath({ cwd, target: targetIdentity }), { force: true });
      await writeFile(file, 'Whiteboard baseline.\n\n![Architecture](./architecture.png)\n', 'utf8');
      await writeFile(png, tinyPng());
      await writeFile(svg, whiteboardSvg('Architecture v1'), 'utf8');
      await runLarkCli([
        'docs', '+media-insert', '--doc', documentId, '--file', './architecture.png', '--type', 'image', '--format', 'json'
      ], { cwd: dir });

      const create = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--sync-whiteboards', '--write',
        '--confirm-untracked-remote', '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(create, 'create Whiteboard from image');
      expect(create.stdout).toContain('"kind": "whiteboard-create"');

      const createdWhiteboard = findWhiteboard(await retryRateLimited(() => {
        return adapter.fetchDocBlocks({ doc: documentId });
      }));
      const createdReceipt = await readWhiteboardReceipt({ cwd, target: targetIdentity });
      expect(createdReceipt.whiteboards).toContainEqual(expect.objectContaining({
        assetKey,
        blockId: createdWhiteboard.blockId,
        whiteboardToken: createdWhiteboard.whiteboardToken
      }));

      const status = await runCli([
        'status', file, '--target', target, '--profile', 'none', '--sync-whiteboards', '--format', 'json'
      ]);
      assertCliSuccess(status, 'status after Whiteboard creation');
      expect(status.stdout).toContain('"state": "clean"');
      expect(status.stdout).toContain('"action": "no-op"');

      const noOp = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--sync-whiteboards', '--write', '--format', 'json'
      ]);
      assertCliSuccess(noOp, 'no-op Whiteboard publish');
      expect(noOp.stdout).toContain('"strategy": "no-op"');

      const finalReceipt = await readWhiteboardReceipt({ cwd, target: targetIdentity });
      expect(finalReceipt.whiteboards).toContainEqual(expect.objectContaining({
        assetKey,
        blockId: createdWhiteboard.blockId,
        whiteboardToken: createdWhiteboard.whiteboardToken
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(process.env.FEISHU_MD_SYNC_TEST_CREATE_PARENT)('creates a Zilliz draft under a test parent', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_CREATE_PARENT');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-create-'));
    const file = join(dir, 'doc.md');
    const title = `fms-live-create-${Date.now()}`;
    await writeFile(file, `# ${title}\n\nMilvus stores vectors.`, 'utf8');

    const dryRun = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--create',
      '--profile',
      'zilliz',
      '--format',
      'json'
    ]);

    assertCliSuccess(dryRun, 'dry-run create publish');
    expect(dryRun.stdout).toContain('"strategy": "create-document"');

    const write = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--create',
      '--profile',
      'zilliz',
      '--write',
      '--format',
      'json'
    ]);

    assertCliSuccess(write, 'write create publish');
    expect(write.stdout).toContain('"mode": "write"');
    expect(write.stdout).toContain('"documentId"');
  }, 30_000);

  it.runIf(runDisposableEngineWrite)(
    'creates a nested list and native table in an isolated disposable document and deletes it',
    async () => {
      const parentToken = requiredEnv('FEISHU_MD_SYNC_ENGINE_TEST_PARENT');
      const title = `fms-engine-live-disposable-${Date.now()}`;
      const { writeIdentity, cleanupIdentity } = resolveDisposableLiveIdentities(process.env);
      const adapter = new LarkCliAdapter({ identity: writeIdentity });
      let createdDocumentId: string | undefined;

      try {
        const created = await adapter.docxTransport.createDocument({
          title,
          markdown: 'Disposable engine live-test baseline.\n',
          parentToken,
        });
        createdDocumentId = created.documentId;
        const engine = createFeishuDocxEngine({ transport: adapter.docxTransport });
        const before = await engine.snapshot({ kind: 'docx', token: created.documentId });
        const root = before.nodes.find(({ blockId }) => blockId === before.rootBlockId)!;
        const originalRootChildren = [...root.childBlockIds];
        const insertAfterBlockId = root.childBlockIds.at(-1) ?? root.blockId;
        const batch = engine.prepare({
          snapshot: before,
          idempotencyNamespace: `live-disposable:${created.documentId}`,
          operations: [{
            operationId: 'insert-nested-list-and-native-table',
            kind: 'insert',
            parentBlockId: root.blockId,
            insertAfterBlockId,
            desired: [liveNestedList(), liveNativeTable()],
          }],
        });
        const result = await engine.apply({ batch, journal: memoryJournal() });

        expect(result.operations).toEqual([
          expect.objectContaining({
            operationId: 'insert-nested-list-and-native-table',
            verified: true,
          }),
        ]);
        const byId = new Map(result.finalSnapshot.nodes.map((node) => [node.blockId, node]));
        const finalRoot = byId.get(result.finalSnapshot.rootBlockId)!;
        const insertedRootIds = finalRoot.childBlockIds.slice(originalRootChildren.length);
        expect(insertedRootIds).toHaveLength(2);

        const parentList = requiredSnapshotNode(byId, insertedRootIds[0]!);
        assertExactListNode(parentList, {
          parentBlockId: finalRoot.blockId,
          blockType: 12,
          payloadKey: 'bullet',
          text: 'Engine live parent',
        });
        expect(parentList.childBlockIds).toHaveLength(1);
        const nestedList = requiredSnapshotNode(byId, parentList.childBlockIds[0]!);
        assertExactListNode(nestedList, {
          parentBlockId: parentList.blockId,
          blockType: 13,
          payloadKey: 'ordered',
          text: 'Engine live nested child',
        });
        expect(nestedList.childBlockIds).toEqual([]);

        const table = requiredSnapshotNode(byId, insertedRootIds[1]!);
        expect(finalRoot.childBlockIds).toEqual([
          ...originalRootChildren,
          parentList.blockId,
          table.blockId,
        ]);
        assertExactNativeTable(table, byId, [
          ['Name', 'Safety'],
          ['Docx engine', 'Verified'],
        ]);
        expect(result.operations[0]!.createdBlockIds).toEqual(expect.arrayContaining([
          parentList.blockId,
          nestedList.blockId,
          table.blockId,
          ...table.childBlockIds,
        ]));
      } finally {
        if (createdDocumentId) await deleteDisposableDocument(createdDocumentId, cleanupIdentity);
      }
    },
    180_000,
  );
});

function assertCliSuccess(result: { stdout: string; stderr: string; status: number | null }, label: string): void {
  if (result.status === 0) return;
  throw new Error(`${label} failed with status ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live Feishu tests.`);
  return value;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runCliOnce(args);
    const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || !isRateLimited(`${result.stdout}\n${result.stderr}`)) return result;
    await delay(delayMs);
  }
}

function runCliOnce(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: LIVE_COMMAND_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

async function retryRateLimited<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRateLimited(error instanceof Error ? error.message : String(error))) throw error;
      await delay(delayMs);
    }
  }
}

function isRateLimited(value: string): boolean {
  return /(?:HTTP\s+429|\b429\b.*(?:rate|limit|response))/i.test(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runLarkCli(
  args: string[],
  options: { cwd?: string; identity?: ExplicitLiveIdentity } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const identity = options.identity ?? process.env.FEISHU_MD_SYNC_LARK_AS;
    const fullArgs = identity === 'bot' || identity === 'user'
      ? larkCliArgsWithIdentity(args, identity)
      : args;
    execFile('lark-cli', fullArgs, {
      cwd: options.cwd,
      env: process.env,
      timeout: LIVE_COMMAND_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`lark-cli setup failed\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve();
    });
  });
}

async function deleteDisposableDocument(
  documentId: string,
  cleanupIdentity: ExplicitLiveIdentity,
): Promise<void> {
  const request = disposableCleanupRequest(documentId, cleanupIdentity);
  try {
    await runLarkCli(request.args, { identity: request.identity });
  } catch (cause) {
    throw new Error(`cleanup failed for disposable live-test document ${documentId}`, { cause });
  }
}

function memoryJournal(): MutationJournal {
  return { async recordVerified() {} };
}

function liveNestedList(): DesiredNode {
  return {
    kind: 'list',
    ordered: false,
    items: [{
      content: [{ kind: 'text', text: 'Engine live parent' }],
      children: [{
        kind: 'list',
        ordered: true,
        items: [{
          content: [{ kind: 'text', text: 'Engine live nested child' }],
          children: [],
        }],
      }],
    }],
  };
}

function liveNativeTable(): DesiredNode {
  const paragraph = (text: string): DesiredNode => ({
    kind: 'paragraph',
    content: [{ kind: 'text', text }],
  });
  return {
    kind: 'table',
    rows: [
      { cells: [{ content: [paragraph('Name')] }, { content: [paragraph('Safety')] }] },
      { cells: [{ content: [paragraph('Docx engine')] }, { content: [paragraph('Verified')] }] },
    ],
  };
}

function requiredSnapshotNode(nodes: Map<string, SnapshotNode>, blockId: string): SnapshotNode {
  const node = nodes.get(blockId);
  if (!node) throw new Error(`live readback is missing block ${blockId}`);
  return node;
}

function assertExactListNode(node: SnapshotNode, expected: {
  parentBlockId: string;
  blockType: 12 | 13;
  payloadKey: 'bullet' | 'ordered';
  text: string;
}): void {
  expect(node).toMatchObject({
    parentBlockId: expected.parentBlockId,
    blockType: expected.blockType,
    kind: 'list',
  });
  expect(node.raw.parent_id).toBe(expected.parentBlockId);
  expect(node.raw.block_type).toBe(expected.blockType);
  expect(node.raw[expected.payloadKey === 'bullet' ? 'ordered' : 'bullet']).toBeUndefined();
  const payload = requiredRecord(node.raw[expected.payloadKey], `${expected.payloadKey} payload`);
  const elements = requiredArray(payload.elements, `${expected.payloadKey}.elements`);
  expect(elements).toHaveLength(1);
  const textRun = requiredRecord(
    requiredRecord(elements[0], `${expected.payloadKey}.elements[0]`).text_run,
    `${expected.payloadKey}.elements[0].text_run`,
  );
  expect(textRun.content).toBe(expected.text);
  assertDefaultTextElementStyle(textRun.text_element_style);
  assertDefaultBlockStyle(payload.style, expected.payloadKey === 'ordered' ? { sequence: '1' } : {});
}

function assertExactNativeTable(
  table: SnapshotNode,
  nodes: Map<string, SnapshotNode>,
  expectedRows: string[][],
): void {
  expect(table).toMatchObject({ blockType: 31, kind: 'table' });
  const rawTable = requiredRecord(table.raw.table, 'table payload');
  const property = requiredRecord(rawTable.property, 'table.property');
  expect(property.row_size).toBe(expectedRows.length);
  expect(property.column_size).toBe(expectedRows[0]!.length);
  const expectedCellCount = expectedRows.length * expectedRows[0]!.length;
  expect(table.childBlockIds).toHaveLength(expectedCellCount);
  expect(rawTable.cells).toEqual(table.childBlockIds);
  assertExactUnmergedCells(property.merge_info, expectedCellCount);

  const expectedTexts = expectedRows.flat();
  table.childBlockIds.forEach((cellId, cellIndex) => {
    const cell = requiredSnapshotNode(nodes, cellId);
    expect(cell).toMatchObject({
      parentBlockId: table.blockId,
      blockType: 32,
      kind: 'opaque',
    });
    expect(cell.raw.parent_id).toBe(table.blockId);
    expect(cell.childBlockIds).toHaveLength(1);
    const paragraph = requiredSnapshotNode(nodes, cell.childBlockIds[0]!);
    expect(paragraph).toMatchObject({
      parentBlockId: cell.blockId,
      blockType: 2,
      kind: 'paragraph',
    });
    assertExactPlainText(paragraph.raw, expectedTexts[cellIndex]!);
  });
}

function assertExactPlainText(raw: Record<string, unknown>, expectedText: string): void {
  const payload = requiredRecord(raw.text, 'paragraph.text');
  const elements = requiredArray(payload.elements, 'paragraph.text.elements');
  expect(elements).toHaveLength(1);
  const run = requiredRecord(
    requiredRecord(elements[0], 'paragraph.text.elements[0]').text_run,
    'paragraph.text.elements[0].text_run',
  );
  expect(run.content).toBe(expectedText);
  assertDefaultTextElementStyle(run.text_element_style);
  assertDefaultBlockStyle(payload.style);
}

function assertDefaultTextElementStyle(value: unknown): void {
  const style = value === undefined ? {} : requiredRecord(value, 'text_element_style');
  const defaults: Record<string, unknown> = {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    inline_code: false,
  };
  for (const [key, actual] of Object.entries(style)) {
    expect(defaults).toHaveProperty(key);
    expect(actual).toBe(defaults[key]);
  }
}

function assertDefaultBlockStyle(value: unknown, additionalDefaults: Record<string, unknown> = {}): void {
  const style = value === undefined ? {} : requiredRecord(value, 'block style');
  const defaults: Record<string, unknown> = { align: 1, folded: false, ...additionalDefaults };
  for (const [key, actual] of Object.entries(style)) {
    expect(defaults).toHaveProperty(key);
    expect(actual).toBe(defaults[key]);
  }
}

function assertExactUnmergedCells(value: unknown, cellCount: number): void {
  if (value === undefined) return;
  const mergeInfo = requiredArray(value, 'table.property.merge_info');
  expect(mergeInfo).toHaveLength(cellCount);
  for (const entry of mergeInfo) {
    if (entry === null || entry === undefined) continue;
    expect(requiredRecord(entry, 'table merge entry')).toEqual({ row_span: 1, col_span: 1 });
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function htmlTable(includeNewRow: boolean): string {
  return `<table>\n  <tr><th><p>Parameter</p></th><th><p>Description</p></th></tr>\n  <tr><td><p><code>build_algo</code></p></td><td><p>Possible values:</p><ul><li><code>IVF_PQ</code>: Higher quality.</li><li><code>NN_DESCENT</code>: Faster.</li></ul></td></tr>${includeNewRow ? '\n  <tr><td><p><code>num_random_samplings</code></p></td><td><p>Initial random seed iterations.</p></td></tr>' : ''}\n</table>`;
}

function whiteboardSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><rect x="20" y="20" width="280" height="80" rx="12" fill="#eef2ff" stroke="#4f46e5"/><text x="160" y="68" text-anchor="middle" fill="#312e81">${label}</text></svg>`;
}

function tinyPng(): Buffer {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
}

function findWhiteboard(blocks: Awaited<ReturnType<LarkCliAdapter['fetchDocBlocks']>>): {
  blockId: string;
  whiteboardToken: string;
} {
  const block = blocks.blocks.find((item) => item.block_type === 43 && whiteboardTokenForBlock(item));
  const whiteboardToken = block ? whiteboardTokenForBlock(block) : undefined;
  if (!block?.block_id || !whiteboardToken) {
    throw new Error('live Whiteboard setup did not create exactly one queryable Whiteboard block');
  }
  return { blockId: block.block_id, whiteboardToken };
}

function whiteboardTokenForBlock(block: { whiteboard?: unknown; board?: unknown }): string | undefined {
  for (const value of [block.whiteboard, block.board]) {
    if (value && typeof value === 'object' && 'token' in value && typeof value.token === 'string') return value.token;
  }
  return undefined;
}

async function readWhiteboardReceipt(input: {
  cwd: string;
  target: ReturnType<typeof parseFeishuTarget>;
}): Promise<PublishReceiptV4> {
  const receipt = await readPublishReceipt(input);
  if (receipt?.version !== 4) throw new Error('expected a version 4 publish receipt with Whiteboard state');
  return receipt;
}

function calloutMarkdown(input: {
  note?: string[];
  warning?: string[];
}): string {
  return [
    input.note ? `<div class="alert note">\n\n${input.note.join('\n\n')}\n\n</div>` : undefined,
    input.warning ? `<div class="alert warning">\n\n${input.warning.join('\n\n')}\n\n</div>` : undefined
  ].filter((value): value is string => value !== undefined).join('\n\n');
}

function findCallouts(blocks: Awaited<ReturnType<LarkCliAdapter['fetchDocBlocks']>>): Array<{
  blockId: string;
  title: string;
  emoji?: string;
  body: string[];
  bodyBlockIds: string[];
}> {
  const byId = new Map(blocks.blocks.flatMap((block) => block.block_id ? [[block.block_id, block] as const] : []));
  return blocks.blocks.flatMap((block) => {
    if (block.block_type !== 19 || !block.block_id) return [];
    const children = (Array.isArray(block.children) ? block.children : []).flatMap((child) => {
      const resolved = typeof child === 'string' ? byId.get(child) : child;
      return resolved && typeof resolved === 'object' ? [resolved as FeishuBlock] : [];
    });
    const title = blockText(children[0]);
    const bodyBlocks = children.slice(1);
    return [{
      blockId: block.block_id,
      title,
      emoji: calloutEmoji(block),
      body: bodyBlocks.map(blockText),
      bodyBlockIds: bodyBlocks.flatMap((child) => child.block_id ? [child.block_id] : [])
    }];
  });
}

function blockText(block: FeishuBlock | undefined): string {
  if (!block) return '';
  const key = block.block_type === 2 ? 'text' : `heading${block.block_type - 2}`;
  const value = block[key];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('elements' in value)) return '';
  const elements = Array.isArray(value.elements) ? value.elements : [];
  return elements.flatMap((element) => {
    if (!element || typeof element !== 'object' || Array.isArray(element) || !('text_run' in element)) return [];
    const run = element.text_run;
    return run && typeof run === 'object' && 'content' in run && typeof run.content === 'string'
      ? [run.content]
      : [];
  }).join('');
}

function calloutEmoji(block: FeishuBlock): string | undefined {
  const value = block.callout;
  return value && typeof value === 'object' && !Array.isArray(value) && 'emoji_id' in value && typeof value.emoji_id === 'string'
    ? value.emoji_id
    : undefined;
}

async function findCodeBlocks(adapter: LarkCliAdapter, documentId: string): Promise<Array<{
  blockId: string;
  content: string;
  language?: string;
  caption?: string;
}>> {
  const blocks = await retryRateLimited(() => adapter.fetchDocBlocks({ doc: documentId }));
  const metadata = new Map((await retryRateLimited(() => {
    return adapter.fetchDocCodeMetadata({ doc: documentId });
  })).map((code) => [code.blockId, code]));
  return blocks.blocks.flatMap((block) => {
    if (block.block_type !== 14 || !block.block_id) return [];
    const code = block.code;
    if (!code || typeof code !== 'object' || Array.isArray(code)) return [];
    const elements = 'elements' in code && Array.isArray(code.elements) ? code.elements : [];
    const content = elements.flatMap((element) => {
      if (!element || typeof element !== 'object' || Array.isArray(element) || !('text_run' in element)) return [];
      const run = element.text_run;
      return run && typeof run === 'object' && 'content' in run && typeof run.content === 'string'
        ? [run.content]
        : [];
    }).join('');
    const details = metadata.get(block.block_id);
    return [{
      blockId: block.block_id,
      content,
      language: details?.language,
      caption: details?.caption
    }];
  });
}
