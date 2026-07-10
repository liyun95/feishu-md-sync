import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import type { Command } from 'commander';
import { LarkCliAdapter } from '../../adapters/lark-cli-adapter.js';
import { loadSyncConfig, resolvePublishProfile } from '../../config/sync-config.js';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { hashSource } from '../../core/hash.js';
import type { FeishuClient } from '../../feishu/client.js';
import { createMarkdownEngine, type MarkdownEngine, type MarkdownEngineName } from '../../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions, type PublishTransformProfile } from '../../markdown/publish-transform.js';
import { FeishuBlockConvertClient } from '../../services/feishu/block-convert-client.js';
import { FeishuDocsContentClient } from '../../services/feishu/docs-content-client.js';
import { readReceipt, receiptPathFor, writeReceipt, type SyncReceipt } from '../../receipts/receipt.js';
import { buildAuthDoctorReport } from '../env.js';
import { runPublishNew } from '../../sync/publish-new.js';
import { publishNewHelpAfter, publishNewJson, publishNewSummaryLines } from '../../sync/publish-new-output.js';
import { runPull } from '../../pull/run-pull.js';
import { runStatus } from '../../status/run-status.js';
import { diffSummaryLines, runDiff } from '../../diff/run-diff.js';
import { runMerge, type RunMergeMode } from '../../merge/run-merge.js';
import { unifiedDiff } from '../../sync/diff.js';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../../sync/merge.js';
import { pullRemoteMarkdown, pullRemoteMarkdownWithState } from '../../sync/pull.js';
import { runSync, type SyncStrategy } from '../../sync/run-sync.js';
import type { ImageDimensions } from '../../sync/docx-v2-overwrite.js';
import { assertRequestedPushStrategy, buildPushPlan, type PushPlan, type PushStrategy } from '../../sync/push-plan.js';
import { getSyncStatus, type SyncStatusResult } from '../../sync/status.js';
import { renderRiskSummaryLines } from '../../sync/render-risk.js';
import { reviewDraftCheckSummaryLines } from '../../sync/review-draft-checks.js';
import type { CliContext } from '../context.js';
import {
  buildSyncOutputContext,
  formatSyncResultPretty,
  syncReceiptRunContext,
  type SyncOutputContext
} from '../sync-output.js';
import { printFormatted } from '../output.js';

type BaseCommandOptions = {
  host?: string;
  timeoutMs?: number;
};

type SyncCommandOptions = BaseCommandOptions & {
  format?: string;
  write?: boolean;
  yes?: boolean;
  strategy?: string;
  forceInitialOverwrite?: boolean;
  forceWholeDocumentSync?: boolean;
  publishProfile?: string;
  reviewProfile?: string;
  linkBaseUrl?: string;
  markdownEngine?: string;
  receiptDir?: string;
  writeBackend?: string;
  imageRootDir?: string;
  imageSize?: string[];
};

type PushCommandOptions = BaseCommandOptions & {
  format?: string;
  write?: boolean;
  yes?: boolean;
  strategy?: string;
  replaceAll?: boolean;
  forceWholeDocumentSync?: boolean;
  publishProfile?: string;
  reviewProfile?: string;
  linkBaseUrl?: string;
  scope?: string;
  insertSection?: string;
  beforeSection?: string;
  afterSection?: string;
  beforeHeading?: string;
  markdownEngine?: string;
  receiptDir?: string;
  writeBackend?: string;
  imageRootDir?: string;
  imageSize?: string[];
};

type PublishNewCommandOptions = BaseCommandOptions & {
  title?: string;
  wikiSpaceId?: string;
  wikiParent?: string;
  folderToken?: string;
  appOwned?: boolean;
  write?: boolean;
  yes?: boolean;
  allowDuplicateTitle?: boolean;
  publishProfile?: string;
  reviewProfile?: string;
  linkBaseUrl?: string;
  markdownEngine?: string;
  format?: string;
  receiptDir?: string;
};

type PullCommandOptions = BaseCommandOptions & {
  target?: string;
  output?: string;
  profile?: string;
  format?: string;
  markdownEngine?: string;
  overwrite?: boolean;
  writeReceipt?: boolean;
  receiptDir?: string;
};

type MergeCommandOptions = BaseCommandOptions & {
  target?: string;
  remote?: string;
  base?: string;
  profile?: string;
  check?: boolean;
  dryRun?: boolean;
  abort?: boolean;
  saveRemote?: string;
  output?: string;
  format?: string;
  markdownEngine?: string;
  receiptDir?: string;
};

type StatusCommandOptions = BaseCommandOptions & {
  target?: string;
  profile?: string;
  format?: string;
  publishProfile?: string;
  reviewProfile?: string;
  linkBaseUrl?: string;
  markdownEngine?: string;
  receiptDir?: string;
  verbose?: boolean;
};

type NormalizedSyncCommandOptions = SyncCommandOptions & Required<BaseCommandOptions> & {
  format: string;
  strategy: string;
  publishTransform?: PublishTransformOptions;
  markdownEngine: MarkdownEngineName;
  receiptDir?: string;
  writeBackend?: 'block-patch' | 'docx-v2-overwrite';
  imageRootDir?: string;
  imageDimensions?: Record<string, ImageDimensions>;
};

type NormalizedPushCommandOptions = Omit<PushCommandOptions, 'insertSection' | 'beforeSection' | 'afterSection' | 'beforeHeading'> & Required<BaseCommandOptions> & {
  format: string;
  strategy: PushStrategy;
  publishTransform?: PublishTransformOptions;
  insertSection?: {
    heading: string;
    relative: 'before' | 'after';
    targetHeading: string;
  };
  beforeHeading?: string;
  markdownEngine: MarkdownEngineName;
  receiptDir?: string;
  writeBackend?: 'block-patch' | 'docx-v2-overwrite';
  imageRootDir?: string;
  imageDimensions?: Record<string, ImageDimensions>;
};

type NormalizedPublishNewCommandOptions = PublishNewCommandOptions & Required<BaseCommandOptions> & {
  format: string;
  publishTransform?: PublishTransformOptions;
  markdownEngine: MarkdownEngineName;
  receiptDir?: string;
};

type PushCliDiagnostics = {
  appIdentity: string;
  envSource: string;
};

const DEFAULT_REVIEW_DRAFT_LINK_BASE_URL = 'https://milvus.io/docs/';

