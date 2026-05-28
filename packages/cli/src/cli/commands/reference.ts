import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { applyReferenceManifest } from '../../reference/apply.js';
import { auditReferenceManifest } from '../../reference/audit.js';
import { exportReferenceToWebContent, type ReferenceExportScope } from '../../reference/export.js';
import { buildReferenceSourceFreshness } from '../../reference/freshness.js';
import { planReferenceManifestFromImpact, type ReferenceImpactMatrix } from '../../reference/plan.js';
import { runReferenceReleaseWorkflow } from '../../reference/release-run.js';
import { runWebContentCommand } from '../../reference/web-content.js';
import type { CliContext } from '../context.js';
import { printFormatted, setFailedExitCode } from '../output.js';

const execFileAsync = promisify(execFile);

type BaseCommandOptions = {
  host?: string;
  timeoutMs?: number;
};

type FormatCommandOptions = {
  format?: string;
};

type ReferencePlanCommandOptions = FormatCommandOptions & {
  impact: string;
  out: string;
};

type ReferencePreflightCommandOptions = FormatCommandOptions & {
  sdk: string;
  repo: string;
  versionLine: string;
  baselineTag?: string;
  scanState?: string;
  stateKey?: string;
  sourcePath?: string[];
  skipFetch?: boolean;
  failOnStale?: boolean;
};

type ReferenceApplyCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  manifest: string;
  write?: boolean;
  yes?: boolean;
};

type ReferenceAuditCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  manifest: string;
};

type ReferenceWebContentOptions = FormatCommandOptions & {
  repo: string;
  config: string;
  manual: string;
  doc?: string;
  output?: string;
  recursive?: boolean;
  all?: boolean;
  position?: number;
  skipImageDown?: boolean;
};

type ReferenceReleaseRunCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  config: string;
  write?: boolean;
  pullWebContent?: boolean;
  createPr?: boolean;
};

type ReferenceExportCommandOptions = FormatCommandOptions & {
  manifest: string;
  webContentRepo: string;
  manual: string;
  config?: string;
  scope?: string;
  skipImageDown?: boolean;
  out?: string;
};

