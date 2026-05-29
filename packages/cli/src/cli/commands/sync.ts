import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { hashSource } from '../../core/hash.js';
import type { FeishuClient } from '../../feishu/client.js';
import { createMarkdownEngine, type MarkdownEngine, type MarkdownEngineName } from '../../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions, type PublishTransformProfile } from '../../markdown/publish-transform.js';
import { FeishuBlockConvertClient } from '../../services/feishu/block-convert-client.js';
import { FeishuDocsContentClient } from '../../services/feishu/docs-content-client.js';
import { readReceipt, receiptPath, writeReceipt, type SyncReceipt } from '../../receipts/receipt.js';
import { runPublishNew } from '../../sync/publish-new.js';
import { publishNewHelpAfter, publishNewJson, publishNewSummaryLines } from '../../sync/publish-new-output.js';
import { unifiedDiff } from '../../sync/diff.js';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../../sync/merge.js';
import { pullRemoteMarkdown, pullRemoteMarkdownWithState } from '../../sync/pull.js';
import { runSync, type SyncStrategy } from '../../sync/run-sync.js';
import { assertRequestedPushStrategy, buildPushPlan, type PushPlan, type PushStrategy } from '../../sync/push-plan.js';
import { getSyncStatus, type SyncStatusResult } from '../../sync/status.js';
import type { CliContext } from '../context.js';

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
  markdownEngine?: string;
};

type PushCommandOptions = BaseCommandOptions & {
  format?: string;
  write?: boolean;
  yes?: boolean;
  strategy?: string;
  replaceAll?: boolean;
  forceWholeDocumentSync?: boolean;
  publishProfile?: string;
  scope?: string;
  markdownEngine?: string;
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
  markdownEngine?: string;
  format?: string;
};

type PullCommandOptions = BaseCommandOptions & {
  output?: string;
  markdownEngine?: string;
  overwrite?: boolean;
  writeReceipt?: boolean;
};

type StatusCommandOptions = BaseCommandOptions & {
  format?: string;
  publishProfile?: string;
  markdownEngine?: string;
};

type NormalizedSyncCommandOptions = SyncCommandOptions & Required<BaseCommandOptions> & {
  format: string;
  strategy: string;
  publishTransform?: PublishTransformOptions;
  markdownEngine: MarkdownEngineName;
};

type NormalizedPushCommandOptions = PushCommandOptions & Required<BaseCommandOptions> & {
  format: string;
  strategy: PushStrategy;
  publishTransform?: PublishTransformOptions;
  markdownEngine: MarkdownEngineName;
};

type NormalizedPublishNewCommandOptions = PublishNewCommandOptions & Required<BaseCommandOptions> & {
  format: string;
  publishTransform?: PublishTransformOptions;
  markdownEngine: MarkdownEngineName;
};

