import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';
import { parseFeishuTarget } from '../src/core/doc-id.js';
import { runDiff } from '../src/diff/run-diff.js';
import type { DialectWorkspaceConfig } from '../src/link-resolvers/types.js';
import { buildPublishContext } from '../src/publish/publish-context.js';
import { runPublish } from '../src/publish/run-publish.js';
import { runStatus } from '../src/status/run-status.js';

const sourcePath = process.env.FEISHU_MD_SYNC_DOGFOOD_SOURCE;
const targetUrl = process.env.FEISHU_MD_SYNC_DOGFOOD_TARGET;
const baseUrl = process.env.FEISHU_MD_SYNC_TEST_BASE;

describe.skipIf(!sourcePath || !targetUrl || !baseUrl)(
  'live Docusaurus release dogfood',
  () => {
    it('preprocesses the formal source and agrees across read-only commands', async () => {
      const cwd = process.cwd();
      const target = parseFeishuTarget(targetUrl!);
      if (target.kind === 'folder') throw new Error('dogfood target must be a document');
      const adapter = new LarkCliAdapter({ identity: 'user' });
      const dialectConfig: DialectWorkspaceConfig = {
        publicSiteBaseUrl: 'https://docs.zilliz.com/docs',
        linkResolver: {
          type: 'lark-base',
          baseUrl: baseUrl!,
          keyField: 'Slug',
          urlField: 'Docs',
          placementTypeField: 'Placement Type',
          referenceField: 'Ref Target Doc',
          acceptedPlacementTypes: ['canonical', 'ref']
        }
      };
      const localSource = await readFile(sourcePath!, 'utf8');
      const context = await buildPublishContext({
        cwd,
        sourcePath: sourcePath!,
        localSource,
        dialect: 'docusaurus',
        dialectConfig,
        profile: 'none',
        adapter
      });

      expect(context.dialectBlockers).toEqual([]);
      expect(context.dialectDraft).not.toContain('title: "Hugging Face | Cloud"');
      expect(context.dialectDraft).not.toMatch(/\\?\{#[A-Za-z0-9_-]+\}/);
      expect(context.dialectDraft).not.toMatch(/^ {0,3}#{1,6}\s+.*\\$/m);
      expect(context.resolvedLinks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          slug: 'integrate-with-model-providers',
          resolvedUrl: expect.stringMatching(
            /^https:\/\/[^/]+\.feishu\.cn\/wiki\/[A-Za-z0-9]+$/
          )
        })
      ]));

      const shared = {
        cwd,
        sourcePath: sourcePath!,
        target,
        dialect: 'docusaurus' as const,
        dialectConfig,
        profile: 'none' as const,
        adapter
      };
      const status = await runStatus(shared);
      const diff = await runDiff(shared);
      const publish = await runPublish({
        cwd,
        file: sourcePath!,
        target,
        dialect: 'docusaurus',
        dialectConfig,
        profile: 'none',
        write: false,
        create: false,
        strategy: 'auto',
        confirmDestructive: false,
        adapter
      });

      expect(status.dialect).toBe('docusaurus');
      expect(status.dialectBlockers).toEqual([]);
      expect(status.linkResolution.resolvedToFeishu).toBeGreaterThanOrEqual(1);
      expect(diff.dialect).toBe(status.dialect);
      expect(diff.status.linkResolutionFingerprint).toBe(status.linkResolutionFingerprint);
      expect(publish.mode).toBe('dry-run');
      expect(publish.plan.dialect).toBe(status.dialect);
      expect(publish.plan.linkResolutionFingerprint).toBe(status.linkResolutionFingerprint);
    }, 60_000);
  }
);
