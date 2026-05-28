import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import type { Command } from 'commander';
import { parseFeishuTarget } from '../../core/doc-id.js';
import {
  buildCodeBlockInventory,
  findTargetCodeBlocks,
  normalizeCodeBlockLanguage,
  type CanonicalCodeBlockLanguage
} from '../../feishu/code-blocks.js';
import type { FeishuClient } from '../../feishu/client.js';
import { applyCodeBlockManifest } from '../../sync/code-block-apply.js';
import { auditCodeBlockInventory } from '../../sync/code-block-audit.js';
import { exportCodeBlockSnippets } from '../../sync/code-block-export.js';
import { planCodeBlockManifest, summarizeCodeBlockManifest } from '../../sync/code-block-plan.js';
import { updateCodeBlock } from '../../sync/code-block-update.js';
import type { CliContext } from '../context.js';
import { printFormatted, printJson, setFailedExitCode } from '../output.js';

type BaseCommandOptions = {
  host?: string;
  timeoutMs?: number;
};

type FormatCommandOptions = {
  format?: string;
};

type CodeBlockInspectCommandOptions = BaseCommandOptions & FormatCommandOptions;

type CodeBlockPlanCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  expect: string;
  out: string;
  snippetsDir: string;
};

type CodeBlockExportCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  expect: string;
  out: string;
  manifest: string;
};

type CodeBlockApplyCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  manifest: string;
  write?: boolean;
  yes?: boolean;
};

type CodeBlockAuditCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  expect: string;
  allowPlaceholders?: string;
};

type CodeBlockUpdateCommandOptions = BaseCommandOptions & {
  language: string;
  blockId: string;
  file: string;
  write?: boolean;
  yes?: boolean;
};

