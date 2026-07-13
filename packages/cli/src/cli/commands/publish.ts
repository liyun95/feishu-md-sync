import path from 'node:path';
import type { Command } from 'commander';
import { LarkCliAdapter } from '../../adapters/lark-cli-adapter.js';
import { loadSyncConfig, resolvePublishProfile } from '../../config/sync-config.js';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { runPublish } from '../../publish/run-publish.js';
import { printFormatted, setFailedExitCode } from '../output.js';

type PublishCommandOptions = {
  target?: string;
  profile?: string;
  write?: boolean;
  create?: boolean;
  strategy?: string;
  confirmDestructive?: boolean;
  confirmCollaborationRisk?: boolean;
  confirmUntrackedRemote?: boolean;
  format?: string;
};

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('publish local Markdown to an existing Feishu/Lark online document')
    .argument('<markdown-file>', 'local Markdown file')
    .requiredOption('--target <url-or-token>', 'existing Feishu/Lark docx URL or token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--write', 'write to Feishu/Lark; omitted means dry-run')
    .option('--create', 'create a new document under a folder or wiki target')
    .option('--strategy <strategy>', 'write strategy: auto | block-patch | document-replace', 'auto')
    .option('--confirm-destructive', 'confirm destructive document replacement in non-interactive mode')
    .option('--confirm-collaboration-risk', 'confirm block replacement/deletion may affect comments or block identity')
    .option('--confirm-untracked-remote', 'confirm adopting an existing remote document without a publish receipt')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (markdownFile: string, opts: PublishCommandOptions) => {
      const requested = publishRequestFromArgv(opts);
      if (requested.write && requested.strategy === 'document-replace' && !requested.confirmDestructive) {
        throw new Error('--confirm-destructive is required with --strategy document-replace --write');
      }

      const target = parseFeishuTarget(opts.target ?? '');
      const cwd = process.cwd();
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const result = await runPublish({
        cwd,
        file: path.resolve(cwd, markdownFile),
        target,
        profile,
        write: requested.write,
        create: requested.create,
        strategy: requested.strategy,
        confirmDestructive: requested.confirmDestructive,
        confirmCollaborationRisk: requested.confirmCollaborationRisk,
        confirmUntrackedRemote: requested.confirmUntrackedRemote,
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
  create: boolean;
} {
  const strategy = optionValueFromArgv('--strategy') ?? opts.strategy ?? 'auto';
  if (strategy !== 'auto' && strategy !== 'block-patch' && strategy !== 'document-replace') {
    throw new Error(`Invalid --strategy ${strategy}. Expected auto, block-patch, or document-replace.`);
  }
  return {
    write: opts.write === true || process.argv.includes('--write'),
    create: opts.create === true || process.argv.includes('--create'),
    strategy,
    confirmDestructive: opts.confirmDestructive === true || process.argv.includes('--confirm-destructive'),
    confirmCollaborationRisk: opts.confirmCollaborationRisk === true || process.argv.includes('--confirm-collaboration-risk'),
    confirmUntrackedRemote: opts.confirmUntrackedRemote === true || process.argv.includes('--confirm-untracked-remote')
  };
}

function optionValueFromArgv(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
