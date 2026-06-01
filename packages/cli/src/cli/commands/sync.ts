import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import type { FeishuClient } from '../../feishu/client.js';
import { createMarkdownEngine, type MarkdownEngine, type MarkdownEngineName } from '../../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions, type PublishTransformProfile } from '../../markdown/publish-transform.js';
import { FeishuBlockConvertClient } from '../../services/feishu/block-convert-client.js';
import { FeishuDocsContentClient } from '../../services/feishu/docs-content-client.js';
import { readReceipt, receiptPath } from '../../receipts/receipt.js';
import { unifiedDiff } from '../../sync/diff.js';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../../sync/merge.js';
import { pullRemoteMarkdown } from '../../sync/pull.js';
import { runSync, type SyncStrategy } from '../../sync/run-sync.js';
import { getSyncStatus, type SyncStatusResult } from '../../sync/status.js';
import type { CliContext } from '../context.js';
import { buildAuthDoctorReport } from '../env.js';
import {
  buildSyncOutputContext,
  formatSyncResultPretty,
  syncReceiptRunContext,
  type SyncOutputContext
} from '../sync-output.js';

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
  section?: string;
  insertSection?: string;
  beforeSection?: string;
  afterSection?: string;
  beforeHeading?: string;
  markdownEngine?: string;
};

type PullCommandOptions = BaseCommandOptions & {
  output?: string;
  markdownEngine?: string;
};

type StatusCommandOptions = BaseCommandOptions & {
  format?: string;
  publishProfile?: string;
  markdownEngine?: string;
};

type NormalizedSyncCommandOptions = Omit<SyncCommandOptions, 'insertSection' | 'beforeSection' | 'afterSection' | 'beforeHeading'> & Required<BaseCommandOptions> & {
  format: string;
  strategy: string;
  publishTransform?: PublishTransformOptions;
  insertSection?: {
    heading: string;
    relative: 'before' | 'after';
    targetHeading: string;
  };
  beforeHeading?: string;
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
    .option('--section <heading>', 'replace only the named heading section instead of the whole document')
    .option('--insert-section <heading>', 'insert the named local heading section into the remote document')
    .option('--before-section <heading>', 'insert --insert-section before this existing remote heading')
    .option('--after-section <heading>', 'insert --insert-section after this existing remote heading section')
    .option('--before-heading <heading>', 'replace only content before this existing heading')
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
    .option('--section <heading>', 'replace only the named heading section instead of the whole document')
    .option('--insert-section <heading>', 'insert the named local heading section into the remote document')
    .option('--before-section <heading>', 'insert --insert-section before this existing remote heading')
    .option('--after-section <heading>', 'insert --insert-section after this existing remote heading section')
    .option('--before-heading <heading>', 'replace only content before this existing heading')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, feishuDoc: string, opts: SyncCommandOptions) => {
      await runSyncCommand(context, markdownFile, feishuDoc, normalizeSyncOptions(program, opts));
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
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .action(async (feishuDoc: string, opts: PullCommandOptions) => {
      const normalized = normalizePullOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const markdown = await pullRemoteMarkdown(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
      if (normalized.output) {
        await writeFile(normalized.output, markdown, 'utf8');
        console.log(`wrote: ${normalized.output}`);
        return;
      }
      stdout.write(markdown);
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
  const section = optionFromArgv('--section') ?? commandOptionValue<string>(opts, 'section') ?? globals.section;
  const rawInsertSection = optionFromArgv('--insert-section') ?? commandOptionValue<string>(opts, 'insertSection') ?? globals.insertSection;
  const rawBeforeSection = optionFromArgv('--before-section') ?? commandOptionValue<string>(opts, 'beforeSection') ?? globals.beforeSection;
  const rawAfterSection = optionFromArgv('--after-section') ?? commandOptionValue<string>(opts, 'afterSection') ?? globals.afterSection;
  const beforeHeading = optionFromArgv('--before-heading') ?? commandOptionValue<string>(opts, 'beforeHeading') ?? globals.beforeHeading;
  const insertSection = parseInsertSectionOptions(rawInsertSection, rawBeforeSection, rawAfterSection);
  validateScopedOptions({ section, insertSection, beforeHeading });
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
    section,
    insertSection,
    beforeHeading,
    markdownEngine: parseMarkdownEngine(optionFromArgv('--markdown-engine') ?? commandOptionValue<string>(opts, 'markdownEngine') ?? globals.markdownEngine ?? 'auto')
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
    section: opts.section,
    insertSection: opts.insertSection,
    beforeHeading: opts.beforeHeading,
    markdownEngine: createCliMarkdownEngine(client, opts.markdownEngine),
    confirm,
    runContext: syncReceiptRunContext(outputContext)
  });

  printResult(result, opts.format, outputContext);
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

function parseInsertSectionOptions(
  heading: string | undefined,
  beforeSection: string | undefined,
  afterSection: string | undefined
): NormalizedSyncCommandOptions['insertSection'] | undefined {
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
  section?: string;
  insertSection?: NormalizedSyncCommandOptions['insertSection'];
  beforeHeading?: string;
}): void {
  const selected = [
    input.section ? '--section' : '',
    input.insertSection ? '--insert-section' : '',
    input.beforeHeading ? '--before-heading' : ''
  ].filter(Boolean);
  if (selected.length > 1) {
    throw new Error(`Scoped sync options are mutually exclusive: ${selected.join(', ')}.`);
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
  console.log(formatSyncResultPretty(result, context));

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
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