export function registerSyncCommands(program: Command, context: CliContext): void {
  program
    .name('feishu-md-sync')
    .description('Sync one local Markdown file to an existing Feishu document. Defaults to dry-run.')
    .argument('[markdown-file]', 'local Markdown file')
    .argument('[feishu-doc]', 'Feishu docx ID or URL')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--strategy <strategy>', 'conflict strategy: fail | local-wins | merge', 'fail')
    .option('--force-initial-overwrite', 'allow first write to replace an existing non-empty Feishu doc')
    .option('--force-whole-document-sync', 'allow whole-document sync when an active multisdk task exists')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--write-backend <backend>', 'write backend: block-patch | docx-v2-overwrite', 'block-patch')
    .option('--image-root-dir <dir>', 'base directory for absolute-style Markdown image paths when using docx-v2-overwrite')
    .option('--image-size <image=WIDTHxHEIGHT>', 'repeatable explicit image display size for docx-v2-overwrite', collectOption, [])
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--verbose', 'show status hash roles and raw hash values')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string | undefined, feishuDoc: string | undefined, opts: SyncCommandOptions) => {
      if (!markdownFile || !feishuDoc) {
        program.help();
        return;
      }
      await runSyncCommand(context, markdownFile, feishuDoc, normalizeSyncOptions(program, opts));
    });

  program
    .command('sync')
    .description('sync local Markdown to an existing Feishu docx document')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--strategy <strategy>', 'conflict strategy: fail | local-wins | merge', 'fail')
    .option('--force-initial-overwrite', 'allow first write to replace an existing non-empty Feishu doc')
    .option('--force-whole-document-sync', 'allow whole-document sync when an active multisdk task exists')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--write-backend <backend>', 'write backend: block-patch | docx-v2-overwrite', 'block-patch')
    .option('--image-root-dir <dir>', 'base directory for absolute-style Markdown image paths when using docx-v2-overwrite')
    .option('--image-size <image=WIDTHxHEIGHT>', 'repeatable explicit image display size for docx-v2-overwrite', collectOption, [])
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, feishuDoc: string, opts: SyncCommandOptions) => {
      await runSyncCommand(context, markdownFile, feishuDoc, normalizeSyncOptions(program, opts));
    });

  program
    .command('push')
    .description('push local Markdown changes to an existing Feishu document')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--scope <scope>', 'optional scope guard, for example heading:"FAQ"')
    .option('--insert-section <heading>', 'insert the named local heading section into the remote document')
    .option('--before-section <heading>', 'insert --insert-section before this existing remote heading')
    .option('--after-section <heading>', 'insert --insert-section after this existing remote heading section')
    .option('--before-heading <heading>', 'replace only content before this existing heading')
    .option('--strategy <strategy>', 'push strategy: auto | block-patch | section-replace | document-replace', 'auto')
    .option('--replace-all', 'allow document-replace writes to replace the existing Feishu document')
    .option('--force-whole-document-sync', 'allow whole-document push when an active multisdk task exists')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--write-backend <backend>', 'write backend: block-patch | docx-v2-overwrite', 'block-patch')
    .option('--image-root-dir <dir>', 'base directory for absolute-style Markdown image paths when using docx-v2-overwrite')
    .option('--image-size <image=WIDTHxHEIGHT>', 'repeatable explicit image display size for docx-v2-overwrite', collectOption, [])
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, feishuDoc: string, opts: PushCommandOptions) => {
      await runPushCommand(context, markdownFile, feishuDoc, normalizePushOptions(program, opts));
    });

  program
    .command('review-draft')
    .description('push a Milvus review draft to an existing Feishu document')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--scope <scope>', 'optional scope guard, for example heading:"FAQ"')
    .option('--strategy <strategy>', 'push strategy: auto | block-patch | section-replace | document-replace', 'auto')
    .option('--replace-all', 'allow document-replace writes to replace the existing Feishu document')
    .option('--force-whole-document-sync', 'allow whole-document push when an active multisdk task exists')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL', DEFAULT_REVIEW_DRAFT_LINK_BASE_URL)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'local')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, feishuDoc: string, opts: PushCommandOptions) => {
      await runPushCommand(context, markdownFile, feishuDoc, normalizePushOptions(program, reviewDraftDefaultsForCommand(opts)));
    });

  program
    .command('publish-new')
    .description('publish a local Markdown file to a new Feishu document')
    .argument('<markdown-file>', 'local Markdown file')
    .option('--title <title>', 'Feishu document title; defaults to first H1 or file basename')
    .option('--wiki-space-id <space-id>', 'Feishu wiki space ID for final placement')
    .option('--wiki-parent <node-token-or-url>', 'Feishu wiki parent node token or URL for final placement')
    .option('--folder-token <folder-token>', 'Feishu Drive folder token; required as staging folder for wiki publish')
    .option('--app-owned', 'create an app-owned docx without a Drive folder token')
    .option('--write', 'create the Feishu document; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--allow-duplicate-title', 'create even when same-title candidates already exist')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'local')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .addHelpText('after', publishNewHelpAfter())
    .action(async (markdownFile: string, opts: PublishNewCommandOptions) => {
      await runPublishNewCommand(context, markdownFile, normalizePublishNewOptions(program, opts));
    });

  program
    .command('status')
    .description('show local/remote publish status without writing; positional <feishu-doc> is legacy')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('[feishu-doc]', 'legacy Feishu docx ID or URL')
    .option('--target <url-or-token>', 'new-core Feishu/Lark docx or wiki URL/token')
    .option('--profile <profile>', 'publish profile for new-core status: zilliz | milvus | none')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (markdownFile: string, feishuDoc: string | undefined, opts: StatusCommandOptions) => {
      const normalized = normalizeStatusOptions(program, opts);
      if (normalized.target) {
        if (feishuDoc) throw new Error('Use either --target or legacy <feishu-doc>, not both.');
        const target = parseFeishuTarget(normalized.target);
        if (target.kind === 'folder') throw new Error('status --target does not support Drive folder targets.');
        const config = await loadSyncConfig({ cwd: process.cwd() });
        const profile = resolvePublishProfile({ cliProfile: normalized.profile, config });
        const status = await runStatus({
          cwd: process.cwd(),
          sourcePath: path.resolve(process.cwd(), markdownFile),
          target,
          profile,
          adapter: new LarkCliAdapter()
        });
        printFormatted(status, normalized.format);
        return;
      }

      if (!feishuDoc) throw new Error('status requires --target <doc> or legacy <feishu-doc>.');
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const status = await getSyncStatus(client, {
        sourcePath: markdownFile,
        documentId,
        publishTransform: normalized.publishTransform,
        markdownEngine: createCliMarkdownEngine(client, normalized.markdownEngine),
        receiptDir: normalized.receiptDir
      });
      printStatus(status, normalized.format, normalized.verbose);
    });

  program
    .command('pull')
    .description('export current Feishu/Lark content as a local Markdown snapshot')
    .argument('[feishu-doc]', 'legacy Feishu docx ID or URL')
    .option('--target <url-or-token>', 'new-core Feishu/Lark docx or wiki URL/token')
    .option('-o, --output <file>', 'write remote Markdown to a local file')
    .option('--profile <profile>', 'pull profile: zilliz | milvus | none')
    .option('--overwrite', 'allow pull to replace an existing output file')
    .option('--write-receipt', 'write a local baseline receipt after exporting to --output')
    .option('--format <format>', 'output format for new-core --target mode: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .action(async (feishuDoc: string | undefined, opts: PullCommandOptions) => {
      const normalized = normalizePullOptions(program, opts);
      if (normalized.target) {
        if (feishuDoc) throw new Error('Use either --target or legacy <feishu-doc>, not both.');
        if (!normalized.output) throw new Error('new-core pull requires --output <file>.');
        const target = parseFeishuTarget(normalized.target);
        if (target.kind === 'folder') throw new Error('pull --target does not support Drive folder targets.');
        const config = await loadSyncConfig({ cwd: process.cwd() });
        const profile = resolvePublishProfile({ cliProfile: normalized.profile, config });
        const result = await runPull({
          cwd: process.cwd(),
          target,
          outputPath: path.resolve(process.cwd(), normalized.output),
          profile,
          overwrite: normalized.overwrite === true,
          writeReceipt: normalized.writeReceipt === true,
          adapter: new LarkCliAdapter()
        });
        printFormatted(result, normalized.format);
        return;
      }

      if (!feishuDoc) throw new Error('pull requires --target <doc> or legacy <feishu-doc>.');
      if (normalized.writeReceipt && !normalized.output) {
        throw new Error('--write-receipt requires --output <file>.');
      }
      if (normalized.output) {
        await assertPullOutputWritable(normalized.output, normalized.overwrite === true);
      }
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const pulled = await pullRemoteMarkdownWithState(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      if (normalized.output) {
        await writeFile(normalized.output, pulled.markdown, 'utf8');
        console.log(`wrote: ${normalized.output}`);
        if (normalized.writeReceipt) {
          const statePath = receiptPathFor(process.cwd(), normalized.receiptDir, normalized.output, documentId);
          const receipt = await buildPullBaselineReceipt({
            sourcePath: normalized.output,
            sourceMarkdown: pulled.markdown,
            documentId,
            remoteHash: pulled.remoteHash,
            remoteBlockCount: pulled.remoteBlockCount,
            timestamp: new Date().toISOString()
          });
          await writeReceipt(statePath, receipt);
          console.log(`receipt: ${statePath}`);
          console.log('baseline: clean');
        }
        return;
      }
      stdout.write(pulled.markdown);
    });

  program
    .command('diff')
    .description('show a publish-draft diff against current Feishu/Lark content; positional <feishu-doc> is legacy')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('[feishu-doc]', 'legacy Feishu docx ID or URL')
    .option('--target <url-or-token>', 'new-core Feishu/Lark docx or wiki URL/token')
    .option('--profile <profile>', 'publish profile for new-core diff: zilliz | milvus | none')
    .option('--format <format>', 'output format for new-core --target mode: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--review-profile <profile>', 'apply a review-draft profile: milvus')
    .option('--link-base-url <url>', 'rewrite relative Markdown links against this absolute base URL')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .action(async (markdownFile: string, feishuDoc: string | undefined, opts: StatusCommandOptions) => {
      const normalized = normalizeStatusOptions(program, opts);
      if (normalized.target) {
        if (feishuDoc) throw new Error('Use either --target or legacy <feishu-doc>, not both.');
        const target = parseFeishuTarget(normalized.target);
        if (target.kind === 'folder') throw new Error('diff --target does not support Drive folder targets.');
        const config = await loadSyncConfig({ cwd: process.cwd() });
        const profile = resolvePublishProfile({ cliProfile: normalized.profile, config });
        const result = await runDiff({
          cwd: process.cwd(),
          sourcePath: path.resolve(process.cwd(), markdownFile),
          target,
          profile,
          adapter: new LarkCliAdapter()
        });
        if (normalized.format === 'json') {
          printFormatted(result, normalized.format);
          return;
        }
        for (const line of diffSummaryLines(result)) console.log(line);
        return;
      }

      if (!feishuDoc) throw new Error('diff requires --target <doc> or legacy <feishu-doc>.');
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const local = applyPublishTransform(await readFile(markdownFile, 'utf8'), normalized.publishTransform);
      const remote = await pullRemoteMarkdown(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      stdout.write(unifiedDiff(markdownFile, 'feishu', local, remote));
    });

  program
    .command('merge')
    .description('merge remote Feishu/Lark Markdown changes into a local Markdown file; positional <feishu-doc> is legacy')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('[feishu-doc]', 'legacy Feishu docx ID or URL')
    .option('--target <url-or-token>', 'new-core Feishu/Lark docx or wiki URL/token to fetch before merging')
    .option('--remote <file>', 'new-core local remote snapshot Markdown file')
    .option('--base <file>', 'new-core explicit merge base Markdown file')
    .option('--profile <profile>', 'new-core local authoring profile: milvus | zilliz | none')
    .option('--check', 'new-core check whether merge would conflict without writing')
    .option('--dry-run', 'new-core show merge metadata without writing')
    .option('--abort', 'new-core restore the local file from the previous merge state')
    .option('--save-remote <file>', 'new-core save fetched remote snapshot when using --target')
    .option('-o, --output <file>', 'legacy merged output path; defaults to <name>.merged.md next to local file')
    .option('--format <format>', 'output format for new-core mode: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--receipt-dir <dir>', 'write/read sync receipts directly in this directory')
    .action(async (markdownFile: string, feishuDoc: string | undefined, opts: MergeCommandOptions) => {
      if (isNewCoreMergeRequest(opts)) {
        if (feishuDoc) throw new Error('Use either new-core merge options or legacy <feishu-doc>, not both.');
        const config = await loadSyncConfig({ cwd: process.cwd() });
        const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
        const target = opts.target ? parseFeishuTarget(opts.target) : undefined;
        if (target?.kind === 'folder') throw new Error('merge --target does not support Drive folder targets.');
        const result = await runMerge({
          cwd: process.cwd(),
          filePath: path.resolve(process.cwd(), markdownFile),
          target,
          remotePath: opts.remote ? path.resolve(process.cwd(), opts.remote) : undefined,
          basePath: opts.base ? path.resolve(process.cwd(), opts.base) : undefined,
          saveRemotePath: opts.saveRemote ? path.resolve(process.cwd(), opts.saveRemote) : undefined,
          profile,
          mode: resolveMergeMode(opts),
          adapter: new LarkCliAdapter()
        });
        printFormatted(result, opts.format);
        if (result.state === 'conflict') process.exitCode = 1;
        return;
      }

      if (!feishuDoc) throw new Error('merge requires --target, --remote, --abort, or legacy <feishu-doc>.');
      const normalized = normalizePullOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const local = await readFile(markdownFile, 'utf8');
      const remote = await pullRemoteMarkdown(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      const statePath = receiptPathFor(process.cwd(), normalized.receiptDir, markdownFile, documentId);
      const receipt = await readReceipt(statePath);

      if (!receipt?.sourceSnapshot) {
        throw new Error('Cannot merge without a baseline receipt snapshot. Run a successful sync first, then retry merge.');
      }

      const result = threeWayMerge({
        base: receipt.sourceSnapshot,
        local,
        remote
      });
      const outputPath = normalized.output ?? defaultMergedPath(markdownFile);
      await writeFile(outputPath, result.content, 'utf8');
      stdout.write(buildMergeInstructions({
        clean: result.clean,
        outputPath,
        conflictCount: result.conflictCount,
        documentRef: feishuDoc
      }));
      if (!result.clean) {
        process.exitCode = 1;
      }
    });
}

function isNewCoreMergeRequest(opts: MergeCommandOptions): boolean {
  return Boolean(opts.target || opts.remote || opts.base || opts.profile || opts.check || opts.dryRun || opts.abort || opts.saveRemote);
}

function resolveMergeMode(opts: MergeCommandOptions): RunMergeMode {
  const selected = [opts.check, opts.dryRun, opts.abort].filter(Boolean).length;
  if (selected > 1) throw new Error('Choose only one of --check, --dry-run, or --abort.');
  if (opts.abort) return 'abort';
  if (opts.check) return 'check';
  if (opts.dryRun) return 'dry-run';
  return 'write';
}

function normalizeBaseOptions(program: Command, opts: BaseCommandOptions): Required<BaseCommandOptions> {
  const globals = program.opts<BaseCommandOptions>();
  const argvHost = optionFromArgv('--host');
  const argvTimeout = optionFromArgv('--timeout-ms');
  return {
    host: argvHost ?? commandOptionValue<string>(opts, 'host') ?? globals.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn',
    timeoutMs: argvTimeout ? parseIntOption(argvTimeout) : commandOptionValue<number>(opts, 'timeoutMs') ?? globals.timeoutMs ?? 20_000
  };
}

function normalizeSyncOptions(program: Command, opts: SyncCommandOptions): NormalizedSyncCommandOptions {
  const globals = program.opts<SyncCommandOptions>();
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile') ?? globals.publishProfile;
  const reviewProfile = optionFromArgv('--review-profile') ?? commandOptionValue<string>(opts, 'reviewProfile') ?? globals.reviewProfile;
  const linkBaseUrl = optionFromArgv('--link-base-url') ?? commandOptionValue<string>(opts, 'linkBaseUrl') ?? globals.linkBaseUrl;
  const publish = resolvePublishTransformOptions({ publishProfile, reviewProfile, linkBaseUrl });
  const strategy = optionFromArgv('--strategy') ?? commandOptionValue<string>(opts, 'strategy') ?? globals.strategy ?? 'fail';
  const imageSize = optionsFromArgv('--image-size', commandOptionValue<string[]>(opts, 'imageSize') ?? globals.imageSize ?? []);
  return {
    ...base,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? globals.format ?? 'pretty',
    write: flagFromArgv('--write') ?? commandOptionValue<boolean>(opts, 'write') ?? globals.write,
    yes: flagFromArgv('--yes') ?? flagFromArgv('-y') ?? commandOptionValue<boolean>(opts, 'yes') ?? globals.yes,
    strategy,
    forceInitialOverwrite: flagFromArgv('--force-initial-overwrite') ?? commandOptionValue<boolean>(opts, 'forceInitialOverwrite') ?? globals.forceInitialOverwrite,
    forceWholeDocumentSync: flagFromArgv('--force-whole-document-sync') ?? commandOptionValue<boolean>(opts, 'forceWholeDocumentSync') ?? globals.forceWholeDocumentSync,
    publishProfile: publish.publishProfile,
    reviewProfile,
    linkBaseUrl,
    publishTransform: publish.publishTransform,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'auto'),
    writeBackend: parseWriteBackend(optionFromArgv('--write-backend') ?? commandOptionValue<string>(opts, 'writeBackend') ?? globals.writeBackend ?? 'block-patch'),
    imageRootDir: optionFromArgv('--image-root-dir') ?? commandOptionValue<string>(opts, 'imageRootDir') ?? globals.imageRootDir,
    imageDimensions: parseImageDimensions(imageSize),
    receiptDir: optionFromArgv('--receipt-dir') ?? commandOptionValue<string>(opts, 'receiptDir') ?? globals.receiptDir
  };
}