export function registerCodeBlockCommands(program: Command, context: CliContext): void {
  const codeBlocks = program
    .command('code-blocks')
    .description('inspect or update Feishu docx code blocks without replacing the whole document');

  codeBlocks
    .command('inspect')
    .description('list supported placeholder code blocks in a Feishu docx document')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockInspectCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      if (opts.format === 'json') {
        printJson(buildCodeBlockInventory(documentId, blocks));
        return;
      }
      const targets = findTargetCodeBlocks(blocks);

      for (const target of targets) {
        console.log(`${target.language}\t${target.blockId}\t${target.text}`);
      }
    });

  codeBlocks
    .command('plan')
    .description('create a mixed update/insert code-block manifest')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--expect <languages>', 'comma-separated expected languages')
    .requiredOption('--out <file>', 'manifest output path')
    .option('--snippets-dir <dir>', 'snippet path prefix stored in the manifest', 'snippets')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockPlanCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      const manifest = planCodeBlockManifest({
        document: feishuDoc,
        inventory: buildCodeBlockInventory(documentId, blocks),
        expectLanguages: parseCsv(opts.expect),
        snippetsDir: opts.snippetsDir
      });
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const summary = summarizeCodeBlockManifest(manifest, opts.out);
      printFormatted(summary, opts.format);
    });

  codeBlocks
    .command('export')
    .description('export discovered code blocks to snippet files and write a manifest')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--out <dir>', 'snippet output directory')
    .requiredOption('--manifest <file>', 'manifest output path')
    .requiredOption('--expect <languages>', 'comma-separated expected languages')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockExportCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      const result = await exportCodeBlockSnippets({
        document: feishuDoc,
        inventory: buildCodeBlockInventory(documentId, blocks),
        expectLanguages: parseCsv(opts.expect),
        outDir: opts.out,
        manifestPath: opts.manifest
      });
      printFormatted({
        manifestPath: opts.manifest,
        files: result.files,
        planned: summarizeCodeBlockManifest(result.manifest).planned
      }, opts.format);
    });

  codeBlocks
    .command('apply')
    .description('apply a mixed update/insert code-block manifest')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--manifest <file>', 'manifest path')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockApplyCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const write = normalizeBooleanOption(program, opts, 'write', '--write');
      const yes = normalizeBooleanOption(program, opts, 'yes', '--yes') || optionFlagFromArgv('-y');
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      if (write && !yes) {
        const rl = readline.createInterface({ input, output: stdout });
        const answer = await rl.question(`Apply code-block manifest ${opts.manifest}? [y/N] `);
        rl.close();
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          throw new Error('Code block apply cancelled.');
        }
      }
      const report = await applyCodeBlockManifest(client, {
        manifestPath: opts.manifest,
        write,
        expectedDocumentId: documentId
      });
      printFormatted(report, opts.format);
      setFailedExitCode(report.failed.length > 0);
    });

  codeBlocks
    .command('audit')
    .description('audit expected code-block languages, ordering, and placeholders')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--expect <languages>', 'comma-separated expected languages')
    .option('--allow-placeholders <languages>', 'comma-separated languages allowed to remain placeholders')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockAuditCommandOptions) => {
      const normalized = normalizeBaseOptions(program, opts);
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);
      const blocks = await client.getDocumentBlocks(documentId);
      const report = auditCodeBlockInventory(buildCodeBlockInventory(documentId, blocks), {
        expectLanguages: parseCsv(opts.expect),
        allowPlaceholders: opts.allowPlaceholders ? parseCsv(opts.allowPlaceholders) : []
      });
      printFormatted(report, opts.format);
      setFailedExitCode(!report.passed);
    });

  codeBlocks
    .command('update')
    .description('update one existing Feishu code block by block ID')
    .argument('<feishu-doc>', 'Feishu docx ID or URL')
    .requiredOption('--language <language>', 'target language: java | nodejs | restful | go')
    .requiredOption('--block-id <id>', 'Feishu code block ID to update')
    .requiredOption('--file <file>', 'file containing the verified code snippet')
    .option('--write', 'write to Feishu; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (feishuDoc: string, opts: CodeBlockUpdateCommandOptions) => {
      const normalized = normalizeCodeBlockUpdateOptions(program, opts);
      const language = parseCodeBlockLanguage(normalized.language);
      const content = await readFile(normalized.file, 'utf8');
      const client = context.createFeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
      const documentId = await resolveDocumentId(client, feishuDoc);

      if (normalized.write && !normalized.yes) {
        const rl = readline.createInterface({ input, output: stdout });
        const answer = await rl.question(`Update ${language} code block ${normalized.blockId} in ${documentId}? [y/N] `);
        rl.close();
        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          throw new Error('Code block update cancelled.');
        }
      }

      const result = await updateCodeBlock(client, {
        documentId,
        blockId: normalized.blockId,
        content,
        language,
        dryRun: !normalized.write
      });

      console.log(`${result.mode}: code-block-update`);
      console.log(`document: ${result.documentId}`);
      console.log(`block: ${result.blockId}`);
      console.log(`language: ${language}`);
      console.log(`content bytes: ${Buffer.byteLength(content, 'utf8')}`);
      if (result.mode === 'write') {
        console.log(`updated blocks: ${result.updatedBlocks.length}`);
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

function normalizeCodeBlockUpdateOptions(
  program: Command,
  opts: CodeBlockUpdateCommandOptions
): CodeBlockUpdateCommandOptions & Required<BaseCommandOptions> {
  const base = normalizeBaseOptions(program, opts);
  return {
    ...base,
    language: opts.language,
    blockId: opts.blockId,
    file: opts.file,
    write: normalizeBooleanOption(program, opts, 'write', '--write'),
    yes: normalizeBooleanOption(program, opts, 'yes', '--yes') || optionFlagFromArgv('-y')
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

function parseCodeBlockLanguage(value: string): CanonicalCodeBlockLanguage {
  const language = normalizeCodeBlockLanguage(value);
  if (language && language !== 'python') {
    return language;
  }
  throw new Error(`Invalid --language ${value}. Expected java, javascript/nodejs, restful, or go.`);
}

function parseCsv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}
