import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { parseFeishuTarget } from '../src/core/doc-id.js';
import type { FeishuBlock } from '../src/feishu/types.js';
import {
  publishReceiptPath,
  readPublishReceipt,
  type PublishReceiptV3
} from '../src/receipts/publish-receipt.js';

const runLive = process.env.FEISHU_MD_SYNC_LIVE === '1';

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
  }, 60_000);

  it('round-trips tracked Callout bodies while preserving presentation and container identity', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    const adapter = new LarkCliAdapter();
    const documentId = await adapter.resolveDocumentId({ target: targetIdentity });
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

      const adopted = findCallouts(await adapter.fetchDocBlocks({ doc: documentId }));
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
      const afterBodyUpdate = findCallouts(await adapter.fetchDocBlocks({ doc: documentId }));
      expect(afterBodyUpdate.find((callout) => callout.title === 'Notes')).toMatchObject({
        blockId: note.blockId,
        title: 'Notes',
        emoji: note.emoji,
        body: ['Note local v1.', 'Note second.']
      });

      await adapter.replaceBlock({
        doc: documentId,
        blockId: warning.bodyBlockIds[0]!,
        content: 'Warning remote edit.',
        format: 'markdown'
      });
      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note local edit.'],
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const disjoint = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(disjoint, 'publish disjoint Callout edits');
      const afterDisjoint = findCallouts(await adapter.fetchDocBlocks({ doc: documentId }));
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
      await adapter.replaceBlock({
        doc: documentId,
        blockId: currentNote.bodyBlockIds[1]!,
        content: 'Note remote conflict.',
        format: 'markdown'
      });
      await writeFile(file, calloutMarkdown({
        note: ['Note local v1.', 'Note local conflict.'],
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const conflict = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--format', 'json'
      ]);
      assertCliSuccess(conflict, 'detect overlapping Callout edit');
      expect(conflict.stdout).toContain('"strategy": "blocked"');
      expect(conflict.stdout).toContain('"code": "remote-callout-conflict"');

      await adapter.replaceBlock({
        doc: documentId,
        blockId: currentNote.bodyBlockIds[1]!,
        content: 'Note local edit.',
        format: 'markdown'
      });
      await writeFile(file, calloutMarkdown({
        warning: ['Warning first.', 'Warning second.']
      }), 'utf8');
      const deletion = await runCli([
        'publish', file, '--target', target, '--profile', 'none', '--write',
        '--confirm-collaboration-risk', '--format', 'json'
      ]);
      assertCliSuccess(deletion, 'delete tracked Callout');
      expect(deletion.stdout).toContain('"kind": "callout-delete"');
      const afterDeletion = findCallouts(await adapter.fetchDocBlocks({ doc: documentId }));
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

  it('creates and tracks an SVG Whiteboard from an existing image block', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const targetIdentity = parseFeishuTarget(target);
    const cwd = new URL('..', import.meta.url).pathname;
    const adapter = new LarkCliAdapter();
    const documentId = await adapter.resolveDocumentId({ target: targetIdentity });
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

      const createdWhiteboard = findWhiteboard(await adapter.fetchDocBlocks({ doc: documentId }));
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

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      timeout: 25_000
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

function runLarkCli(args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const identity = process.env.FEISHU_MD_SYNC_LARK_AS;
    const fullArgs = identity === 'bot' || identity === 'user' ? [...args, '--as', identity] : args;
    execFile('lark-cli', fullArgs, { cwd: options.cwd, env: process.env, timeout: 25_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`lark-cli setup failed\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve();
    });
  });
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
}): Promise<PublishReceiptV3> {
  const receipt = await readPublishReceipt(input);
  if (receipt?.version !== 3) throw new Error('expected a version 3 publish receipt with Whiteboard state');
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
