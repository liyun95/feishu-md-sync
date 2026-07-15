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
import { confirmationRequired, validationFailure } from '../../core/cli-failure.js';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { runPublish } from '../../publish/run-publish.js';
import { parseOutputFormat, printFormatted, setFailedExitCode } from '../output.js';

type PublishCommandOptions = {
  target?: string;
  profile?: string;
  dialect?: string;
  write?: boolean;
  create?: boolean;
  strategy?: string;
  confirmDestructive?: boolean;
  confirmCollaborationRisk?: boolean;
  confirmUntrackedRemote?: boolean;
  syncWhiteboards?: boolean;
  confirmRemoteWhiteboardOverwrite?: string[];
  format?: string;
};

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('publish local Markdown to an existing Feishu/Lark online document')
    .argument('<markdown-file>', 'local Markdown file')
    .requiredOption('--target <url-or-token>', 'existing Feishu/Lark docx URL or token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--dialect <dialect>', 'source dialect: gfm | docusaurus | milvus-authoring')
    .option('--write', 'write to Feishu/Lark; omitted means dry-run')
    .option('--create', 'create a new document under a folder or wiki target')
    .option('--strategy <strategy>', 'write strategy: auto | block-patch | document-replace', 'auto')
    .option('--confirm-destructive', 'confirm destructive document replacement in non-interactive mode')
    .option('--confirm-collaboration-risk', 'confirm block replacement/deletion may affect comments or block identity')
    .option('--confirm-untracked-remote', 'confirm adopting an existing remote document without a publish receipt')
    .option('--sync-whiteboards', 'sync same-name local SVG assets to Feishu Whiteboards')
    .option(
      '--confirm-remote-whiteboard-overwrite <asset-key>',
      'confirm overwriting one remotely changed Whiteboard asset; repeat for multiple assets',
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (markdownFile: string, opts: PublishCommandOptions) => {
      const requested = publishRequestFromArgv(opts);
      if (requested.syncWhiteboards && requested.create) {
        throw validationFailure({ message: '--sync-whiteboards is not supported with --create' });
      }
      if (requested.syncWhiteboards && requested.strategy === 'document-replace') {
        throw validationFailure({ message: '--sync-whiteboards is not supported with --strategy document-replace' });
      }
      if (requested.write && requested.strategy === 'document-replace' && !requested.confirmDestructive) {
        throw confirmationRequired({
          subtype: 'destructive_write',
          message: '--confirm-destructive is required with --strategy document-replace --write',
          hint: 'review the document-replace dry-run and obtain explicit approval',
          requiredFlags: ['--confirm-destructive']
        });
      }

      const target = parseFeishuTarget(opts.target ?? '');
      const cwd = process.cwd();
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const dialect = resolveDialect({ cliDialect: opts.dialect, config });
      const callouts = resolveCalloutConfig(config);
      const codeBlocks = resolveCodeBlockConfig(config);
      const result = await runPublish({
        cwd,
        file: path.resolve(cwd, markdownFile),
        target,
        profile,
        dialect,
        dialectConfig: resolveDialectConfig(config, dialect),
        callouts,
        codeBlocks,
        write: requested.write,
        create: requested.create,
        strategy: requested.strategy,
        confirmDestructive: requested.confirmDestructive,
        confirmCollaborationRisk: requested.confirmCollaborationRisk,
        confirmUntrackedRemote: requested.confirmUntrackedRemote,
        syncWhiteboards: requested.syncWhiteboards,
        confirmedRemoteWhiteboardOverwrites: requested.confirmedRemoteWhiteboardOverwrites,
        adapter: new LarkCliAdapter()
      });

      printFormatted(result, opts.format);
      setFailedExitCode(result.mode === 'dry-run' && result.plan.strategy === 'blocked');
    });
}

function publishRequestFromArgv(opts: PublishCommandOptions): {
  write: boolean;
  strategy: 'auto' | 'block-patch' | 'document-replace';
  confirmDestructive: boolean;
  confirmCollaborationRisk: boolean;
  confirmUntrackedRemote: boolean;
  syncWhiteboards: boolean;
  confirmedRemoteWhiteboardOverwrites: string[];
  create: boolean;
} {
  const strategy = optionValueFromArgv('--strategy') ?? opts.strategy ?? 'auto';
  if (strategy !== 'auto' && strategy !== 'block-patch' && strategy !== 'document-replace') {
    throw validationFailure({ message: `Invalid --strategy ${strategy}. Expected auto, block-patch, or document-replace.` });
  }
  return {
    write: opts.write === true || process.argv.includes('--write'),
    create: opts.create === true || process.argv.includes('--create'),
    strategy,
    confirmDestructive: opts.confirmDestructive === true || process.argv.includes('--confirm-destructive'),
    confirmCollaborationRisk: opts.confirmCollaborationRisk === true || process.argv.includes('--confirm-collaboration-risk'),
    confirmUntrackedRemote: opts.confirmUntrackedRemote === true || process.argv.includes('--confirm-untracked-remote'),
    syncWhiteboards: opts.syncWhiteboards === true || process.argv.includes('--sync-whiteboards'),
    confirmedRemoteWhiteboardOverwrites: opts.confirmRemoteWhiteboardOverwrite ?? optionValuesFromArgv('--confirm-remote-whiteboard-overwrite')
  };
}

function optionValueFromArgv(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function optionValuesFromArgv(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
    if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
  }
  return values;
}