function normalizePushOptions(program: Command, opts: PushCommandOptions): NormalizedPushCommandOptions {
  const globals = program.opts<PushCommandOptions>();
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile') ?? globals.publishProfile;
  const reviewProfile = optionFromArgv('--review-profile') ?? commandOptionValue<string>(opts, 'reviewProfile') ?? globals.reviewProfile;
  const linkBaseUrl = optionFromArgv('--link-base-url') ?? commandOptionValue<string>(opts, 'linkBaseUrl') ?? globals.linkBaseUrl;
  const publish = resolvePublishTransformOptions({ publishProfile, reviewProfile, linkBaseUrl });
  const scope = optionFromArgv('--scope') ?? commandOptionValue<string>(opts, 'scope') ?? globals.scope;
  const rawInsertSection = optionFromArgv('--insert-section') ?? commandOptionValue<string>(opts, 'insertSection') ?? globals.insertSection;
  const rawBeforeSection = optionFromArgv('--before-section') ?? commandOptionValue<string>(opts, 'beforeSection') ?? globals.beforeSection;
  const rawAfterSection = optionFromArgv('--after-section') ?? commandOptionValue<string>(opts, 'afterSection') ?? globals.afterSection;
  const beforeHeading = optionFromArgv('--before-heading') ?? commandOptionValue<string>(opts, 'beforeHeading') ?? globals.beforeHeading;
  const insertSection = parseInsertSectionOptions(rawInsertSection, rawBeforeSection, rawAfterSection);
  validateScopedOptions({ scope, insertSection, beforeHeading });
  const imageSize = optionsFromArgv('--image-size', commandOptionValue<string[]>(opts, 'imageSize') ?? globals.imageSize ?? []);
  return {
    ...base,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? globals.format ?? 'pretty',
    write: flagFromArgv('--write') ?? commandOptionValue<boolean>(opts, 'write') ?? globals.write,
    yes: flagFromArgv('--yes') ?? flagFromArgv('-y') ?? commandOptionValue<boolean>(opts, 'yes') ?? globals.yes,
    strategy: parsePushStrategy(optionFromArgv('--strategy') ?? commandOptionValue<string>(opts, 'strategy') ?? globals.strategy ?? 'auto'),
    replaceAll: flagFromArgv('--replace-all') ?? commandOptionValue<boolean>(opts, 'replaceAll') ?? globals.replaceAll,
    forceWholeDocumentSync: flagFromArgv('--force-whole-document-sync') ?? commandOptionValue<boolean>(opts, 'forceWholeDocumentSync') ?? globals.forceWholeDocumentSync,
    publishProfile: publish.publishProfile,
    reviewProfile,
    linkBaseUrl,
    publishTransform: publish.publishTransform,
    scope,
    insertSection,
    beforeHeading,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'auto'),
    writeBackend: parseWriteBackend(optionFromArgv('--write-backend') ?? commandOptionValue<string>(opts, 'writeBackend') ?? globals.writeBackend ?? 'block-patch'),
    imageRootDir: optionFromArgv('--image-root-dir') ?? commandOptionValue<string>(opts, 'imageRootDir') ?? globals.imageRootDir,
    imageDimensions: parseImageDimensions(imageSize),
    receiptDir: optionFromArgv('--receipt-dir') ?? commandOptionValue<string>(opts, 'receiptDir') ?? globals.receiptDir
  };
}

