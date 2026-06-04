import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { buildCodeBlockInventory } from '../../feishu/code-blocks.js';
import type { FeishuClient } from '../../feishu/client.js';
import { buildHarnessEnvironmentReport, writeHarnessEnvironment } from '../../harness/environment.js';
import { parseMilvusTarget } from '../../multisdk/environment.js';
import { parseMultisdkLanguage } from '../../multisdk/language.js';
import { runMantaValidation } from '../../multisdk/manta.js';
import { loadMultisdkTask, summarizeMultisdkTask, type MultisdkValidationRunner } from '../../multisdk/task.js';
import { defaultValidationProfile, getValidationProfile, listValidationProfiles } from '../../multisdk/validation-profile.js';
import {
  applyMultisdkLocalReview,
  authorMultisdkTask,
  auditMultisdkLanguage,
  configureMultisdkEnvironment,
  finalizeMultisdkTask,
  initMultisdkTask,
  prepareMultisdkTask,
  recordMultisdkPush,
  validateMultisdkTask
} from '../../multisdk/workflow.js';
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
  language?: string;
};

type MultisdkEnvironmentCommandOptions = FormatCommandOptions & {
  milvusVersion?: string;
  milvusSourceRepo?: string;
  milvusSourceRef?: string;
  runner?: string;
};

type MultisdkPrepareCommandOptions = FormatCommandOptions & {
  remoteMarkdown: string;
  snippet?: string[];
};

type MultisdkValidateCommandOptions = FormatCommandOptions & {
  runner?: string;
  command: string;
  evidence?: string;
  jobId?: string;
};

type MultisdkAuthorCommandOptions = FormatCommandOptions & {
  snippet?: string[];
};

type MultisdkApplyLocalCommandOptions = FormatCommandOptions & {
  remoteMarkdown: string;
  snippet?: string[];
};

type MultisdkRecordPushCommandOptions = FormatCommandOptions & {
  mode: string;
  command: string;
  result?: string;
};

type MultisdkLanguageCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language?: string;
};

type MultisdkProfileCommandOptions = FormatCommandOptions & {
  language: string;
  profile?: string;
};

