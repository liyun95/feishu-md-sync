import { execFile } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { buildCodeBlockInventory } from '../../feishu/code-blocks.js';
import type { FeishuClient } from '../../feishu/client.js';
import { buildHarnessEnvironmentReport, writeHarnessEnvironment } from '../../harness/environment.js';
import { assessPrBranchHygiene, buildCleanBranchPlan, suggestTopicBranch } from '../../multisdk/git-hygiene.js';
import { landMultisdkDocs } from '../../multisdk/land-docs.js';
import { parseMultisdkLanguage } from '../../multisdk/language.js';
import { loadMultisdkTask, saveMultisdkTask, summarizeMultisdkTask } from '../../multisdk/task.js';
import { defaultValidationProfile, getValidationProfile, listValidationProfiles } from '../../multisdk/validation-profile.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  diffMultisdkLanguage,
  exportMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../../multisdk/workflow.js';
import { renderCodeBlockDiffReport } from '../../sync/code-block-diff.js';
import { pullRemoteMarkdown } from '../../sync/pull.js';
import type { CliContext } from '../context.js';
import { printFormatted } from '../output.js';

const execFileAsync = promisify(execFile);

type BaseCommandOptions = {
  host?: string;
  timeoutMs?: number;
};

type FormatCommandOptions = {
  format?: string;
};

type MultisdkInitCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  out: string;
};

type MultisdkLanguageCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language: string;
};

type MultisdkProfileCommandOptions = FormatCommandOptions & {
  language: string;
  profile?: string;
};

type MultisdkVerifyCommandOptions = FormatCommandOptions & {
  language: string;
  evidence: string;
  command: string;
  profile?: string;
  sdkVersion?: string;
  sourceCommit?: string;
  endpoint?: string;
};

type MultisdkApplyCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language: string;
  write?: boolean;
  yes?: boolean;
};

type MultisdkLandDocsCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language: string;
  repo: string;
  target: string;
  base?: string;
  branch?: string;
  commitMessage?: string;
  write?: boolean;
};