export function reviewDraftDefaultsForCommand(opts: PushCommandOptions): PushCommandOptions {
  return {
    ...opts,
    reviewProfile: 'milvus',
    linkBaseUrl: opts.linkBaseUrl ?? DEFAULT_REVIEW_DRAFT_LINK_BASE_URL,
    markdownEngine: opts.markdownEngine ?? 'local'
  };
}

function normalizePublishNewOptions(program: Command, opts: PublishNewCommandOptions): NormalizedPublishNewCommandOptions {
  const globals = program.opts<PublishNewCommandOptions>();
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile') ?? globals.publishProfile;
  const reviewProfile = optionFromArgv('--review-profile') ?? commandOptionValue<string>(opts, 'reviewProfile') ?? globals.reviewProfile;
  const linkBaseUrl = optionFromArgv('--link-base-url') ?? commandOptionValue<string>(opts, 'linkBaseUrl') ?? globals.linkBaseUrl;
  const publish = resolvePublishTransformOptions({ publishProfile, reviewProfile, linkBaseUrl });
  return {
    ...base,
    title: optionFromArgv('--title') ?? commandOptionValue<string>(opts, 'title') ?? globals.title,
    wikiSpaceId: optionFromArgv('--wiki-space-id') ?? commandOptionValue<string>(opts, 'wikiSpaceId') ?? globals.wikiSpaceId,
    wikiParent: optionFromArgv('--wiki-parent') ?? commandOptionValue<string>(opts, 'wikiParent') ?? globals.wikiParent,
    folderToken: optionFromArgv('--folder-token') ?? commandOptionValue<string>(opts, 'folderToken') ?? globals.folderToken,
    appOwned: flagFromArgv('--app-owned') ?? commandOptionValue<boolean>(opts, 'appOwned') ?? globals.appOwned,
    write: flagFromArgv('--write') ?? commandOptionValue<boolean>(opts, 'write') ?? globals.write,
    yes: flagFromArgv('--yes') ?? flagFromArgv('-y') ?? commandOptionValue<boolean>(opts, 'yes') ?? globals.yes,
    allowDuplicateTitle: flagFromArgv('--allow-duplicate-title') ?? commandOptionValue<boolean>(opts, 'allowDuplicateTitle') ?? globals.allowDuplicateTitle,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? globals.format ?? 'pretty',
    publishProfile: publish.publishProfile,
    reviewProfile,
    linkBaseUrl,
    publishTransform: publish.publishTransform,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'local'),
    receiptDir: optionFromArgv('--receipt-dir') ?? commandOptionValue<string>(opts, 'receiptDir') ?? globals.receiptDir
  };
}