export function registerSyncCommands(program: Command, context: CliContext): void {
  program
    .name('md2feishu')
    .description('Sync one local Markdown file to an existing Feishu document. Defaults to dry-run.')
    .argument('[markdown-file]', 'local Markdown file')
    .argument('[feishu-doc]', 'Feishu docx ID or URL')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--strategy <strategy>', 'conflict strategy: fail | local-wins | merge', 'fail')
    .option('--force-initial-overwrite', 'allow first write to replace an existing non-empty Feishu doc')
    .option('--force-whole-document-sync', 'allow whole-document sync when an active multisdk task exists')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
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
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
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
    .option('--strategy <strategy>', 'push strategy: auto | block-patch | section-replace | document-replace', 'auto')
    .option('--replace-all', 'allow document-replace writes to replace the existing Feishu document')
    .option('--force-whole-document-sync', 'allow whole-document push when an active multisdk task exists')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, feishuDoc: string, opts: PushCommandOptions) => {
      await runPushCommand(context, markdownFile, feishuDoc, normalizePushOptions(program, opts));
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
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'local')
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
    .description('show local/remote sync status without writing')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (markdownFile: string, feishuDoc: string, opts: StatusCommandOptions) => {
      const normalized = normalizeStatusOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const status = await getSyncStatus(client, {
        sourcePath: markdownFile,
        documentId,
        publishTransform: normalized.publishTransform,
        markdownEngine: createCliMarkdownEngine(client, normalized.markdownEngine)
      });
      printStatus(status, normalized.format);
    });

  program
    .command('pull')
    .description('export current Feishu docx content as best-effort Markdown')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('-o, --output <file>', 'write remote Markdown to a local file')
    .option('--overwrite', 'allow pull to replace an existing output file')
    .option('--write-receipt', 'write a local baseline receipt after exporting to --output')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .action(async (feishuDoc: string, opts: PullCommandOptions) => {
      const normalized = normalizePullOptions(program, opts);
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
          const statePath = receiptPath(process.cwd(), normalized.output, documentId);
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
    .description('show a best-effort diff between local Markdown and current Feishu content')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .action(async (markdownFile: string, feishuDoc: string, opts: StatusCommandOptions) => {
      const normalized = normalizeStatusOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const local = applyPublishTransform(await readFile(markdownFile, 'utf8'), normalized.publishTransform);
      const remote = await pullRemoteMarkdown(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      stdout.write(unifiedDiff(markdownFile, 'feishu', local, remote));
    });

  program
    .command('merge')
    .description('merge local Markdown with current Feishu content into a .merged.md file')
    .argument('<markdown-file>', 'local Markdown file')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('-o, --output <file>', 'merged output path; defaults to <name>.merged.md next to local file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .action(async (markdownFile: string, feishuDoc: string, opts: PullCommandOptions) => {
      const normalized = normalizePullOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const local = await readFile(markdownFile, 'utf8');
      const remote = await pullRemoteMarkdown(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      const statePath = receiptPath(process.cwd(), markdownFile, documentId);
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
  const strategy = optionFromArgv('--strategy') ?? commandOptionValue<string>(opts, 'strategy') ?? globals.strategy ?? 'fail';
  return {
    ...base,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? globals.format ?? 'pretty',
    write: flagFromArgv('--write') ?? commandOptionValue<boolean>(opts, 'write') ?? globals.write,
    yes: flagFromArgv('--yes') ?? flagFromArgv('-y') ?? commandOptionValue<boolean>(opts, 'yes') ?? globals.yes,
    strategy,
    forceInitialOverwrite: flagFromArgv('--force-initial-overwrite') ?? commandOptionValue<boolean>(opts, 'forceInitialOverwrite') ?? globals.forceInitialOverwrite,
    forceWholeDocumentSync: flagFromArgv('--force-whole-document-sync') ?? commandOptionValue<boolean>(opts, 'forceWholeDocumentSync') ?? globals.forceWholeDocumentSync,
    publishProfile,
    publishTransform: parsePublishTransform(publishProfile),
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'auto')
  };
}

function normalizePushOptions(program: Command, opts: PushCommandOptions): NormalizedPushCommandOptions {
  const globals = program.opts<PushCommandOptions>();
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile') ?? globals.publishProfile;
  return {
    ...base,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? globals.format ?? 'pretty',
    write: flagFromArgv('--write') ?? commandOptionValue<boolean>(opts, 'write') ?? globals.write,
    yes: flagFromArgv('--yes') ?? flagFromArgv('-y') ?? commandOptionValue<boolean>(opts, 'yes') ?? globals.yes,
    strategy: parsePushStrategy(optionFromArgv('--strategy') ?? commandOptionValue<string>(opts, 'strategy') ?? globals.strategy ?? 'auto'),
    replaceAll: flagFromArgv('--replace-all') ?? commandOptionValue<boolean>(opts, 'replaceAll') ?? globals.replaceAll,
    forceWholeDocumentSync: flagFromArgv('--force-whole-document-sync') ?? commandOptionValue<boolean>(opts, 'forceWholeDocumentSync') ?? globals.forceWholeDocumentSync,
    publishProfile,
    publishTransform: parsePublishTransform(publishProfile),
    scope: optionFromArgv('--scope') ?? commandOptionValue<string>(opts, 'scope') ?? globals.scope,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'auto')
  };
}

function normalizePublishNewOptions(program: Command, opts: PublishNewCommandOptions): NormalizedPublishNewCommandOptions {
  const globals = program.opts<PublishNewCommandOptions>();
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile') ?? globals.publishProfile;
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
    publishProfile,
    publishTransform: parsePublishTransform(publishProfile),
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'local')
  };
}

function normalizeStatusOptions(
  program: Command,
  opts: StatusCommandOptions
): StatusCommandOptions & Required<BaseCommandOptions> & { format: string; publishTransform?: PublishTransformOptions; markdownEngine: MarkdownEngineName } {
  const base = normalizeBaseOptions(program, opts);
  const publishProfile = optionFromArgv('--publish-profile') ?? commandOptionValue<string>(opts, 'publishProfile');
  return {
    ...base,
    format: optionFromArgv('--format') ?? commandOptionValue<string>(opts, 'format') ?? 'pretty',
    publishProfile,
    publishTransform: parsePublishTransform(publishProfile),
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? 'auto')
  };
}

function normalizePullOptions(program: Command, opts: PullCommandOptions): PullCommandOptions & Required<BaseCommandOptions> & { markdownEngine: MarkdownEngineName } {
  const base = normalizeBaseOptions(program, opts);
  return {
    ...base,
    output: optionFromArgv('--output') ?? optionFromArgv('-o') ?? commandOptionValue<string>(opts, 'output'),
    overwrite: flagFromArgv('--overwrite') ?? commandOptionValue<boolean>(opts, 'overwrite'),
    writeReceipt: flagFromArgv('--write-receipt') ?? commandOptionValue<boolean>(opts, 'writeReceipt'),
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? 'auto')
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

async function runSyncCommand(context: CliContext, markdownFile: string, feishuDoc: string, opts: NormalizedSyncCommandOptions): Promise<void> {
  const strategy = parseStrategy(opts.strategy);
  const client = context.createFeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
  const documentId = await resolveDocumentId(client, feishuDoc);
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
    confirm
  });

  printResult(result, opts.format);
}