export function registerReferenceCommands(program: Command, context: CliContext): void {
  const reference = program
    .command('reference')
    .description('publish and audit SDK reference docs from explicit manifests');

  reference
    .command('preflight')
    .description('check SDK source freshness before planning reference changes')
    .requiredOption('--sdk <sdk>', 'SDK name, for example java')
    .requiredOption('--repo <path>', 'local SDK repository path')
    .requiredOption('--version-line <line>', 'release line, for example v3.0.x')
    .option('--baseline-tag <tag>', 'last scanned SDK tag')
    .option('--scan-state <file>', 'scan-state JSON path used when --baseline-tag is omitted')
    .option('--state-key <key>', 'scan-state key; defaults to --sdk')
    .option('--source-path <path>', 'repeatable source path for changed-path checks', collectOption, [])
    .option('--skip-fetch', 'skip git fetch --tags')
    .option('--fail-on-stale', 'exit non-zero when latest tag differs from the baseline')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: ReferencePreflightCommandOptions) => {
      const skipFetch = normalizeBooleanOption(program, opts, 'skipFetch', '--skip-fetch');
      const failOnStale = normalizeBooleanOption(program, opts, 'failOnStale', '--fail-on-stale');
      const sourcePaths = commandOptionValue<string[]>(opts, 'sourcePath') ?? [];

      if (!skipFetch) {
        await execFileAsync('git', ['-C', opts.repo, 'fetch', '--tags'], { maxBuffer: 10 * 1024 * 1024 });
      }

      const baselineTag = opts.baselineTag ?? await readScanStateTag(opts.scanState, opts.stateKey ?? opts.sdk);
      if (!baselineTag) {
        throw new Error('Reference preflight requires --baseline-tag or --scan-state with a matching lastScannedTag.');
      }

      const tags = (await execFileAsync('git', ['-C', opts.repo, 'tag', '--list'], { maxBuffer: 10 * 1024 * 1024 }))
        .stdout
        .split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean);
      const preliminary = buildReferenceSourceFreshness({
        sdk: opts.sdk,
        repository: opts.repo,
        versionLine: opts.versionLine,
        baselineTag,
        tags,
        changedPaths: []
      });
      const changedPaths = preliminary.upToDate
        ? []
        : await gitChangedPaths(opts.repo, preliminary.diffRange ?? `${baselineTag}..${preliminary.latestTag}`, sourcePaths);
      const freshness = buildReferenceSourceFreshness({
        sdk: opts.sdk,
        repository: opts.repo,
        versionLine: opts.versionLine,
        baselineTag,
        tags,
        changedPaths
      });

      printFormatted(freshness, opts.format);
      setFailedExitCode(failOnStale && !freshness.upToDate);
    });

  reference
    .command('plan')
    .description('convert an approved SDK reference impact matrix into a publish manifest')
    .requiredOption('--impact <file>', 'impact matrix JSON path')
    .requiredOption('--out <file>', 'manifest output path')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: ReferencePlanCommandOptions) => {
      const impact = JSON.parse(await readFile(opts.impact, 'utf8')) as ReferenceImpactMatrix;
      const manifest = planReferenceManifestFromImpact(impact);
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      printFormatted({ manifestPath: opts.out, actions: manifest.actions.length }, opts.format);
    });

  reference
    .command('apply')
    .description('apply an SDK reference publish manifest')
    .requiredOption('--manifest <file>', 'reference publish manifest path')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (opts: ReferenceApplyCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const write = normalizeBooleanOption(program, opts, 'write', '--write');
      const yes = normalizeBooleanOption(program, opts, 'yes', '--yes') || optionFlagFromArgv('-y');
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      if (write && !yes) {
        const rl = readline.createInterface({ input, output: stdout });
        const answer = await rl.question(`Apply SDK reference manifest ${opts.manifest}? [y/N] `);
        rl.close();
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          throw new Error('Reference apply cancelled.');
        }
      }
      const report = await applyReferenceManifest(client, {
        manifestPath: opts.manifest,
        write
      });
      printFormatted(report, opts.format);
      setFailedExitCode(report.failed.length > 0);
    });

  reference
    .command('audit')
    .description('read back resources referenced by an SDK reference publish manifest')
    .requiredOption('--manifest <file>', 'reference publish manifest path')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (opts: ReferenceAuditCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const report = await auditReferenceManifest(client, { manifestPath: opts.manifest });
      printFormatted(report, opts.format);
      setFailedExitCode(!report.passed);
    });

  const webContent = reference
    .command('web-content')
    .description('run web-content SDK reference export checks against an external checkout');

  webContent
    .command('check')
    .description('scan a web-content SDK manual for stale Feishu doc links')
    .requiredOption('--repo <path>', 'external web-content repo path')
    .option('--config <path>', 'web-content lark docs config path', 'scripts/config.json')
    .requiredOption('--manual <name>', 'web-content manual name, for example java-v2.6.x')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: ReferenceWebContentOptions) => {
      const result = await runWebContentCommand({
        repo: opts.repo,
        config: opts.config,
        manual: opts.manual,
        mode: 'check'
      });
      printFormatted(result, opts.format);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  webContent
    .command('pull')
    .description('pull Feishu SDK reference docs into an external web-content checkout')
    .requiredOption('--repo <path>', 'external web-content repo path')
    .option('--config <path>', 'web-content lark docs config path', 'scripts/config.json')
    .requiredOption('--manual <name>', 'web-content manual name, for example java-v2.6.x')
    .option('--doc <title>', 'single Feishu doc title to pull')
    .option('--output <path>', 'output path relative to the manual output directory')
    .option('--recursive', 'pull child documents recursively')
    .option('--all', 'pull all top-level documents from the manual')
    .option('--position <number>', 'menu position for new docs', parseIntOption)
    .option('--skip-image-down', 'pass --skipImageDown to the web-content script')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: ReferenceWebContentOptions) => {
      const all = normalizeBooleanOption(program, opts, 'all', '--all');
      const recursive = normalizeBooleanOption(program, opts, 'recursive', '--recursive');
      const skipImageDown = normalizeBooleanOption(program, opts, 'skipImageDown', '--skip-image-down');
      if (!opts.doc && !all) throw new Error('reference web-content pull requires --doc or --all.');
      const result = await runWebContentCommand({
        repo: opts.repo,
        config: opts.config,
        manual: opts.manual,
        mode: 'pull',
        doc: opts.doc,
        output: opts.output,
        recursive,
        all,
        position: opts.position,
        skipImageDown
      });
      printFormatted(result, opts.format);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    });

  const referenceRelease = reference
    .command('release')
    .description('run the SDK reference release workflow from a config file');

  referenceRelease
    .command('run')
    .description('apply/audit Feishu, check or pull web-content, and prepare PR handoff')
    .requiredOption('--config <file>', 'sdk-reference-release-workflow config path')
    .option('--write', 'write Feishu changes; omitted means dry-run')
    .option('--pull-web-content', 'pull Feishu output into web-content; omitted means stale-link check only')
    .option('--create-pr', 'create the GitHub PR; omitted means prepare command/body only')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (opts: ReferenceReleaseRunCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const report = await runReferenceReleaseWorkflow({
        configPath: opts.config,
        writeFeishu: normalizeBooleanOption(program, opts, 'write', '--write'),
        pullWebContent: normalizeBooleanOption(program, opts, 'pullWebContent', '--pull-web-content'),
        createPr: normalizeBooleanOption(program, opts, 'createPr', '--create-pr'),
        applyManifest: (options) => applyReferenceManifest(client, options),
        auditManifest: (options) => auditReferenceManifest(client, options)
      });
      printFormatted(report, opts.format);
      setFailedExitCode(!report.passed);
    });

  reference
    .command('export')
    .description('export audited SDK reference docs from Feishu into a web-content checkout')
    .requiredOption('--manifest <file>', 'reference publish manifest path')
    .requiredOption('--web-content-repo <path>', 'local web-content repository path')
    .requiredOption('--manual <manual>', 'web-content manual key, for example java-v3.0.x')
    .option('--config <file>', 'web-content config path, relative to --web-content-repo unless absolute', 'scripts/config.json')
    .option('--scope <scope>', 'export scope: changed | all', 'changed')
    .option('--skip-image-down', 'pass --skipImageDown to the web-content lark-docs script', true)
    .option('--no-skip-image-down', 'download images while exporting')
    .option('--out <file>', 'write export handoff report JSON to this path')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: ReferenceExportCommandOptions) => {
      const report = await exportReferenceToWebContent({
        manifestPath: opts.manifest,
        webContentRepo: opts.webContentRepo,
        manual: opts.manual,
        configPath: opts.config ?? 'scripts/config.json',
        scope: parseReferenceExportScope(opts.scope ?? 'changed'),
        skipImageDown: commandOptionValue<boolean>(opts, 'skipImageDown') !== false,
        outPath: opts.out
      });
      printFormatted(report, opts.format);
      setFailedExitCode(!report.diffCheck.passed);
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

function normalizeBooleanOption(program: Command, opts: unknown, key: string, flag: string): boolean {
  return optionFlagFromArgv(flag) ||
    commandOptionValue<boolean>(opts, key) === true ||
    program.opts<Record<string, unknown>>()[key] === true;
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

function optionFlagFromArgv(name: string): boolean {
  return process.argv.includes(name);
}

function optionFromArgv(name: string): string | undefined {
  for (let index = process.argv.length - 1; index >= 0; index -= 1) {
    const arg = process.argv[index];
    if (arg === name) return process.argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function parseIntOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseReferenceExportScope(value: string): ReferenceExportScope {
  if (value === 'changed' || value === 'all') return value;
  throw new Error(`Invalid --scope ${value}. Expected changed or all.`);
}

async function readScanStateTag(scanStatePath: string | undefined, stateKey: string): Promise<string | undefined> {
  if (!scanStatePath) return undefined;
  const scanState = JSON.parse(await readFile(scanStatePath, 'utf8')) as unknown;
  if (!scanState || typeof scanState !== 'object') return undefined;
  const entry = (scanState as Record<string, unknown>)[stateKey];
  if (!entry || typeof entry !== 'object') return undefined;
  const tag = (entry as Record<string, unknown>).lastScannedTag;
  return typeof tag === 'string' && tag.trim() ? tag : undefined;
}

async function gitChangedPaths(repoPath: string, diffRange: string, sourcePaths: string[]): Promise<string[]> {
  const args = ['-C', repoPath, 'diff', '--name-only', diffRange, '--', ...sourcePaths];
  const { stdout: output } = await execFileAsync('git', args, { maxBuffer: 10 * 1024 * 1024 });
  return output
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}
