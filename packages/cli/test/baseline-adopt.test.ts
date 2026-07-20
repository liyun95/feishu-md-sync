import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { runBaselineAdopt } from '../src/baseline/run-baseline-adopt.js';
import { CliFailure } from '../src/core/cli-failure.js';
import { runPublish } from '../src/publish/run-publish.js';
import { runStatus } from '../src/status/run-status.js';
import {
  readLocalBaseSnapshot,
  readPublishBaseSnapshot,
  readPublishReceipt,
  hashText,
  writePublishReceipt,
  type WhiteboardReceiptEntry
} from '../src/receipts/publish-receipt.js';
import { readRemoteSemanticSnapshot } from '../src/receipts/semantic-snapshot.js';
import { whiteboardRemoteStateHash } from '../src/whiteboards/remote-state.js';
import { semanticHash } from '../src/semantic/normalize.js';

describe('baseline adoption', () => {
  it('dry-runs an explicit L0 and R0 divergence while planning only L0 to L1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');
    const adapter = readOnlyAdapter('Remote authoring guidance.', 'rev-7');

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter
    });

    expect(result.mode).toBe('dry-run');
    expect(result.safeToAdopt).toBe(true);
    expect(result.sources.localBaseline).toMatchObject({ kind: 'file', path: baselinePath });
    expect(result.sources.localBaseline.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sources.localCurrent.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sources.remote).toMatchObject({ revision: 'rev-7' });
    expect(result.sources.remote.markdownHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.existingDivergence.changed).toBeGreaterThan(0);
    expect(result.delta.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        remoteBlockId: 'p1',
        desiredMarkdown: 'New local guidance.'
      })
    ]);
    expect(result.delta.blockers).toEqual([]);
    expect(result.confirmationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats a root H1 matching the explicit frontmatter title as the Feishu page title', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const prefix = '---\ntitle: JSON Field\n---\n\n# JSON Field\n\nIntro.\n\n## Filter\n\n';
    await writeFile(sourcePath, `${prefix}New guidance.`, 'utf8');
    await writeFile(baselinePath, `${prefix}Old guidance.`, 'utf8');
    const adapter = readOnlyAdapter('Intro.\n\n## Filter\n\nOld remote guidance.', 'rev-7');
    adapter.fetchDocBlocks = async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: ['intro', 'filter', 'guidance'] },
      textBlock('intro', 'Intro.'),
      headingBlock('filter', 4, 'Filter'),
      textBlock('guidance', 'Old remote guidance.')
    ] });

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'milvus-authoring',
      dialectConfig: {},
      apply: false,
      adapter
    });

    expect(result.safeToAdopt).toBe(true);
    expect(result.delta.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        remoteBlockId: 'guidance',
        desiredMarkdown: 'New guidance.'
      })
    ]);
  });

  it('applies only a local receipt bundle after dedicated fingerprint confirmation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');
    const mutations: string[] = [];
    const adapter = readOnlyAdapter('Remote authoring guidance.', 'rev-7', mutations);
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'none' as const,
      dialect: 'gfm' as const,
      dialectConfig: {},
      adapter
    };
    const dryRun = await runBaselineAdopt({ ...common, apply: false });

    const applied = await runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: dryRun.confirmationFingerprint
    });

    expect(applied.mode).toBe('apply');
    expect(applied.receiptWritten).toBe(true);
    expect(mutations).toEqual([]);
    const receipt = await readPublishReceipt({ cwd, target: common.target });
    expect(receipt?.version).toBe(4);
    if (!receipt || receipt.version !== 4) throw new Error('expected v4 receipt');
    await expect(readLocalBaseSnapshot({ cwd, snapshot: receipt.localBaseSnapshot }))
      .resolves.toBe('Old local guidance.');
    await expect(readPublishBaseSnapshot({ cwd, snapshot: receipt.publishBaseSnapshot }))
      .resolves.toBe('Old local guidance.');
    await expect(readRemoteSemanticSnapshot({ cwd, snapshot: receipt.remoteSemanticSnapshot! }))
      .resolves.toEqual(expect.objectContaining({ nodes: expect.any(Array) }));
  });

  it('fails closed when R0 changes after review and before the local receipt commit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');
    const revisions = ['rev-7', 'rev-7', 'rev-8'];
    const adapter = readOnlyAdapter('Remote authoring guidance.', 'rev-7');
    adapter.fetchDocMarkdown = async () => ({
      markdown: 'Remote authoring guidance.',
      revision: revisions.shift() ?? 'rev-8'
    });
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'none' as const,
      dialect: 'gfm' as const,
      dialectConfig: {},
      adapter
    };
    const dryRun = await runBaselineAdopt({ ...common, apply: false });

    await expect(runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: dryRun.confirmationFingerprint
    })).rejects.toThrow('Remote changed before baseline adoption commit');
    await expect(readPublishReceipt({ cwd, target: common.target })).resolves.toBeUndefined();
  });

  it('loads L0 from an explicit Git ref without replacing L1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-git-'));
    const sourcePath = join(cwd, 'docs', 'doc.md');
    await runGit(cwd, ['init']);
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Test']);
    await runGit(cwd, ['checkout', '-b', 'main']);
    await runGit(cwd, ['status']);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(cwd, 'docs'), { recursive: true }));
    await writeFile(sourcePath, 'Old local guidance.', 'utf8');
    await runGit(cwd, ['add', 'docs/doc.md']);
    await runGit(cwd, ['commit', '-m', 'baseline']);
    const commit = (await runGit(cwd, ['rev-parse', 'HEAD'])).trim();
    await writeFile(sourcePath, 'New local guidance.', 'utf8');

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'git', ref: 'HEAD' },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter: readOnlyAdapter('Remote authoring guidance.', 'rev-7')
    });

    expect(result.sources.localBaseline).toMatchObject({
      kind: 'git',
      ref: 'HEAD',
      commit
    });
    expect(result.delta.operations).toContainEqual(expect.objectContaining({
      kind: 'update',
      desiredMarkdown: 'New local guidance.'
    }));
  });

  it('returns typed validation when the selected Git ref does not exist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-git-'));
    const sourcePath = join(cwd, 'doc.md');
    await runGit(cwd, ['init']);
    await runGit(cwd, ['config', 'user.email', 'test@example.com']);
    await runGit(cwd, ['config', 'user.name', 'Test']);
    await writeFile(sourcePath, 'Local guidance.', 'utf8');
    await runGit(cwd, ['add', 'doc.md']);
    await runGit(cwd, ['commit', '-m', 'baseline']);

    const failure = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'git', ref: 'missing-ref' },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter: readOnlyAdapter('Remote guidance.', 'rev-7')
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).details).toMatchObject({
      type: 'validation',
      subtype: 'baseline_git_ref_invalid'
    });
  });

  it('makes subsequent publish plan only L0 to L1 on top of the adopted R0', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'Local unchanged.\n\nNew delta.', 'utf8');
    await writeFile(baselinePath, 'Local unchanged.\n\nOld delta.', 'utf8');
    const adapter = twoParagraphAdapter(
      ['Remote divergent.', 'Remote base.'],
      'rev-7'
    );
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'none' as const,
      dialect: 'gfm' as const,
      dialectConfig: {},
      adapter
    };
    const dryRun = await runBaselineAdopt({ ...common, apply: false });
    await runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: dryRun.confirmationFingerprint
    });

    const publish = await runPublish({
      cwd,
      file: sourcePath,
      target: common.target,
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      write: false,
      create: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(publish.plan.scopedPatch?.blockers).toEqual([]);
    expect(publish.plan.scopedPatch?.operations).toEqual([
      expect.objectContaining({
        kind: 'update',
        remoteBlockId: 'p2',
        desiredMarkdown: 'New delta.'
      })
    ]);
  });

  it('records the canonical remote Callout hash used by subsequent status checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '<div class="alert note">\n\nBase body.\n\n</div>';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const adapter: FeishuAdapter = {
      resolveDocumentId: async () => 'doc_token',
      fetchDocMarkdown: async () => ({
        markdown: '<callout emoji="📘">\nNotes\nBase body.\n</callout>',
        revision: 'rev-7'
      }),
      fetchDocBlocks: async () => ({ blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['callout1'] },
        {
          block_id: 'callout1',
          block_type: 19,
          callout: { emoji_id: '📘' },
          children: ['title1', 'body1']
        },
        textBlock('title1', 'Notes'),
        textBlock('body1', 'Base body.')
      ] }),
      replaceDocument: async () => {},
      createDocument: async () => ({ documentId: 'created' })
    };
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'none' as const,
      dialect: 'gfm' as const,
      dialectConfig: {},
      adapter
    };
    const review = await runBaselineAdopt({ ...common, apply: false });
    await runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: review.confirmationFingerprint
    });

    const status = await runStatus({
      cwd,
      sourcePath,
      target: common.target,
      profile: 'none',
      dialect: 'gfm',
      adapter
    });

    expect(status.remoteChanged).toBe(false);
    expect(status.state).toBe('clean');
  });

  it('recognizes already-applied text and Callout additions during baseline repair', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-applied-additions-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const baseline = 'Anchor.';
    const desired = 'Anchor.\n\nNew tail.\n\n<div class="alert warning">\n\nNew warning.\n\n</div>';
    await writeFile(sourcePath, desired, 'utf8');
    await writeFile(baselinePath, baseline, 'utf8');
    const adapter = readOnlyAdapter(desired, 'rev-3');
    adapter.fetchDocBlocks = async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: ['anchor', 'tail', 'warning'] },
      textBlock('anchor', 'Anchor.'),
      textBlock('tail', 'New tail.'),
      {
        block_id: 'warning',
        block_type: 19,
        callout: { emoji_id: '❗' },
        children: ['warning-title', 'warning-body']
      },
      textBlock('warning-title', 'Warning'),
      textBlock('warning-body', 'New warning.')
    ] });

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter
    });

    expect(result.safeToAdopt).toBe(true);
    expect(result.delta.blockers).toEqual([]);
    expect(result.delta.operations).toEqual([]);
  });

  it('fails closed when an existing receipt sidecar hash does not match', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');
    const bases = join(cwd, '.sync', 'feishu-md-sync', 'bases');
    await mkdir(bases, { recursive: true });
    await writeFile(join(bases, 'local.md'), 'tampered', 'utf8');
    await writeFile(join(bases, 'publish.md'), 'Old local guidance.', 'utf8');
    const remoteSerialized = `${JSON.stringify({ nodes: [] }, null, 2)}\n`;
    await writeFile(join(bases, 'remote.json'), remoteSerialized, 'utf8');
    await writePublishReceipt({
      cwd,
      receipt: {
        version: 4,
        target: { kind: 'docx', token: 'doc_token' },
        resolvedDocumentId: 'doc_token',
        profile: 'none',
        dialect: 'gfm',
        dialectDraftHash: hashText('Old local guidance.'),
        dialectDependencies: [],
        linkResolutionFingerprint: hashText('links'),
        resolvedLinks: [],
        localSourceHash: hashText('Old local guidance.'),
        publishDraftHash: hashText('Old local guidance.'),
        localBaseSnapshot: { path: '.sync/feishu-md-sync/bases/local.md', hash: hashText('expected') },
        publishBaseSnapshot: { path: '.sync/feishu-md-sync/bases/publish.md', hash: hashText('Old local guidance.') },
        remoteSemanticSnapshot: { path: '.sync/feishu-md-sync/bases/remote.json', hash: hashText(remoteSerialized) },
        remoteSnapshotHash: hashText('Remote authoring guidance.'),
        remoteRevision: 'rev-7',
        whiteboards: [],
        updatedAt: '2026-07-17T00:00:00.000Z'
      }
    });

    let thrown: unknown;
    try {
      await runBaselineAdopt({
        cwd,
        sourcePath,
        baseline: { kind: 'file', path: baselinePath },
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'none',
        dialect: 'gfm',
        dialectConfig: {},
        apply: false,
        adapter: readOnlyAdapter('Remote authoring guidance.', 'rev-7')
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringContaining('Local base snapshot hash mismatch'),
      details: {
        subtype: 'baseline_receipt_integrity',
        hint: expect.stringContaining('do not edit or delete receipt/sidecar files manually')
      }
    });
  });

  it('requires the dedicated baseline adoption fingerprint before local apply', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');

    const failure = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: true,
      adapter: readOnlyAdapter('Remote authoring guidance.', 'rev-7')
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).details).toMatchObject({
      type: 'confirmation_required',
      subtype: 'baseline_adoption',
      requiredFlags: ['--confirm-baseline-adoption <fingerprint>'],
      retryable: false
    });
  });

  it('returns typed validation when the selected local baseline file is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');

    const failure = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: join(cwd, 'missing.md') },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter: readOnlyAdapter('Remote authoring guidance.', 'rev-7')
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).details).toMatchObject({
      type: 'validation',
      subtype: 'baseline_source_missing'
    });
  });

  it('returns a typed conflict when the reviewed fingerprint does not match', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    await writeFile(sourcePath, 'New local guidance.', 'utf8');
    await writeFile(baselinePath, 'Old local guidance.', 'utf8');

    const failure = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: true,
      confirmationFingerprint: 'stale-review',
      adapter: readOnlyAdapter('Remote authoring guidance.', 'rev-7')
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliFailure);
    expect((failure as CliFailure).details).toMatchObject({
      type: 'conflict',
      subtype: 'baseline_confirmation_mismatch'
    });
  });

  it('blocks adoption when either baseline view resolves links to the public site', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const markdown = '[Other](other-page.md)';
    await writeFile(sourcePath, markdown, 'utf8');
    await writeFile(baselinePath, markdown, 'utf8');

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'milvus-authoring',
      dialectConfig: { publicSiteBaseUrl: 'https://milvus.io/docs' },
      apply: false,
      adapter: readOnlyAdapter('[Other](https://milvus.io/docs/other-page)', 'rev-7')
    });

    expect(result.safeToAdopt).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'public-link-fallback'
    }));
  });

  it('records and preserves verified Supademo mappings as a version 5 receipt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '<Supademo id="demo-id" title="" />\n\nAfter.';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const adapter = supademoAdapter('rev-7');
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'none' as const,
      dialect: 'zdoc-authoring' as const,
      dialectConfig: {},
      adapter
    };

    const firstReview = await runBaselineAdopt({ ...common, apply: false });
    expect(firstReview.safeToAdopt).toBe(true);
    expect(firstReview.protectedResources).toContainEqual(expect.objectContaining({
      componentId: 'demo-id',
      blockId: 'isv1'
    }));
    await runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: firstReview.confirmationFingerprint
    });
    await expect(readPublishReceipt({ cwd, target: common.target })).resolves.toMatchObject({
      version: 5,
      protectedResources: [expect.objectContaining({ componentId: 'demo-id', blockId: 'isv1' })]
    });

    const secondReview = await runBaselineAdopt({ ...common, apply: false });
    expect(secondReview.safeToAdopt).toBe(true);
    expect(secondReview.protectedResources).toContainEqual(expect.objectContaining({
      componentId: 'demo-id',
      blockId: 'isv1'
    }));
  });

  it('blocks ambiguous protected-resource correspondence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '## Demo\n\n<Supademo id="demo-id" title="" />\n\nAfter.';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const adapter = supademoAdapter('rev-7');
    adapter.fetchDocMarkdown = async () => ({
      markdown: '# A\n\n## Demo\n\n<readonly-block type="isv"></readonly-block>\n\nAfter.\n\n# B\n\n## Demo\n\n<readonly-block type="isv"></readonly-block>\n\nAfter.',
      revision: 'rev-7'
    });
    adapter.fetchDocBlocks = async () => ({
      blocks: [
        {
          block_id: 'doc_token',
          block_type: 1,
          children: [
            'heading-a', 'heading-demo-a', 'isv1', 'after-a',
            'heading-b', 'heading-demo-b', 'isv2', 'after-b'
          ]
        },
        headingBlock('heading-a', 3, 'A'),
        headingBlock('heading-demo-a', 4, 'Demo'),
        supademoBlock('isv1'),
        textBlock('after-a', 'After.'),
        headingBlock('heading-b', 3, 'B'),
        headingBlock('heading-demo-b', 4, 'Demo'),
        supademoBlock('isv2'),
        textBlock('after-b', 'After.')
      ]
    });

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'zdoc-authoring',
      dialectConfig: {},
      apply: false,
      adapter
    });

    expect(result.safeToAdopt).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'supademo-ambiguous'
    }));
  });

  it('preserves tracked Whiteboards only after remote identity and state verification', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '![Diagram](diagram.png)';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const remoteRaw = { nodes: [{ id: 'shape-1', type: 'text_shape', text: 'Diagram' }] };
    const target = { kind: 'docx' as const, token: 'doc_token' };
    await writeExistingReceiptBundle({
      cwd,
      target,
      local,
      remoteMarkdown: local,
      whiteboards: [{
        assetKey: 'diagram.png',
        pngPath: join(cwd, 'diagram.png'),
        svgPath: join(cwd, 'diagram.svg'),
        svgHash: hashText('<svg/>'),
        whiteboardToken: 'board-token',
        blockId: 'board-block',
        remoteStateHash: whiteboardRemoteStateHash(remoteRaw),
        placementFingerprint: semanticHash({
          locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
          previous: undefined,
          next: undefined
        })
      }]
    });
    const adapter = whiteboardAdapter(remoteRaw, 'rev-7');
    const common = {
      cwd,
      sourcePath,
      baseline: { kind: 'file' as const, path: baselinePath },
      target,
      profile: 'none' as const,
      dialect: 'gfm' as const,
      dialectConfig: {},
      adapter
    };

    const review = await runBaselineAdopt({ ...common, apply: false });
    expect(review.safeToAdopt).toBe(true);
    expect(review.whiteboards).toEqual([expect.objectContaining({
      assetKey: 'diagram.png',
      whiteboardToken: 'board-token'
    })]);
    await runBaselineAdopt({
      ...common,
      apply: true,
      confirmationFingerprint: review.confirmationFingerprint
    });
    await expect(readPublishReceipt({ cwd, target })).resolves.toMatchObject({
      whiteboards: [expect.objectContaining({ assetKey: 'diagram.png' })]
    });
  });

  it('blocks baseline repair when a tracked Whiteboard changed remotely', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '![Diagram](diagram.png)';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const target = { kind: 'docx' as const, token: 'doc_token' };
    await writeExistingReceiptBundle({
      cwd,
      target,
      local,
      remoteMarkdown: local,
      whiteboards: [{
        assetKey: 'diagram.png',
        pngPath: join(cwd, 'diagram.png'),
        svgPath: join(cwd, 'diagram.svg'),
        svgHash: hashText('<svg/>'),
        whiteboardToken: 'board-token',
        blockId: 'board-block',
        remoteStateHash: whiteboardRemoteStateHash({ nodes: [{ id: 'old' }] }),
        placementFingerprint: semanticHash({
          locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
          previous: undefined,
          next: undefined
        })
      }]
    });

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target,
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter: whiteboardAdapter({ nodes: [{ id: 'changed' }] }, 'rev-7')
    });

    expect(result.safeToAdopt).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'remote-whiteboard-changed',
      assetKey: 'diagram.png'
    }));
  });

  it('reports missing remote Code metadata as a structured blocker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fms-baseline-'));
    const sourcePath = join(cwd, 'doc.md');
    const baselinePath = join(cwd, 'doc-head.md');
    const local = '```python\nprint("hello")\n```';
    await writeFile(sourcePath, local, 'utf8');
    await writeFile(baselinePath, local, 'utf8');
    const adapter = readOnlyAdapter(local, 'rev-7');
    adapter.fetchDocBlocks = async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: ['code1'] },
      {
        block_id: 'code1',
        block_type: 14,
        code: {
          elements: [{ text_run: { content: 'print("hello")', text_element_style: {} } }],
          style: { language: 49 }
        }
      }
    ] });

    const result = await runBaselineAdopt({
      cwd,
      sourcePath,
      baseline: { kind: 'file', path: baselinePath },
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'none',
      dialect: 'gfm',
      dialectConfig: {},
      apply: false,
      adapter
    });

    expect(result.safeToAdopt).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({
      code: 'remote-code-metadata-unavailable'
    }));
  });
});

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout;
}