function normalizeStatusOptions(
  program: Command,
  opts: StatusCommandOptions
): StatusCommandOptions & Required<BaseCommandOptions> & { format: string; publishTransform?: PublishTransformOptions; markdownEngine: MarkdownEngineName; receiptDir?: string; verbose?: boolean } {
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile');
  const reviewProfile = optionFromArgv('--review-profile') ?? commandOptionValue<string>(opts, 'reviewProfile');
  const linkBaseUrl = optionFromArgv('--link-base-url') ?? commandOptionValue<string>(opts, 'linkBaseUrl');
  const publish = resolvePublishTransformOptions({ publishProfile, reviewProfile, linkBaseUrl });
  return {
    ...base,
    target: optionFromArgv('--target') ?? commandOptionValue<string>(opts, 'target'),
    profile: optionFromArgv('--profile') ?? commandOptionValue<string>(opts, 'profile'),
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? 'pretty',
    publishProfile: publish.publishProfile,
    reviewProfile,
    linkBaseUrl,
    publishTransform: publish.publishTransform,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? 'auto'),
    receiptDir: optionFromArgv('--receipt-dir') ?? commandOptionValue<string>(opts, 'receiptDir'),
    verbose: flagFromArgv('--verbose') ?? commandOptionValue<boolean>(opts, 'verbose')
  };
}

function normalizePullOptions(program: Command, opts: PullCommandOptions): PullCommandOptions & Required<BaseCommandOptions> & { format: string; markdownEngine: MarkdownEngineName; receiptDir?: string } {
  const base = normalizeBaseOptions(program, opts);
  return {
    ...base,
    target: optionFromArgv('--target') ?? commandOptionValue<string>(opts, 'target'),
    output: optionFromArgv('--output') ?? optionFromArgv('-o') ?? commandOptionValue<string>(opts, 'output'),
    profile: optionFromArgv('--profile') ?? commandOptionValue<string>(opts, 'profile'),
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? 'pretty',
    overwrite: flagFromArgv('--overwrite') ?? commandOptionValue<boolean>(opts, 'overwrite'),
    writeReceipt: flagFromArgv('--write-receipt') ?? commandOptionValue<boolean>(opts, 'writeReceipt'),
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? 'auto'),
    receiptDir: optionFromArgv('--receipt-dir') ?? commandOptionValue<string>(opts, 'receiptDir')
  };
}

function commandOptionValue<T>(opts: unknown, key: string): T | undefined {
  if (opts && typeof opts === 'object') {
    const record = opts as Record<string, unknown>;
    const optionReader = record.getOptionValue;
    if (typeof optionReader === 'function') {
      return optionReader.call(opts, key) as T | undefined;
    }

    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key] as T;
    }

    const optsReader = record.opts;
    if (typeof optsReader === 'function') {
      return (optsReader.call(opts) as Record<string, T | undefined>)[key];
    }
  }
  return undefined;
}

