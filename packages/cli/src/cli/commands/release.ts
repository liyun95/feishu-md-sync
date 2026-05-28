import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import type { FeishuClient } from '../../feishu/client.js';
import { planReleaseApply, writeReleaseApply, type ReleaseVariableChange } from '../../release/apply.js';
import { auditLinks, auditReleaseNotes, auditVariables, type LinkTarget, type VariablesAudit } from '../../release/audit.js';
import { renderReleaseReportMarkdown, serializeReleaseReportJson, type ReleaseReport } from '../../release/report.js';
import { buildSdkTagMatrix, DEFAULT_SDK_SOURCES, type SdkSource } from '../../release/sdk-tags.js';
import { hashReleaseReport, loadReleaseTask, saveReleaseTask, summarizeReleaseTask, type ReleaseUserDoc } from '../../release/task.js';
import {
  approveReleaseWorkflow,
  initReleaseWorkflow,
  pullReleaseNotesWorkflow,
  scanSdkTagsWorkflow,
  statusReleaseWorkflow
} from '../../release/workflow.js';
import { unifiedDiff } from '../../sync/diff.js';
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

type ReleaseInitCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  releaseLine: string;
  version: string;
  releaseDoc: string;
  milvusDocs: string;
  out: string;
  userDoc?: string[];
  linkMap?: string;
};

type ReleaseApproveCommandOptions = FormatCommandOptions & {
  by: string;
};

type ReleaseApplyCommandOptions = FormatCommandOptions & {
  write?: boolean;
};