function readOnlyAdapter(markdown: string, revision: string, mutations: string[] = []): FeishuAdapter {
  return {
    resolveDocumentId: async () => 'doc_token',
    fetchDocMarkdown: async () => ({ markdown, revision }),
    fetchDocBlocks: async () => ({
      blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['p1'] },
        {
          block_id: 'p1',
          block_type: 2,
          text: {
            elements: [{ text_run: { content: markdown, text_element_style: {} } }]
          }
        }
      ]
    }),
    replaceDocument: async () => {
      mutations.push('replace-document');
    },
    replaceBlock: async () => { mutations.push('replace-block'); },
    insertBlocksAfter: async () => { mutations.push('insert-blocks'); },
    moveBlocksAfter: async () => { mutations.push('move-blocks'); },
    deleteBlocks: async () => { mutations.push('delete-blocks'); },
    createDocument: async () => {
      mutations.push('create-document');
      return { documentId: 'created' };
    }
  };
}

function twoParagraphAdapter(paragraphs: [string, string], revision: string): FeishuAdapter {
  return {
    resolveDocumentId: async () => 'doc_token',
    fetchDocMarkdown: async () => ({ markdown: paragraphs.join('\n\n'), revision }),
    fetchDocBlocks: async () => ({
      blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['p1', 'p2'] },
        textBlock('p1', paragraphs[0]),
        textBlock('p2', paragraphs[1])
      ]
    }),
    replaceDocument: async () => {},
    replaceBlock: async () => {},
    insertBlocksAfter: async () => {},
    deleteBlocks: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