export function registerMultisdkCommands(program: Command, context: CliContext): void {
  const multisdk = program
    .command('multisdk')
    .description('run a resumable multi-SDK local-first completion workflow');

  multisdk
    .command('init')
    .description('initialize a single-language multi-SDK task from a Feishu document')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--out <dir>', 'task directory, for example runs/<doc-token>-java')
    .option('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: MultisdkInitCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const language = parseRequiredMultisdkLanguage(opts.language);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      const result = await initMultisdkTask({
        document: feishuDoc,
        documentId,
        taskDir: opts.out,
        language,
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
    .command('environment')
    .description('record the Milvus target and validation runner for a multi-SDK task')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--milvus-version <version>', 'Milvus version the examples must validate against')
    .option('--milvus-source-repo <repo>', 'Milvus source repository for unreleased validation builds')
    .option('--milvus-source-ref <ref>', 'Milvus source branch, tag, or commit for unreleased validation builds')
    .option('--runner <runner>', 'validation runner: manta | local', 'manta')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkEnvironmentCommandOptions) => {
      const runner = parseValidationRunner(opts.runner);
      const task = await configureMultisdkEnvironment({
        taskDir,
        runner,
        milvusTarget: parseMilvusTarget(opts)
      });
      printFormatted(summarizeMultisdkTask(task), opts.format);
    });

  multisdk
    .command('prepare')
    .description('prepare verifier artifacts for the selected language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--remote-markdown <file>', 'pulled Feishu Markdown used as Python context')
    .option('--snippet <file...>', 'snippet files to include in the verifier')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkPrepareCommandOptions) => {
      const result = await prepareMultisdkTask({
        taskDir,
        remoteMarkdownPath: opts.remoteMarkdown,
        snippetPaths: opts.snippet ?? []
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        files: result.files,
        command: result.command
      }, opts.format);
    });

  multisdk
    .command('author')
    .description('record selected-language snippets authored from Python context')
    .argument('<task-dir>', 'multi-SDK task directory')
    .option('--snippet <file...>', 'authored snippet files to validate and copy into the verifier work area')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkAuthorCommandOptions) => {
      const result = await authorMultisdkTask({
        taskDir,
        snippetPaths: opts.snippet ?? []
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        files: result.files
      }, opts.format);
    });

  multisdk
    .command('validate')
    .description('record live Milvus validation evidence for the selected language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--command <command>', 'validation command run by the verifier')
    .option('--runner <runner>', 'validation runner: manta | local', 'manta')
    .option('--evidence <file>', 'existing validation evidence file')
    .option('--job-id <job>', 'Manta job id when evidence was collected separately')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkValidateCommandOptions) => {
      const runner = parseValidationRunner(opts.runner);
      let evidencePath = opts.evidence;
      let jobId = opts.jobId;

      if (runner === 'manta' && !evidencePath) {
        const task = await loadMultisdkTask(taskDir);
        if (!task.milvusTarget) throw new Error('multisdk validate requires a configured Milvus target.');
        const result = await runMantaValidation({
          taskDir,
          language: task.language,
          command: opts.command,
          milvusTarget: task.milvusTarget,
          exec: async (command, args) => {
            const output = await execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });
            return { stdout: output.stdout, stderr: output.stderr };
          }
        });
        jobId = result.jobId;
        await mkdir(join(taskDir, 'evidence'), { recursive: true });
        evidencePath = join(taskDir, 'evidence', `manta-${result.jobId}.log`);
        await writeFile(evidencePath, result.logs, 'utf8');
      }

      if (!evidencePath) {
        throw new Error('multisdk validate requires --evidence for local validation, or --runner manta so evidence can be collected.');
      }

      const task = await validateMultisdkTask({
        taskDir,
        command: opts.command,
        evidencePath,
        runner,
        jobId
      });
      printFormatted(summarizeMultisdkTask(task), opts.format);
    });

  multisdk
    .command('apply-local')
    .description('write reviewed examples into local Markdown without writing Feishu')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--remote-markdown <file>', 'pulled Feishu Markdown to patch')
    .option('--snippet <file...>', 'snippet files to insert after Python examples')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkApplyLocalCommandOptions) => {
      const result = await applyMultisdkLocalReview({
        taskDir,
        remoteMarkdownPath: opts.remoteMarkdown,
        snippetPaths: opts.snippet ?? []
      });
      printFormatted({
        task: summarizeMultisdkTask(result.task),
        markdownPath: result.markdownPath,
        diffPath: result.diffPath
      }, opts.format);
    });

  multisdk
    .command('record-push')
    .description('record an approved push dry-run or write for a multi-SDK task')
    .argument('<task-dir>', 'multi-SDK task directory')
    .requiredOption('--mode <mode>', 'push mode: dry-run | write')
    .requiredOption('--command <command>', 'push command that was reviewed or executed')
    .option('--result <file>', 'push result artifact path')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: MultisdkRecordPushCommandOptions) => {
      const task = await recordMultisdkPush({
        taskDir,
        mode: parsePushMode(opts.mode),
        command: opts.command,
        resultPath: opts.result
      });
      printFormatted(summarizeMultisdkTask(task), opts.format);
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
    .command('audit')
    .description('read back and audit the selected SDK language')
    .argument('<task-dir>', 'multi-SDK task directory')
    .option('--language <language>', 'target language override; must match task language')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: MultisdkLanguageCommandOptions) => {
      const task = await loadMultisdkTask(taskDir);
      const language = opts.language ? parseMultisdkLanguage(opts.language) : task.language;
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
    .command('finalize')
    .description('run final selected-language audit and write handoff summary')
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

  hideLegacyCommand(multisdk
    .command('export')
    .description('legacy Feishu-direct code-block operation; prefer multisdk apply-local plus md2feishu push'))
    .action(() => {
      throw new Error('multisdk export is a legacy Feishu-direct command. Use multisdk init --language and multisdk prepare.');
    });

  hideLegacyCommand(multisdk
    .command('verify')
    .description('legacy Feishu-direct code-block operation; prefer multisdk validate'))
    .action(() => {
      throw new Error('multisdk verify is a legacy command. Use multisdk validate.');
    });

  hideLegacyCommand(multisdk
    .command('diff')
    .description('legacy Feishu-direct code-block operation; prefer multisdk apply-local plus md2feishu push'))
    .action(() => {
      throw new Error('multisdk diff is a legacy Feishu-direct command. Use multisdk apply-local and inspect outputs/review.diff.');
    });

  hideLegacyCommand(multisdk
    .command('apply')
    .description('legacy Feishu-direct code-block operation; prefer multisdk apply-local plus md2feishu push'))
    .action(() => {
      throw new Error('multisdk apply is a legacy Feishu-direct command. Use multisdk apply-local plus md2feishu push.');
    });

  hideLegacyCommand(multisdk
    .command('land-docs')
    .description('legacy Feishu-direct code-block operation; prefer multisdk apply-local plus md2feishu push'))
    .action(() => {
      throw new Error('multisdk land-docs is a legacy command. Use multisdk apply-local plus md2feishu push.');
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

function parseValidationRunner(value: string | undefined): MultisdkValidationRunner {
  if (value === undefined || value === 'manta') return 'manta';
  if (value === 'local') return 'local';
  throw new Error(`Invalid --runner ${value}. Expected manta or local.`);
}

function parseRequiredMultisdkLanguage(value: string | undefined): ReturnType<typeof parseMultisdkLanguage> {
  if (!value?.trim()) {
    throw new Error('Ask the user which target SDK language to complete before running multisdk init. Expected one of: java, javascript/node/nodejs/js, go, or restful.');
  }
  return parseMultisdkLanguage(value);
}

function parsePushMode(value: string): 'dry-run' | 'write' {
  if (value === 'dry-run' || value === 'write') return value;
  throw new Error(`Invalid --mode ${value}. Expected dry-run or write.`);
}

function safeDefaultValidationProfile(language: ReturnType<typeof parseMultisdkLanguage>) {
  try {
    return defaultValidationProfile(language);
  } catch {
    return null;
  }
}

function hideLegacyCommand(command: Command): Command {
  const maybeHidden = command as Command & { hideHelp?: () => Command };
  return maybeHidden.hideHelp ? maybeHidden.hideHelp() : command;
}
