import path from 'node:path';
import type { Command } from 'commander';
import { LarkCliAdapter } from '../../adapters/lark-cli-adapter.js';
import { runBaselineAdopt, type LocalBaselineSource } from '../../baseline/run-baseline-adopt.js';
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
import { parseOutputFormat, printFormatted, setFailedExitCode } from '../output.js';

type BaselineAdoptCommandOptions = {
  target?: string;
  profile?: string;
  dialect?: string;
  localBaseline?: string;
  gitRef?: string;
  apply?: boolean;
  confirmBaselineAdoption?: string;
  format?: string;
};

export function registerBaselineCommand(program: Command): void {
  const baseline = program
    .command('baseline')
    .description('inspect or establish local publish baselines without writing Feishu/Lark');

  baseline
    .command('adopt')
    .description('adopt an explicit L0 and current remote R0 as a local-only publish baseline')
    .argument('<markdown-file>', 'current local Markdown file (L1)')
    .requiredOption('--target <url-or-token>', 'existing Feishu/Lark docx or wiki URL/token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--dialect <dialect>', 'source dialect: gfm | zdoc-authoring | milvus-authoring')
    .option('--local-baseline <file>', 'explicit local Markdown file to use as L0')
    .option('--git-ref <ref>', 'Git commit/ref containing the source file to use as L0')
    .option('--apply', 'atomically write only the local receipt and baseline sidecars')
    .option(
      '--confirm-baseline-adoption <fingerprint>',
      'confirm the exact reviewed L0/L1/R0 dry-run fingerprint'
    )
    .option('--format <format>', 'output format: pretty | json', parseOutputFormat, 'pretty')
    .action(async (markdownFile: string, opts: BaselineAdoptCommandOptions) => {
      const cwd = process.cwd();
      const baselineSource = resolveBaselineSource(opts, cwd);
      const apply = opts.apply === true;
      if (opts.confirmBaselineAdoption && !apply) {
        throw validationFailure({
          subtype: 'baseline_confirmation_without_apply',
          message: '--confirm-baseline-adoption requires --apply.'
        });
      }
      if (apply && !opts.confirmBaselineAdoption) {
        throw confirmationRequired({
          subtype: 'baseline_adoption',
          message: 'Baseline adoption apply requires --confirm-baseline-adoption <fingerprint>.',
          hint: 'review the baseline adopt dry-run and pass its exact confirmation fingerprint',
          requiredFlags: ['--confirm-baseline-adoption <fingerprint>']
        });
      }

      const target = parseFeishuTarget(opts.target ?? '');
      if (target.kind === 'folder') {
        throw validationFailure({
          subtype: 'baseline_target_unsupported',
          message: 'baseline adopt --target does not support Drive folder targets.'
        });
      }
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const dialect = resolveDialect({ cliDialect: opts.dialect, config });
      const result = await runBaselineAdopt({
        cwd,
        sourcePath: path.resolve(cwd, markdownFile),
        baseline: baselineSource,
        target,
        profile,
        dialect,
        dialectConfig: resolveDialectConfig(config, dialect),
        callouts: resolveCalloutConfig(config),
        codeBlocks: resolveCodeBlockConfig(config),
        apply,
        confirmationFingerprint: opts.confirmBaselineAdoption,
        adapter: new LarkCliAdapter()
      });

      printFormatted(result, opts.format);
      setFailedExitCode(!result.safeToAdopt);
    });
}

function resolveBaselineSource(
  opts: BaselineAdoptCommandOptions,
  cwd: string
): LocalBaselineSource {
  if (opts.localBaseline && opts.gitRef) {
    throw validationFailure({
      subtype: 'baseline_source_ambiguous',
      message: 'Choose only one of --local-baseline or --git-ref.'
    });
  }
  if (!opts.localBaseline && !opts.gitRef) {
    throw validationFailure({
      subtype: 'baseline_source_required',
      message: 'baseline adopt requires exactly one of --local-baseline or --git-ref.'
    });
  }
  return opts.localBaseline
    ? { kind: 'file', path: path.resolve(cwd, opts.localBaseline) }
    : { kind: 'git', ref: opts.gitRef! };
}