function supademoAdapter(revision: string): FeishuAdapter {
  return {
    resolveDocumentId: async () => 'doc_token',
    fetchDocMarkdown: async () => ({
      markdown: '<readonly-block type="isv"></readonly-block>\n\nAfter.',
      revision
    }),
    fetchDocBlocks: async () => ({
      blocks: [
        { block_id: 'doc_token', block_type: 1, children: ['isv1', 'after'] },
        supademoBlock('isv1'),
        textBlock('after', 'After.')
      ]
    }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

function supademoBlock(blockId: string) {
  return {
    block_id: blockId,
    block_type: 40,
    add_ons: {
      component_type_id: 'blk_682093ba9580c002363b9dc3',
      record: '{"id":"demo-id","isShowcase":false}'
    }
  };
}

function whiteboardAdapter(raw: unknown, revision: string): FeishuAdapter {
  return {
    resolveDocumentId: async () => 'doc_token',
    fetchDocMarkdown: async () => ({ markdown: '![Diagram](diagram.png)', revision }),
    fetchDocBlocks: async () => ({ blocks: [
      { block_id: 'doc_token', block_type: 1, children: ['board-block'] },
      {
        block_id: 'board-block',
        block_type: 43,
        whiteboard: { token: 'board-token' }
      }
    ] }),
    queryWhiteboard: async () => ({ raw }),
    replaceDocument: async () => {},
    createDocument: async () => ({ documentId: 'created' })
  };
}

async function writeExistingReceiptBundle(input: {
  cwd: string;
  target: { kind: 'docx'; token: string };
  local: string;
  remoteMarkdown: string;
  whiteboards: WhiteboardReceiptEntry[];
}): Promise<void> {
  const bases = join(input.cwd, '.sync', 'feishu-md-sync', 'bases');
  await mkdir(bases, { recursive: true });
  const localPath = '.sync/feishu-md-sync/bases/local.md';
  const publishPath = '.sync/feishu-md-sync/bases/publish.md';
  const remotePath = '.sync/feishu-md-sync/bases/remote.json';
  const remoteSerialized = `${JSON.stringify({ nodes: [{
    kind: 'asset',
    locator: { sectionPath: [], kind: 'asset', ordinal: 0 },
    representation: 'whiteboard'
  }] }, null, 2)}\n`;
  await writeFile(join(input.cwd, localPath), input.local, 'utf8');
  await writeFile(join(input.cwd, publishPath), input.local, 'utf8');
  await writeFile(join(input.cwd, remotePath), remoteSerialized, 'utf8');
  await writePublishReceipt({
    cwd: input.cwd,
    receipt: {
      version: 4,
      target: input.target,
      resolvedDocumentId: input.target.token,
      profile: 'none',
      dialect: 'gfm',
      dialectDraftHash: hashText(input.local),
      dialectDependencies: [],
      linkResolutionFingerprint: hashText('links'),
      resolvedLinks: [],
      localSourceHash: hashText(input.local),
      publishDraftHash: hashText(input.local),
      localBaseSnapshot: { path: localPath, hash: hashText(input.local) },
      publishBaseSnapshot: { path: publishPath, hash: hashText(input.local) },
      remoteSemanticSnapshot: { path: remotePath, hash: hashText(remoteSerialized) },
      remoteSnapshotHash: hashText(input.remoteMarkdown),
      remoteRevision: 'rev-7',
      whiteboards: input.whiteboards,
      updatedAt: '2026-07-17T00:00:00.000Z'
    }
  });
}

function textBlock(blockId: string, content: string) {
  return {
    block_id: blockId,
    block_type: 2,
    text: {
      elements: [{ text_run: { content, text_element_style: {} } }]
    }
  };
}

function headingBlock(blockId: string, blockType: number, content: string) {
  const key = blockType === 3 ? 'heading1' : 'heading2';
  return {
    block_id: blockId,
    block_type: blockType,
    [key]: {
      elements: [{ text_run: { content, text_element_style: {} } }]
    }
  };
}
