#!/usr/bin/env node
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import { Command } from 'commander';
import { parseFeishuTarget } from '../core/doc-id.js';
import { FeishuClient } from '../feishu/client.js';
import { readReceipt, receiptPath } from '../receipts/receipt.js';
import { unifiedDiff } from '../sync/diff.js';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../sync/merge.js';
import { pullRemoteMarkdown } from '../sync/pull.js';
import { runSync, type SyncStrategy } from '../sync/run-sync.js';
import { getSyncStatus, type SyncStatusResult } from '../sync/status.js';

const program = new Command();

program
  .name('md2feishu')
  .description('Sync one local Markdown file to an existing Feishu document. Defaults to dry-run.')
  .argument('[markdown-file]', 'local Markdown file')
  .argument('[feishu-doc]', 'Feishu docx ID or URL')
  .option('--write', 'write to Feishu; omitted means dry-run')
  .option('-y, --yes', 'skip write confirmation')
  .option('--strategy <strategy>', 'conflict strategy: fail | local-wins | merge', 'fail')
  .option('--force-initial-overwrite', 'allow first write to replace an existing non-empty Feishu doc')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (markdownFile: string | undefined, feishuDoc: string | undefined, opts: SyncCommandOptions) => {
    if (!markdownFile || !feishuDoc) {
      program.help();
      return;
    }
    await runSyncCommand(markdownFile, feishuDoc, normalizeSyncOptions(opts));
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
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (markdownFile: string, feishuDoc: string, opts: SyncCommandOptions) => {
    await runSyncCommand(markdownFile, feishuDoc, normalizeSyncOptions(opts));
  });

program
  .command('status')
  .description('show local/remote sync status without writing')
  .argument('<markdown-file>', 'local Markdown file')
  .argument('<feishu-doc>', 'Feishu docx ID or URL')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (markdownFile: string, feishuDoc: string, opts: BaseCommandOptions) => {
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const status = await getSyncStatus(client, { sourcePath: markdownFile, documentId });
    printStatus(status);
  });

program
  .command('pull')
  .description('export current Feishu docx content as best-effort Markdown')
  .argument('<feishu-doc>', 'Feishu docx ID or URL')
  .option('-o, --output <file>', 'write remote Markdown to a local file')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (feishuDoc: string, opts: PullCommandOptions) => {
    const normalized = normalizePullOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const markdown = await pullRemoteMarkdown(client, documentId);
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
  .action(async (markdownFile: string, feishuDoc: string, opts: BaseCommandOptions) => {
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const local = await readFile(markdownFile, 'utf8');
    const remote = await pullRemoteMarkdown(client, documentId);
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
  .action(async (markdownFile: string, feishuDoc: string, opts: PullCommandOptions) => {
    const normalized = normalizePullOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const local = await readFile(markdownFile, 'utf8');
    const remote = await pullRemoteMarkdown(client, documentId);
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

program.parseAsync().catch((error: unknown) => {
  const message = (error as Error).message;
  if (isRemoteConflictError(message)) {
    printRemoteConflictHelp(message);
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});

type BaseCommandOptions = {
  host?: string;
  timeoutMs?: number;
};

type SyncCommandOptions = BaseCommandOptions & {
  write?: boolean;
  yes?: boolean;
  strategy?: string;
  forceInitialOverwrite?: boolean;
};

type PullCommandOptions = BaseCommandOptions & {
  output?: string;
};

type NormalizedSyncCommandOptions = SyncCommandOptions & Required<BaseCommandOptions> & { strategy: string };

function normalizeBaseOptions(opts: BaseCommandOptions): Required<BaseCommandOptions> {
  const globals = program.opts<BaseCommandOptions>();
  return {
    host: opts.host ?? globals.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn',
    timeoutMs: opts.timeoutMs ?? globals.timeoutMs ?? 20_000
  };
}

function normalizeSyncOptions(opts: SyncCommandOptions): NormalizedSyncCommandOptions {
  const globals = program.opts<SyncCommandOptions>();
  const base = normalizeBaseOptions(opts);
  return {
    ...base,
    write: opts.write ?? globals.write,
    yes: opts.yes ?? globals.yes,
    strategy: globals.strategy && globals.strategy !== 'fail' ? globals.strategy : opts.strategy ?? 'fail',
    forceInitialOverwrite: opts.forceInitialOverwrite ?? globals.forceInitialOverwrite
  };
}

function normalizePullOptions(opts: PullCommandOptions): PullCommandOptions & Required<BaseCommandOptions> {
  const base = normalizeBaseOptions(opts);
  return {
    ...base,
    output: opts.output
  };
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

async function runSyncCommand(markdownFile: string, feishuDoc: string, opts: NormalizedSyncCommandOptions): Promise<void> {
  const strategy = parseStrategy(opts.strategy);
  const client = new FeishuClient({ host: opts.host, timeoutMs: opts.timeoutMs });
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
    confirm
  });

  printResult(result);
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

function printResult(result: Awaited<ReturnType<typeof runSync>>): void {
  console.log(`${result.mode}: ${result.patchPlan.operation}`);
  console.log(`source blocks: ${result.receipt.blockCounts.source}`);
  console.log(`feishu blocks: ${result.receipt.blockCounts.feishuBefore} -> ${result.receipt.blockCounts.feishuAfter}`);
  console.log(`desired hash: ${result.patchPlan.desiredHash}`);

  if (result.mode === 'write') {
    console.log(`receipt: ${result.receiptPath}`);
  }

  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
}

function printStatus(status: SyncStatusResult): void {
  console.log(`state: ${status.state}`);
  console.log(`local changed: ${status.localChanged}`);
  console.log(`remote changed: ${status.remoteChanged}`);
  console.log(`receipt: ${status.receiptPath}`);
  console.log(`source hash: ${status.sourceHash}`);
  console.log(`desired hash: ${status.desiredHash}`);
  console.log(`remote hash: ${status.currentRemoteHash}`);
}

function isRemoteConflictError(message: string): boolean {
  return message.includes('Feishu changed since the last receipt');
}

function printRemoteConflictHelp(message: string): void {
  console.error('Conflict: Feishu changed since the last successful sync.');
  console.error('');
  console.error(message);
  console.error('');
  console.error('Nothing was written.');
  console.error('');
  console.error('Next steps:');
  console.error('  md2feishu status <file.md> <doc>');
  console.error('  md2feishu diff <file.md> <doc>');
  console.error('  md2feishu merge <file.md> <doc>');
  console.error('  md2feishu pull <doc> --output feishu.remote.md');
  console.error('  md2feishu sync <file.md> <doc> --write --strategy local-wins --yes');
}