async function runPushCommand(context: CliContext, markdownFile: string, feishuDoc: string, opts: NormalizedPushCommandOptions): Promise<void> {
  const scope = parsePushScope(opts.scope);
  if (opts.strategy === 'section-replace' && !scope.section) {
    throw new Error('--strategy section-replace requires --scope heading:"<heading>".');
  }
  if (opts.strategy === 'document-replace' && scope.section) {
    throw new Error('--strategy document-replace cannot be combined with --scope.');
  }

  const client = context.createFeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
  const documentId = await resolveDocumentId(client, feishuDoc);
  const markdownEngine = createCliMarkdownEngine(client, opts.markdownEngine);
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
    sectionPatchMode: opts.strategy === 'section-replace' ? 'section-replace' : 'auto',
    markdownEngine
  });
  const plan = buildPushPlan(planResult);
  assertRequestedPushStrategy(plan, opts.strategy);

  if (!opts.write) {
    printPushResult(plan, planResult, opts.format);
    return;
  }

  if (plan.selectedStrategy === 'document-replace' && !opts.replaceAll) {
    printPushResult(plan, planResult, opts.format);
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
    sectionPatchMode: plan.selectedStrategy === 'section-replace' ? 'section-replace' : 'auto',
    markdownEngine,
    confirm
  });
  printPushResult(buildPushPlan(writeResult), writeResult, opts.format);
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

function printResult(result: Awaited<ReturnType<typeof runSync>>, format = 'pretty'): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of syncResultSummaryLines(result)) {
    console.log(line);
  }

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
}

function printPushResult(plan: PushPlan, result: Awaited<ReturnType<typeof runSync>>, format = 'pretty'): void {
  if (format === 'json') {
    console.log(JSON.stringify({ pushPlan: plan, syncResult: result }, null, 2));
    return;
  }

  for (const line of pushResultSummaryLines(plan, result)) {
    console.log(line);
  }

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
}

export function pushResultSummaryLines(plan: PushPlan, result: Awaited<ReturnType<typeof runSync>>): string[] {
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

  if (result.mode === 'dry-run') {
    lines.push('', plan.approvalMessage);
  }

  if (result.mode === 'write') {
    lines.push(`Readback verification: ${result.receipt.verificationResult.ok ? 'passed' : 'failed'}`);
    if (result.receiptWritten) {
      lines.push(`Receipt: ${result.receiptPath}`);
    }
  }

  return lines;
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
  if (result.blockLevelSectionPatch) {
    const operations = result.blockLevelSectionPatch.operations;
    lines.push('patch mode: block-level');
    lines.push(`block updates: ${operations.filter((operation) => operation.kind === 'update').length}`);
    lines.push(`block creates: ${operations.filter((operation) => operation.kind === 'create').length}`);
    lines.push(`block deletes: ${operations.filter((operation) => operation.kind === 'delete').length}`);
    if (result.blockLevelSectionPatch.fallbackReason) {
      lines.push(`block fallback: ${result.blockLevelSectionPatch.fallbackReason}`);
    }
    if (result.blockLevelSectionPatch.unsafeForWrite) {
      lines.push('block fallback write: unsafe');
    }
  }
  if (result.patchPlan.operation === 'replace-contiguous-blocks') {
    lines.push(`remote range: ${result.patchPlan.remoteStartIndex}..${result.patchPlan.remoteEndIndex}`);
    lines.push(`local range: ${result.patchPlan.localStartIndex}..${result.patchPlan.localEndIndex}`);
  }
  if (result.patchPlan.operation !== 'noop') {
    lines.push(`will delete: ${result.patchPlan.deleteCount}`);
    lines.push(`will create: ${result.patchPlan.createCount}`);
  }

  if (result.mode === 'write' && result.receiptWritten) {
    lines.push(`receipt: ${result.receiptPath}`);
  }

  return lines;
}

function printStatus(status: SyncStatusResult, format = 'pretty'): void {
  if (format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`state: ${status.state}`);
  console.log(`local changed: ${status.localChanged}`);
  console.log(`remote changed: ${status.remoteChanged}`);
  console.log(`receipt: ${status.receiptPath}`);
  console.log(`source hash: ${status.sourceHash}`);
  console.log(`desired hash: ${status.desiredHash}`);
  console.log(`remote hash: ${status.currentRemoteHash}`);
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
