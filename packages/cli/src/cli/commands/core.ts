import path from 'node:path';
import type { Command } from 'commander';
import { LarkCliAdapter } from '../../adapters/lark-cli-adapter.js';
import {
  loadSyncConfig,
  resolveCalloutConfig,
  resolveCodeBlockConfig,
  resolveDialect,
  resolveDialectConfig,
  resolvePublishProfile
} from '../../config/sync-config.js';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { diffSummaryLines, runDiff } from '../../diff/run-diff.js';
import { runMerge, type RunMergeMode } from '../../merge/run-merge.js';
import { runPull } from '../../pull/run-pull.js';
import { runStatus } from '../../status/run-status.js';
import { parseOutputFormat, printFormatted } from '../output.js';

type PullCommandOptions = {
  target?: string;
  output?: string;
  profile?: string;
  overwrite?: boolean;
  writeReceipt?: boolean;
  format?: string;
};

type StatusCommandOptions = {
  target?: string;
  profile?: string;
  dialect?: string;
  syncWhiteboards?: boolean;
  format?: string;
};

type MergeCommandOptions = {
  target?: string;
  remote?: string;
  base?: string;
  profile?: string;
  dialect?: string;
  check?: boolean;
  dryRun?: boolean;
  abort?: boolean;
  saveRemote?: string;
  format?: string;
};

export function registerCoreCommands(program: Command): void {
  program
    .command('status')
    .description('show local/remote publish status without writing')
    .argument('<markdown-file>', 'local Markdown file')
    .requiredOption('--target <url-or-token>', 'Feishu/Lark docx or wiki URL/token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--dialect <dialect>', 'source dialect: gfm | docusaurus | milvus-authoring')
    .option('--sync-whiteboards', 'include same-name local SVG Whiteboard state')
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (markdownFile: string, opts: StatusCommandOptions) => {
      const cwd = process.cwd();
      const target = parseNonFolderTarget(opts.target ?? '', 'status');
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const dialect = resolveDialect({ cliDialect: opts.dialect, config });
      const callouts = resolveCalloutConfig(config);
      const codeBlocks = resolveCodeBlockConfig(config);
      const result = await runStatus({
        cwd,
        sourcePath: path.resolve(cwd, markdownFile),
        target,
        profile,
        dialect,
        dialectConfig: resolveDialectConfig(config, dialect),
        callouts,
        codeBlocks,
        syncWhiteboards: opts.syncWhiteboards === true,
        adapter: new LarkCliAdapter()
      });
      printFormatted(result, opts.format);
    });

  program
    .command('pull')
    .description('export current Feishu/Lark content as a local Markdown snapshot')
    .requiredOption('--target <url-or-token>', 'Feishu/Lark docx or wiki URL/token')
    .requiredOption('-o, --output <file>', 'write remote Markdown to a local file')
    .option('--profile <profile>', 'pull profile: zilliz | milvus | none')
    .option('--overwrite', 'allow pull to replace an existing output file')
    .option('--write-receipt', 'write a local pull snapshot receipt')
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (opts: PullCommandOptions) => {
      const cwd = process.cwd();
      const target = parseNonFolderTarget(opts.target ?? '', 'pull');
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const callouts = resolveCalloutConfig(config);
      const codeBlocks = resolveCodeBlockConfig(config);
      const result = await runPull({
        cwd,
        target,
        outputPath: path.resolve(cwd, opts.output ?? ''),
        profile,
        callouts,
        codeBlocks,
        overwrite: opts.overwrite === true,
        writeReceipt: opts.writeReceipt === true,
        adapter: new LarkCliAdapter()
      });
      printFormatted(result, opts.format);
    });

  program
    .command('diff')
    .description('show a publish-draft diff against current Feishu/Lark content')
    .argument('<markdown-file>', 'local Markdown file')
    .requiredOption('--target <url-or-token>', 'Feishu/Lark docx or wiki URL/token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--dialect <dialect>', 'source dialect: gfm | docusaurus | milvus-authoring')
    .option('--sync-whiteboards', 'include same-name local SVG Whiteboard state')
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (markdownFile: string, opts: StatusCommandOptions) => {
      const cwd = process.cwd();
      const target = parseNonFolderTarget(opts.target ?? '', 'diff');
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const dialect = resolveDialect({ cliDialect: opts.dialect, config });
      const callouts = resolveCalloutConfig(config);
      const codeBlocks = resolveCodeBlockConfig(config);
      const result = await runDiff({
        cwd,
        sourcePath: path.resolve(cwd, markdownFile),
        target,
        profile,
        dialect,
        dialectConfig: resolveDialectConfig(config, dialect),
        callouts,
        codeBlocks,
        syncWhiteboards: opts.syncWhiteboards === true,
        adapter: new LarkCliAdapter()
      });
      if (opts.format === 'json') {
        printFormatted(result, opts.format);
        return;
      }
      for (const line of diffSummaryLines(result)) console.log(line);
    });

  program
    .command('merge')
    .description('merge remote Feishu/Lark Markdown changes into a local Markdown file')
    .argument('<markdown-file>', 'local Markdown file')
    .option('--target <url-or-token>', 'Feishu/Lark docx or wiki URL/token to fetch before merging')
    .option('--remote <file>', 'local remote snapshot Markdown file')
    .option('--base <file>', 'explicit merge base Markdown file')
    .option('--profile <profile>', 'local authoring profile: milvus | zilliz | none')
    .option('--dialect <dialect>', 'source dialect: gfm | docusaurus | milvus-authoring')
    .option('--check', 'check whether merge would conflict without writing')
    .option('--dry-run', 'show merge metadata without writing')
    .option('--abort', 'restore the local file from the previous merge state')
    .option('--save-remote <file>', 'save fetched remote snapshot when using --target')
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (markdownFile: string, opts: MergeCommandOptions) => {
      const cwd = process.cwd();
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const dialect = resolveDialect({ cliDialect: opts.dialect, config });
      const callouts = resolveCalloutConfig(config);
      const codeBlocks = resolveCodeBlockConfig(config);
      const target = opts.target ? parseNonFolderTarget(opts.target, 'merge') : undefined;
      const result = await runMerge({
        cwd,
        filePath: path.resolve(cwd, markdownFile),
        target,
        remotePath: opts.remote ? path.resolve(cwd, opts.remote) : undefined,
        basePath: opts.base ? path.resolve(cwd, opts.base) : undefined,
        saveRemotePath: opts.saveRemote ? path.resolve(cwd, opts.saveRemote) : undefined,
        profile,
        dialect,
        callouts,
        codeBlocks,
        mode: resolveMergeMode(opts),
        adapter: new LarkCliAdapter()
      });
      printFormatted(result, opts.format);
      if (result.state === 'conflict' || result.state === 'blocked') process.exitCode = 1;
    });
}

function parseNonFolderTarget(raw: string, command: string): ReturnType<typeof parseFeishuTarget> {
  const target = parseFeishuTarget(raw);
  if (target.kind === 'folder') {
    throw new Error(`${command} --target does not support Drive folder targets.`);
  }
  return target;
}

function resolveMergeMode(opts: MergeCommandOptions): RunMergeMode {
  const selected = [opts.check, opts.dryRun, opts.abort].filter(Boolean).length;
  if (selected > 1) throw new Error('Choose only one of --check, --dry-run, or --abort.');
  if (opts.abort) return 'abort';
  if (opts.check) return 'check';
  if (opts.dryRun) return 'dry-run';
  return 'write';
}