function optionFromArgv(name: string): string | undefined {
  for (let index = process.argv.length - 1; index >= 0; index -= 1) {
    const arg = process.argv[index];
    if (arg === name) return process.argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function optionsFromArgv(name: string, fallback: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values.length > 0 ? values : fallback;
}

function flagFromArgv(name: string): boolean | undefined {
  return process.argv.includes(name) ? true : undefined;
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

async function runSyncCommand(context: CliContext, markdownFile: string, feishuDoc: string, opts: NormalizedSyncCommandOptions): Promise<void> {
  const strategy = parseStrategy(opts.strategy);
  const client = context.createFeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
  const documentId = await resolveDocumentId(client, feishuDoc);
  const outputContext = buildSyncOutputContext({
    auth: {
      ...buildAuthDoctorReport(context.envLoadReport),
      feishuHost: opts.host
    },
    publishTransform: opts.publishTransform
  });
  const confirm = async (question: string): Promise<boolean> => {
    const rl = readline.createInterface({ input, output: stdout });
    const answer = await rl.question(`${question} [y/N] `);
    rl.close();
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  };

  const result = await runSync(client, {
    sourcePath: markdownFile,
    documentId,
    dryRun: !opts.write,
    yes: opts.yes,
    strategy,
    forceInitialOverwrite: opts.forceInitialOverwrite,
    forceWholeDocumentSync: opts.forceWholeDocumentSync,
    publishTransform: opts.publishTransform,
    markdownEngine: createCliMarkdownEngine(client, opts.markdownEngine),
    writeBackend: opts.writeBackend,
    imageRootDir: opts.imageRootDir,
    imageDimensions: opts.imageDimensions,
    receiptDir: opts.receiptDir,
    confirm,
    runContext: syncReceiptRunContext(outputContext)
  });

  printResult(result, opts.format, outputContext);
}

async function runPushCommand(context: CliContext, markdownFile: string, feishuDoc: string, opts: NormalizedPushCommandOptions): Promise<void> {
  const scope = parsePushScope(opts.scope);
  const hasScopedOperation = Boolean(scope.section || opts.insertSection || opts.beforeHeading);
  if (opts.strategy === 'section-replace' && !hasScopedOperation) {
    throw new Error('--strategy section-replace requires --scope heading:"<heading>" or another scoped operation.');
  }
  if (opts.strategy === 'document-replace' && hasScopedOperation) {
    throw new Error('--strategy document-replace cannot be combined with scoped push options.');
  }

  const client = context.createFeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
  const documentId = await resolveDocumentId(client, feishuDoc);
  const markdownEngine = createCliMarkdownEngine(client, opts.markdownEngine);
  const outputContext = buildSyncOutputContext({
    auth: {
      ...buildAuthDoctorReport(context.envLoadReport),
      feishuHost: opts.host
    },
    publishTransform: opts.publishTransform
  });
  const planResult = await runSync(client, {
    sourcePath: markdownFile,
    documentId,
    dryRun: true,
    yes: true,
    strategy: 'fail',
    forceDocumentReplace: opts.strategy === 'document-replace',
    forceWholeDocumentSync: opts.forceWholeDocumentSync,
    publishTransform: opts.publishTransform,
    section: scope.section,
    insertSection: opts.insertSection,
    beforeHeading: opts.beforeHeading,
    sectionPatchMode: opts.strategy === 'section-replace' ? 'section-replace' : 'auto',
    markdownEngine,
    writeBackend: opts.writeBackend,
    imageRootDir: opts.imageRootDir,
    imageDimensions: opts.imageDimensions,
    receiptDir: opts.receiptDir,
    runContext: syncReceiptRunContext(outputContext)
  });
  const plan = buildPushPlan(planResult);
  assertRequestedPushStrategy(plan, opts.strategy);

  if (!opts.write) {
    printPushResult(plan, planResult, opts.format, pushCliDiagnostics(context));
    return;
  }

  if (plan.selectedStrategy === 'document-replace' && !opts.replaceAll) {
    printPushResult(plan, planResult, opts.format, pushCliDiagnostics(context));
    throw new Error('Refusing document-replace write without --replace-all.');
  }

  const confirm = async (question: string): Promise<boolean> => {
    const rl = readline.createInterface({ input, output: stdout });
    const answer = await rl.question(`${question} [y/N] `);
    rl.close();
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  };

  const writeResult = await runSync(client, {
    sourcePath: markdownFile,
    documentId,
    dryRun: false,
    yes: opts.yes,
    strategy: 'fail',
    forceInitialOverwrite: plan.selectedStrategy === 'document-replace' && opts.replaceAll,
    forceDocumentReplace: plan.selectedStrategy === 'document-replace',
    forceWholeDocumentSync: opts.forceWholeDocumentSync,
    publishTransform: opts.publishTransform,
    section: scope.section,
    insertSection: opts.insertSection,
    beforeHeading: opts.beforeHeading,
    sectionPatchMode: plan.selectedStrategy === 'section-replace' ? 'section-replace' : 'auto',
    markdownEngine,
    writeBackend: opts.writeBackend,
    imageRootDir: opts.imageRootDir,
    imageDimensions: opts.imageDimensions,
    receiptDir: opts.receiptDir,
    confirm,
    runContext: syncReceiptRunContext(outputContext)
  });
  printPushResult(buildPushPlan(writeResult), writeResult, opts.format, pushCliDiagnostics(context));
}

async function runPublishNewCommand(context: CliContext, markdownFile: string, opts: NormalizedPublishNewCommandOptions): Promise<void> {
  const client = context.createFeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
  const markdownEngine = createCliMarkdownEngine(client, opts.markdownEngine);
  const confirm = async (question: string): Promise<boolean> => {
    const rl = readline.createInterface({ input, output: stdout });
    const answer = await rl.question(`${question} [y/N] `);
    rl.close();
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  };

  const result = await runPublishNew(client, {
    sourcePath: markdownFile,
    options: {
      title: opts.title,
      wikiSpaceId: opts.wikiSpaceId,
      wikiParent: opts.wikiParent,
      folderToken: opts.folderToken,
      appOwned: opts.appOwned,
      allowDuplicateTitle: opts.allowDuplicateTitle
    },
    env: process.env,
    write: opts.write,
    yes: opts.yes,
    publishTransform: opts.publishTransform,
    markdownEngine,
    receiptDir: opts.receiptDir,
    confirm
  });

  if (opts.format === 'json') {
    console.log(publishNewJson(result));
    return;
  }

  for (const line of publishNewSummaryLines(result)) {
    console.log(line);
  }
  for (const warning of result.markdownEngineWarnings) {
    console.warn(`warning: ${warning}`);
  }
}

async function resolveDocumentId(client: FeishuClient, feishuDoc: string): Promise<string> {
  const target = parseFeishuTarget(feishuDoc);
  return target.kind === 'wiki' ? await client.resolveWikiNode(target.token) : target.token;
}

function parseStrategy(value: string): SyncStrategy {
  if (value === 'fail' || value === 'local-wins' || value === 'merge') {
    return value;
  }
  throw new Error(`Invalid --strategy ${value}. Expected fail, local-wins, or merge.`);
}

function parsePushStrategy(value: string): PushStrategy {
  if (value === 'auto' || value === 'block-patch' || value === 'section-replace' || value === 'document-replace') {
    return value;
  }
  throw new Error(`Invalid --strategy ${value}. Expected auto, block-patch, section-replace, or document-replace.`);
}

function parsePushScope(value: string | undefined): { section?: string } {
  if (!value) return {};
  const headingPrefix = 'heading:';
  if (!value.startsWith(headingPrefix)) {
    throw new Error(`Invalid --scope ${value}. Expected heading:"<heading>".`);
  }
  const rawHeading = value.slice(headingPrefix.length).trim();
  const heading = stripMatchingQuotes(rawHeading);
  if (!heading) {
    throw new Error(`Invalid --scope ${value}. Heading must not be empty.`);
  }
  return { section: heading };
}

function stripMatchingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function resolvePublishTransformOptions(input: {
  publishProfile?: string;
  reviewProfile?: string;
  linkBaseUrl?: string;
}): { publishProfile?: string; publishTransform?: PublishTransformOptions } {
  if (input.publishProfile && input.reviewProfile && input.publishProfile !== input.reviewProfile) {
    throw new Error(`--publish-profile ${input.publishProfile} conflicts with --review-profile ${input.reviewProfile}.`);
  }

  if (input.reviewProfile && input.reviewProfile !== 'milvus') {
    throw new Error(`Invalid --review-profile ${input.reviewProfile}. Expected milvus.`);
  }

  const publishProfile = input.publishProfile ?? input.reviewProfile;
  const profileTransform = parsePublishTransform(publishProfile);
  if (!profileTransform && !input.linkBaseUrl) {
    return { publishProfile, publishTransform: undefined };
  }

  return {
    publishProfile,
    publishTransform: {
      ...profileTransform,
      ...(input.reviewProfile ? { reviewDraft: true } : {}),
      ...(input.linkBaseUrl ? { linkBaseUrl: input.linkBaseUrl } : {})
    }
  };
}

function parsePublishTransform(value: string | undefined): PublishTransformOptions | undefined {
  if (!value) return undefined;
  if (value === 'milvus') {
    return { profile: value as PublishTransformProfile };
  }
  throw new Error(`Invalid --publish-profile ${value}. Expected milvus.`);
}

function parseMarkdownEngine(value: string): MarkdownEngineName {
  if (value === 'auto' || value === 'official' || value === 'local') return value;
  throw new Error(`Invalid --markdown-engine ${value}. Expected auto, official, or local.`);
}

function parseWriteBackend(value: string): 'block-patch' | 'docx-v2-overwrite' {
  if (value === 'block-patch' || value === 'docx-v2-overwrite') return value;
  throw new Error(`Invalid --write-backend ${value}. Expected block-patch or docx-v2-overwrite.`);
}

function parseImageDimensions(values: string[]): Record<string, ImageDimensions> | undefined {
  if (values.length === 0) return undefined;
  const dimensions: Record<string, ImageDimensions> = {};
  for (const value of values) {
    const match = value.match(/^(.+?)=(\d+)x(\d+)$/);
    if (!match) {
      throw new Error(`Invalid --image-size ${value}. Expected image=WIDTHxHEIGHT, for example /img/diagram.svg=900x393.`);
    }
    dimensions[stripMatchingQuotes(match[1].trim())] = {
      width: Number(match[2]),
      height: Number(match[3])
    };
  }
  return dimensions;
}

function parseInsertSectionOptions(
  heading: string | undefined,
  beforeSection: string | undefined,
  afterSection: string | undefined
): NormalizedPushCommandOptions['insertSection'] | undefined {
  if (!heading && !beforeSection && !afterSection) return undefined;
  if (!heading) {
    throw new Error('--before-section and --after-section require --insert-section.');
  }
  if (beforeSection && afterSection) {
    throw new Error('--insert-section requires only one of --before-section or --after-section.');
  }
  if (!beforeSection && !afterSection) {
    throw new Error('--insert-section requires --before-section or --after-section.');
  }
  return {
    heading,
    relative: beforeSection ? 'before' : 'after',
    targetHeading: beforeSection ?? afterSection ?? ''
  };
}

function validateScopedOptions(input: {
  scope?: string;
  insertSection?: NormalizedPushCommandOptions['insertSection'];
  beforeHeading?: string;
}): void {
  const selected = [
    input.scope ? '--scope' : '',
    input.insertSection ? '--insert-section' : '',
    input.beforeHeading ? '--before-heading' : ''
  ].filter(Boolean);
  if (selected.length > 1) {
    throw new Error(`Scoped push options are mutually exclusive: ${selected.join(', ')}.`);
  }
}

function createCliMarkdownEngine(client: FeishuClient, mode: MarkdownEngineName): MarkdownEngine {
  const request = client.request.bind(client);
  const docsContent = new FeishuDocsContentClient(request);
  const blockConvert = new FeishuBlockConvertClient(request);
  return createMarkdownEngine({
    mode,
    official: {
      getMarkdownContent: docsContent.getMarkdownContent.bind(docsContent),
      markdownToBlocks: blockConvert.markdownToBlocks.bind(blockConvert)
    }
  });
}

function printResult(result: Awaited<ReturnType<typeof runSync>>, format = 'pretty', context?: SyncOutputContext): void {
  if (format === 'json') {
    console.log(JSON.stringify(context ? { ...result, context } : result, null, 2));
    return;
  }
  if (context) {
    console.log(formatSyncResultPretty(result, context));
  } else {
    for (const line of syncResultSummaryLines(result)) {
      console.log(line);
    }
  }

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
}

function printPushResult(
  plan: PushPlan,
  result: Awaited<ReturnType<typeof runSync>>,
  format = 'pretty',
  diagnostics?: PushCliDiagnostics
): void {
  if (format === 'json') {
    console.log(JSON.stringify({ pushPlan: plan, syncResult: result, cliDiagnostics: diagnostics }, null, 2));
    return;
  }

  for (const line of pushResultSummaryLines(plan, result, diagnostics)) {
    console.log(line);
  }

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
}

export function pushResultSummaryLines(
  plan: PushPlan,
  result: Awaited<ReturnType<typeof runSync>>,
  diagnostics?: PushCliDiagnostics
): string[] {
  const changeLabel = result.mode === 'write' ? 'Applied Feishu changes:' : 'Planned Feishu changes:';
  const lines = [
    'Intent: push local Markdown to Feishu',
    `Selected strategy: ${plan.selectedStrategy}`,
    `Scope: ${plan.scope}`,
    `Risk: ${plan.risk}`,
    '',
    changeLabel,
    `- update ${plan.updates} blocks`,
    `- create ${plan.creates} blocks`,
    `- delete ${plan.deletes} blocks`
  ];

  if (plan.fallbackReason) {
    lines.push('', `Why: block-level patch is unsafe because ${plan.fallbackReason}.`);
  }

  const hasDryRunDiagnostics = result.markdownEngine || diagnostics || result.renderRisk || result.publishTransforms || result.reviewDraftChecks;
  if (result.mode === 'dry-run' && hasDryRunDiagnostics) {
    lines.push('');
    if (result.markdownEngine) {
      lines.push(`Markdown engine: ${result.markdownEngine.requested} -> ${result.markdownEngine.import}`);
    }
    if (diagnostics) {
      lines.push(`App identity: ${diagnostics.appIdentity}`);
      lines.push(`Env source: ${diagnostics.envSource}`);
    }
    if (result.publishTransforms) {
      lines.push(`Transforms: ${result.publishTransforms.length > 0 ? result.publishTransforms.join(', ') : 'none'}`);
    }
    if (result.renderRisk) {
      lines.push(...renderRiskSummaryLines(result.renderRisk));
    }
    if (result.reviewDraftChecks) {
      lines.push(...reviewDraftCheckSummaryLines(result.reviewDraftChecks));
    }
  }

  if (result.mode === 'dry-run') {
    lines.push('', plan.approvalMessage);
  }

  if (result.mode === 'write') {
    lines.push(`Readback verification: ${result.receipt.verificationResult.ok ? 'passed' : 'failed'}`);
    if (result.docxV2) {
      const verification = result.docxV2.verification;
      lines.push(`Docs v2 table readback: ${verification.tablesReadback}/${verification.tablesExpected}`);
      lines.push(`Docs v2 media readback: ${verification.mediaReadback}/${verification.mediaExpected}`);
    }
    if (result.receiptWritten) {
      lines.push(`Receipt: ${result.receiptPath}`);
    }
  }

  return lines;
}

function pushCliDiagnostics(context: CliContext): PushCliDiagnostics {
  const auth = buildAuthDoctorReport(context.envLoadReport);
  return {
    appIdentity: auth.appId.preview ? `APP_ID ${auth.appId.preview}` : 'APP_ID not set',
    envSource: context.envLoadReport.loadedFiles.length > 0 ? context.envLoadReport.loadedFiles.join(', ') : 'process env only'
  };
}

export function syncResultSummaryLines(result: Awaited<ReturnType<typeof runSync>>): string[] {
  const lines = [
    `${result.mode}: ${result.patchPlan.operation}`,
    `source blocks: ${result.receipt.blockCounts.source}`,
    `feishu blocks: ${result.receipt.blockCounts.feishuBefore} -> ${result.receipt.blockCounts.feishuAfter}`,
    `desired hash: ${result.patchPlan.desiredHash}`
  ];

  if (result.patchPlan.section) {
    const section = result.patchPlan.section;
    lines.push(`section: ${section.title}`);
    lines.push(`section range: remote ${section.remoteStartIndex}-${section.remoteEndIndex}, local ${section.localStartIndex}-${section.localEndIndex}`);
  }
  const blockLevelPatch = result.blockLevelDocumentPatch ?? result.blockLevelSectionPatch;
  if (blockLevelPatch) {
    const operations = blockLevelPatch.operations;
    lines.push('patch mode: block-level');
    lines.push(`block updates: ${operations.filter((operation) => operation.kind === 'update').length}`);
    lines.push(`block creates: ${operations.filter((operation) => operation.kind === 'create').length}`);
    lines.push(`block deletes: ${operations.filter((operation) => operation.kind === 'delete').length}`);
    if (blockLevelPatch.fallbackReason) {
      lines.push(`block fallback: ${blockLevelPatch.fallbackReason}`);
    }
    if (blockLevelPatch.unsafeForWrite) {
      lines.push('block fallback write: unsafe');
    }
  }
  if (result.patchPlan.operation === 'replace-contiguous-blocks') {
    lines.push(`remote range: ${result.patchPlan.remoteStartIndex}..${result.patchPlan.remoteEndIndex}`);
    lines.push(`local range: ${result.patchPlan.localStartIndex}..${result.patchPlan.localEndIndex}`);
  }
  const usesSafeBlockLevelPatch = Boolean(blockLevelPatch && blockLevelPatch.unsafeForWrite !== true);
  if (result.patchPlan.operation !== 'noop' && !usesSafeBlockLevelPatch) {
    lines.push(`will delete: ${result.patchPlan.deleteCount}`);
    lines.push(`will create: ${result.patchPlan.createCount}`);
  }
  if (result.docxV2) {
    const verification = result.docxV2.verification;
    lines.push('write backend: docx-v2-overwrite');
    lines.push(`table readback: ${verification.tablesReadback}/${verification.tablesExpected}`);
    lines.push(`media readback: ${verification.mediaReadback}/${verification.mediaExpected}`);
  }

  if (result.mode === 'write' && result.receiptWritten) {
    lines.push(`receipt: ${result.receiptPath}`);
  }

  return lines;
}

function printStatus(status: SyncStatusResult, format = 'pretty', verbose = false): void {
  if (format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  for (const line of statusSummaryLines(status, { verbose })) {
    console.log(line);
  }
}

export function statusSummaryLines(status: SyncStatusResult, options: { verbose?: boolean } = {}): string[] {
  const lines = [
    `state: ${status.state}`,
    `local changed: ${status.localChanged}`,
    `remote changed: ${status.remoteChanged}`,
    `receipt: ${status.receiptPath}`
  ];

  if (options.verbose) {
    lines.push(
      `source hash: ${status.sourceHash} (transformed Markdown source)`,
      `desired hash: ${status.desiredHash} (Feishu blocks generated from source)`,
      `remote hash: ${status.currentRemoteHash} (current Feishu blocks)`
    );
  } else {
    lines.push('hashes: hidden (use --verbose to show source, desired, and remote hashes)');
  }

  return lines;
}

export async function assertPullOutputWritable(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    await readFile(outputPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!overwrite) {
    throw new Error(
      `Refusing to overwrite existing output without --overwrite: ${outputPath}\n` +
      'Preview first with a separate *.remote.md output, review the diff, then rerun with --overwrite if replacement is intended.'
    );
  }
}

export type PullBaselineReceiptInput = {
  sourcePath: string;
  sourceMarkdown: string;
  documentId: string;
  remoteHash: string;
  remoteBlockCount: number;
  timestamp: string;
};

export async function buildPullBaselineReceipt(input: PullBaselineReceiptInput): Promise<SyncReceipt> {
  return {
    sourcePath: path.resolve(input.sourcePath),
    sourceHash: hashSource(input.sourceMarkdown),
    sourceSnapshot: input.sourceMarkdown,
    feishuDocId: input.documentId,
    feishuStateHash: input.remoteHash,
    feishuMarkdownSnapshot: input.sourceMarkdown,
    timestamp: input.timestamp,
    blockCounts: {
      source: input.remoteBlockCount,
      feishuBefore: input.remoteBlockCount,
      feishuAfter: input.remoteBlockCount
    },
    warnings: ['Receipt created by read-only baseline pull; no Feishu write was performed.'],
    writeResult: {
      mode: 'dry-run',
      deleted: 0,
      created: 0,
      updated: 0,
      skipped: true
    },
    verificationResult: {
      ok: true,
      expectedHash: input.remoteHash,
      actualHash: input.remoteHash
    }
  };
}