export function registerReleaseCommands(program: Command, context: CliContext): void {
  const release = program
    .command('release')
    .description('run a gated Milvus release notes workflow');

  release
    .command('init')
    .description('initialize a release notes task')
    .requiredOption('--release-line <line>', 'release line, for example 2.6.x')
    .requiredOption('--version <version>', 'release version, for example 2.6.17')
    .requiredOption('--release-doc <doc>', 'Feishu release note docx/wiki URL or token')
    .requiredOption('--milvus-docs <path>', 'local Milvus docs repository path')
    .requiredOption('--out <dir>', 'task directory, for example runs/releases/2.6.17')
    .option('--user-doc <mapping>', 'repeatable local-path=feishu-url user-doc mapping', collectOption, [])
    .option('--link-map <file>', 'optional release link map JSON path')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (opts: ReleaseInitCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, opts.releaseDoc);
      const task = await initReleaseWorkflow({
        releaseLine: opts.releaseLine,
        releaseVersion: opts.version,
        releaseDoc: opts.releaseDoc,
        documentId,
        milvusDocsPath: opts.milvusDocs,
        taskDir: opts.out,
        userDocs: parseReleaseUserDocs(opts.userDoc ?? []),
        linkMapPath: opts.linkMap
      });
      printFormatted({ task }, opts.format);
    });

  release
    .command('pull')
    .description('pull Feishu release notes into the task snapshot')
    .argument('<task-dir>', 'release task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (taskDir: string, opts: BaseCommandOptions & FormatCommandOptions) => {
      const task = await loadReleaseTask(taskDir);
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, task.releaseDoc);
      const markdown = await pullRemoteMarkdown(client, documentId);
      const updated = await pullReleaseNotesWorkflow({ taskDir, markdown });
      printFormatted({ task: updated, output: `${taskDir}/feishu/release-notes.remote.md` }, opts.format);
    });

  release
    .command('scan-sdk-tags')
    .description('scan SDK tag sources and write a version matrix')
    .argument('<task-dir>', 'release task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: FormatCommandOptions) => {
      const task = await loadReleaseTask(taskDir);
      const matrix = await buildSdkTagMatrix({
        releaseLine: task.releaseLine,
        reader: gitRemoteTagReader,
        sources: DEFAULT_SDK_SOURCES
      });
      const updated = await scanSdkTagsWorkflow({ taskDir, matrix });
      printFormatted({ task: updated, matrixPath: `${taskDir}/sdk/tags.json` }, opts.format);
    });

  release
    .command('audit')
    .description('audit release notes, Variables.json, and user-doc links')
    .argument('<task-dir>', 'release task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: FormatCommandOptions) => {
      const task = await loadReleaseTask(taskDir);
      const [remoteMarkdown, matrixJson, variablesJson, localReleaseNotes] = await Promise.all([
        readFile(join(taskDir, 'feishu/release-notes.remote.md'), 'utf8'),
        readFile(join(taskDir, 'sdk/tags.json'), 'utf8'),
        readFile(join(task.milvusDocsPath, 'site/en/Variables.json'), 'utf8'),
        readFile(join(task.milvusDocsPath, 'site/en/release_notes.md'), 'utf8')
      ]);
      const matrix = JSON.parse(matrixJson);
      const variables = auditVariables({
        variablesJson,
        matrix,
        variableNames: {
          python: 'milvus_python_sdk_real_version',
          java: 'milvus_java_sdk_real_version',
          nodejs: 'milvus_node_sdk_real_version',
          go: 'milvus_go_sdk_real_version',
          rest: 'milvus_restful_sdk_real_version'
        }
      });
      const releaseNotes = auditReleaseNotes({
        releaseVersion: task.releaseVersion,
        localMarkdown: localReleaseNotes,
        remoteMarkdown
      });
      const links = await auditLinks({
        milvusDocsPath: task.milvusDocsPath,
        releaseMarkdown: remoteMarkdown,
        linkTargets: await loadReleaseLinkTargets(task.linkMapPath)
      });
      const blocked = [
        ...matrix.blocked.map((item: { sdk: string; reason: string }) => `${item.sdk}: ${item.reason}`),
        ...variables.changes.filter((change) => change.status !== 'match').map((change) => `${change.variable}: ${change.status}`),
        ...(releaseNotes.passed ? [] : [releaseNotes.message]),
        ...links.items.filter((item) => item.status !== 'ok').map(formatBlockedLinkItem)
      ];
      const report: ReleaseReport = {
        kind: 'feishu-release-report',
        version: 1,
        generatedAt: new Date().toISOString(),
        task: summarizeReleaseTask({ ...task, status: 'audited', steps: { ...task.steps, audited: true } }),
        sdkTags: matrix,
        audits: { variables, releaseNotes, links },
        summary: {
          passed: blocked.length === 0,
          blocked
        }
      };
      const reportJson = serializeReleaseReportJson(report);
      const reportMarkdown = renderReleaseReportMarkdown(report);
      await mkdir(join(taskDir, 'audit'), { recursive: true });
      await Promise.all([
        writeFile(join(taskDir, 'audit/variables.diff.md'), renderVariablesAuditMarkdown(variables), 'utf8'),
        writeFile(join(taskDir, 'audit/release-notes.diff.md'), unifiedDiff('site/en/release_notes.md', 'feishu/release-notes.remote.md', localReleaseNotes, releaseNotes.proposedSection), 'utf8'),
        writeFile(join(taskDir, 'audit/links.json'), `${JSON.stringify(links, null, 2)}\n`, 'utf8'),
        writeFile(join(taskDir, 'audit/report.json'), reportJson, 'utf8'),
        writeFile(join(taskDir, 'audit/report.md'), reportMarkdown, 'utf8')
      ]);
      const updated = {
        ...task,
        status: 'audited' as const,
        steps: {
          ...task.steps,
          audited: true,
          approved: false,
          dryRunPassed: false,
          writePassed: false
        },
        reportHash: null,
        approval: null
      };
      await saveReleaseTask(updated);
      printFormatted({ task: updated, report: `${taskDir}/audit/report.md`, passed: report.summary.passed }, opts.format);
    });

  release
    .command('approve')
    .description('approve the current release report hash')
    .argument('<task-dir>', 'release task directory')
    .requiredOption('--by <name>', 'approver name')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: ReleaseApproveCommandOptions) => {
      const task = await approveReleaseWorkflow({ taskDir, approvedBy: opts.by });
      printFormatted({ task }, opts.format);
    });

  release
    .command('apply')
    .description('dry-run or write approved release docs changes')
    .argument('<task-dir>', 'release task directory')
    .option('--write', 'write local Milvus docs files; omitted means dry-run')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: ReleaseApplyCommandOptions) => {
      const task = await loadReleaseTask(taskDir);
      const [reportJson, reportMarkdown] = await Promise.all([
        readFile(join(taskDir, 'audit/report.json'), 'utf8'),
        readFile(join(taskDir, 'audit/report.md'), 'utf8')
      ]);
      const report = JSON.parse(reportJson) as ReleaseReport;
      if (!report.audits.releaseNotes) {
        throw new Error('release apply requires release notes audit output.');
      }
      const plan = await planReleaseApply({
        milvusDocsPath: task.milvusDocsPath,
        releaseNotesSection: report.audits.releaseNotes.proposedSection,
        variableChanges: variableChangesForApply(report)
      });
      const currentReportHash = hashReleaseReport({ reportJson, reportMarkdown });
      const write = normalizeBooleanOption(program, opts, 'write', '--write');
      if (write && !report.summary.passed) {
        throw new Error(`release apply --write requires a passing report. Blocked items: ${report.summary.blocked.join('; ')}`);
      }
      if (!write) {
        const updated = {
          ...task,
          status: 'dry-run-passed' as const,
          steps: {
            ...task.steps,
            dryRunPassed: true,
            writePassed: false
          }
        };
        await saveReleaseTask(updated);
        printFormatted({ task: updated, files: plan.files.map((file) => ({ path: file.path, diff: file.diff })) }, opts.format);
        return;
      }
      const updated = await writeReleaseApply({ task, currentReportHash, plan });
      await saveReleaseTask(updated);
      printFormatted({ task: updated, files: plan.files.map((file) => file.path) }, opts.format);
    });

  release
    .command('status')
    .description('show release task progress')
    .argument('<task-dir>', 'release task directory')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (taskDir: string, opts: FormatCommandOptions) => {
      printFormatted(await statusReleaseWorkflow(taskDir), opts.format);
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

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseReleaseUserDocs(values: string[]): ReleaseUserDoc[] {
  return values.map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Invalid --user-doc ${value}. Expected local/path.md=feishu-url.`);
    }
    return {
      localPath: value.slice(0, separator),
      feishuDoc: value.slice(separator + 1)
    };
  });
}

async function gitRemoteTagReader(source: SdkSource): Promise<string[]> {
  const url = releaseSdkRemoteUrl(source);
  const { stdout: output } = await execFileAsync('git', ['ls-remote', '--tags', url], { maxBuffer: 10 * 1024 * 1024 });
  return Array.from(new Set(output
    .split(/\r?\n/)
    .map((line) => /refs\/tags\/(.+?)(\^\{\})?$/.exec(line)?.[1])
    .filter((tag): tag is string => Boolean(tag))));
}

function releaseSdkRemoteUrl(source: SdkSource): string {
  switch (source.sdk) {
    case 'python':
      return 'https://github.com/milvus-io/pymilvus.git';
    case 'java':
      return 'https://github.com/milvus-io/milvus-sdk-java.git';
    case 'nodejs':
      return 'https://github.com/milvus-io/milvus-sdk-node.git';
    case 'go':
    case 'rest':
      return 'https://github.com/milvus-io/milvus.git';
  }
}

async function loadReleaseLinkTargets(linkMapPath: string | undefined): Promise<LinkTarget[]> {
  if (!linkMapPath) return [];
  const parsed = JSON.parse(await readFile(linkMapPath, 'utf8')) as unknown;
  const targets = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { targets?: unknown }).targets)
      ? (parsed as { targets: unknown[] }).targets
      : null;
  if (!targets) {
    throw new Error(`Invalid release link map ${linkMapPath}. Expected an array or an object with a targets array.`);
  }
  return targets.map((target) => {
    if (!target || typeof target !== 'object') {
      throw new Error(`Invalid release link map ${linkMapPath}. Each target must be an object.`);
    }
    const record = target as Record<string, unknown>;
    if (typeof record.keyword !== 'string' || typeof record.localPath !== 'string' || typeof record.anchor !== 'string') {
      throw new Error(`Invalid release link map ${linkMapPath}. Targets require keyword, localPath, and anchor strings.`);
    }
    return {
      keyword: record.keyword,
      localPath: record.localPath,
      anchor: record.anchor,
      requiredLanguages: parseRequiredLinkLanguages(record.requiredLanguages, linkMapPath)
    };
  });
}

function parseRequiredLinkLanguages(value: unknown, linkMapPath: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new Error(`Invalid release link map ${linkMapPath}. requiredLanguages must be an array of strings.`);
}

function formatBlockedLinkItem(item: LinkTarget & {
  status: string;
  missingLanguages: Array<{ language: string }>;
  placeholderIssues: Array<{ language: string; line?: number; placeholder?: string }>;
}): string {
  if (item.status === 'missing-language') {
    return `${item.keyword}: missing-language (${item.missingLanguages.map((issue) => issue.language).join(', ')})`;
  }
  if (item.status === 'placeholder') {
    const details = item.placeholderIssues
      .map((issue) => `${issue.language}${issue.line ? ` line ${issue.line}` : ''}`)
      .join(', ');
    return `${item.keyword}: placeholder (${details})`;
  }
  return `${item.keyword}: ${item.status}`;
}

function renderVariablesAuditMarkdown(audit: VariablesAudit): string {
  const lines = [
    '# Variables Audit',
    '',
    '| Variable | Current | Expected | Status |',
    '| --- | --- | --- | --- |'
  ];
  for (const change of audit.changes) {
    lines.push(`| ${change.variable} | ${change.currentValue ?? ''} | ${change.expectedValue ?? ''} | ${change.status} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function variableChangesForApply(report: ReleaseReport): ReleaseVariableChange[] {
  return report.audits.variables?.changes
    .filter((change) => (change.status === 'change' || change.status === 'missing') && typeof change.expectedValue === 'string')
    .map((change) => ({ variable: change.variable, expectedValue: change.expectedValue })) ?? [];
}