export function registerMultisdkCommands(program: Command, context: CliContext): void {
  const multisdk = program
    .command('multisdk')
    .description('run a resumable multi-SDK code-block completion workflow');

  multisdk
    .command('init')
    .description('initialize a multi-SDK task from a Feishu document')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--out <dir>', 'task directory, for example runs/<doc-token>')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: MultisdkInitCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      const result = await initMultisdkTask({
        document: feishuDoc,
        documentId,
        taskDir: opts.out,
        inventory: buildCodeBlockInventory(documentId, blocks)
      });
      const environmentPath = await writeHarnessEnvironment(
        opts.out,
        await buildHarnessEnvironmentReport({ envLoadReport: context.envLoadReport })
      );
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        manifestPath: `${opts.out}/manifest.json`,
        environmentPath,
        files: result.files
      }, opts.format);
    });

  multisdk
    .command('status')
    .description('show multi-SDK task progress')
    .argument('<task-dir>', 'multi-SDK task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: FormatCommandOptions) => {
      printFormatted(summarizeMultisdkTask(await loadMultisdkTask(taskDir)), opts.format);
    });

  multisdk
    .command('export')
    .description('refresh snippet files for one SDK language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkLanguageCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const task = await loadMultisdkTask(taskDir);
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const blocks = await client.getDocumentBlocks(task.documentId);
      const result = await exportMultisdkLanguage({
        document: task.document,
        taskDir,
        language,
        inventory: buildCodeBlockInventory(task.documentId, blocks)
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        files: result.files
      }, opts.format);
    });

  multisdk
    .command('profile')
    .description('show recommended validation profiles for one SDK language')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--profile <profile>', 'specific validation profile id')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (opts: MultisdkProfileCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const defaultProfile = safeDefaultValidationProfile(language);
      const profiles = opts.profile
        ? [getValidationProfile(language, opts.profile)]
        : listValidationProfiles(language);
      printFormatted({
        language,
        defaultProfile: defaultProfile?.id ?? null,
        profiles
      }, opts.format);
    });

  multisdk
    .command('verify')
    .description('record validation evidence for one SDK language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .requiredOption('--evidence <file>', 'validation evidence file')
    .requiredOption('--command <command>', 'validation command that produced the evidence')
    .option('--profile <profile>', 'validation profile id, for example manta-k8s-maven')
    .option('--sdk-version <version>', 'SDK version proven by the validation evidence')
    .option('--source-commit <sha>', 'SDK source commit proven by the validation evidence')
    .option('--endpoint <endpoint>', 'validation endpoint or environment name')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkVerifyCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const task = await recordMultisdkVerification({
        taskDir,
        language,
        evidencePath: opts.evidence,
        command: opts.command,
        profile: opts.profile,
        sdkVersion: opts.sdkVersion,
        sourceCommit: opts.sourceCommit,
        endpoint: opts.endpoint
      });
      printFormatted(summarizeMultisdkTask(task), opts.format);
    });

  multisdk
    .command('diff')
    .description('show a block-level diff for one SDK language before apply')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkLanguageCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const task = await loadMultisdkTask(taskDir);
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const result = await diffMultisdkLanguage({ taskDir, language, client });
      if (opts.format === 'json') {
        printFormatted({
          task: summarizeMultisdkTask(task),
          report: result.report
        }, opts.format);
        return;
      }
      stdout.write(renderCodeBlockDiffReport(result.report));
    });

  multisdk
    .command('apply')
    .description('dry-run or write one SDK language from a multi-SDK task')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkApplyCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const write = normalizeBooleanOption(program, opts, 'write', '--write');
      const yes = normalizeBooleanOption(program, opts, 'yes', '--yes') || optionFlagFromArgv('-y');
      const task = await loadMultisdkTask(taskDir);
      if (write && !yes) {
        const rl = readline.createInterface({ input, output: stdout });
        const answer = await rl.question(`Apply ${language} snippets in ${task.documentId}? [y/N] `);
        rl.close();
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          throw new Error('Multi-SDK apply cancelled.');
        }
      }
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const result = await applyMultisdkLanguage({ taskDir, language, write, client });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        report: result.report
      }, opts.format);
    });

  multisdk
    .command('audit')
    .description('read back and audit one SDK language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkLanguageCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const task = await loadMultisdkTask(taskDir);
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const blocks = await client.getDocumentBlocks(task.documentId);
      const result = await auditMultisdkLanguage({
        taskDir,
        language,
        inventory: buildCodeBlockInventory(task.documentId, blocks)
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        report: result.report
      }, opts.format);
    });

  multisdk
    .command('land-docs')
    .description('patch reviewed Feishu code blocks into a local docs repo target file')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .requiredOption('--repo <path>', 'local docs repository path')
    .requiredOption('--target <file>', 'target Markdown file path relative to --repo')
    .option('--base <ref>', 'upstream base ref used for branch hygiene, for example upstream/v3.0.x')
    .option('--branch <branch>', 'intended clean topic branch name')
    .option('--commit-message <message>', 'commit message for the clean-branch handoff')
    .option('--write', 'write the patched docs file and reviewed baseline; omitted means dry-run')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkLandDocsCommandOptions) => {
      const language = parseMultisdkLanguage(opts.language);
      const task = await loadMultisdkTask(taskDir);
      const state = task.languages[language];
      if (!state.auditPassed) {
        throw new Error(`${language} land-docs requires a passing multisdk audit. Run multisdk audit --language ${language} first.`);
      }

      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const reviewedMarkdown = await pullRemoteMarkdown(client, task.documentId);
      const write = normalizeBooleanOption(program, opts, 'write', '--write');
      const git = opts.base
        ? await buildDocsLandingGitReport({
          repo: opts.repo,
          baseRef: opts.base,
          branch: opts.branch,
          target: opts.target,
          language,
          commitMessage: opts.commitMessage ?? defaultLandDocsCommitMessage(language, opts.target)
        })
        : undefined;

      if (write && git && !git.hygiene.passed) {
        throw new Error(`Refusing docs landing write because branch hygiene failed: ${git.hygiene.warnings.join('; ')}`);
      }

      const landing = await landMultisdkDocs({
        taskDir,
        language,
        repo: opts.repo,
        target: opts.target,
        reviewedMarkdown,
        write
      });
      const updatedTask = write
        ? {
          ...task,
          docsLandings: [
            ...(task.docsLandings ?? []),
            {
              language,
              repo: opts.repo,
              target: opts.target,
              reviewedBaselinePath: landing.reviewedBaselinePath ?? '',
              mode: 'write' as const,
              baseRef: opts.base,
              branch: git?.cleanBranchPlan.branch,
              commitMessage: git?.cleanBranchPlan.commitMessage ?? opts.commitMessage,
              recordedAt: new Date().toISOString()
            }
          ]
        }
        : task;
      if (write) await saveMultisdkTask(updatedTask);
      printFormatted({
        task: summarizeMultisdkTask(updatedTask),
        landing,
        git
      }, opts.format);
    });

  multisdk
    .command('finalize')
    .description('run full multi-SDK audit and write handoff summary')
    .argument('<task-dir>', 'multi-SDK task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: BaseCommandOptions & FormatCommandOptions) => {
      const task = await loadMultisdkTask(taskDir);
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const blocks = await client.getDocumentBlocks(task.documentId);
      const result = await finalizeMultisdkTask({
        taskDir,
        inventory: buildCodeBlockInventory(task.documentId, blocks)
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        report: result.report,
        handoffPath: result.handoffPath
      }, opts.format);
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

async function resolveDocumentId(client: FeishuClient, feishuDoc: string): Promise<string> {
  const target = parseFeishuTarget(feishuDoc);
  return target.kind === 'wiki' ? await client.resolveWikiNode(target.token) : target.token;
}

async function buildDocsLandingGitReport(input: {
  repo: string;
  baseRef: string;
  branch?: string;
  target: string;
  language: ReturnType<typeof parseMultisdkLanguage>;
  commitMessage: string;
}) {
  const currentBranch = await gitOutput(input.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commitsRelativeToBase = (await gitOutput(input.repo, ['log', '--oneline', `${input.baseRef}..HEAD`]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const intendedBranch = input.branch ?? suggestTopicBranch({
    baseRef: input.baseRef,
    target: input.target,
    language: input.language
  });
  const hygiene = assessPrBranchHygiene({
    baseRef: input.baseRef,
    currentBranch,
    intendedBranch,
    target: input.target,
    language: input.language,
    commitsRelativeToBase
  });
  const cleanBranchPlan = buildCleanBranchPlan({
    baseRef: input.baseRef,
    branch: intendedBranch,
    target: input.target,
    commitMessage: input.commitMessage
  });
  return {
    hygiene,
    cleanBranchPlan
  };
}

async function gitOutput(repo: string, args: string[]): Promise<string> {
  const { stdout: output } = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 10 * 1024 * 1024 });
  return output.trim();
}

function defaultLandDocsCommitMessage(language: string, target: string): string {
  const name = target.split('/').at(-1)?.replace(/\.[^.]+$/, '') || 'docs';
  return `docs: update ${language} examples in ${name}`;
}

function safeDefaultValidationProfile(language: ReturnType<typeof parseMultisdkLanguage>) {
  try {
    return defaultValidationProfile(language);
  } catch {
    return null;
  }
}
