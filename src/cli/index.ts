#!/usr/bin/env node
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout } from 'node:process';
import { Command } from 'commander';
import { parseFeishuTarget } from '../core/doc-id.js';
import { FeishuClient } from '../feishu/client.js';
import {
  buildCodeBlockInventory,
  findTargetCodeBlocks,
  normalizeCodeBlockLanguage,
  type CanonicalCodeBlockLanguage
} from '../feishu/code-blocks.js';
import { readReceipt, receiptPath } from '../receipts/receipt.js';
import { unifiedDiff } from '../sync/diff.js';
import { buildMergeInstructions, defaultMergedPath, threeWayMerge } from '../sync/merge.js';
import { pullRemoteMarkdown } from '../sync/pull.js';
import { runSync, type SyncStrategy } from '../sync/run-sync.js';
import { updateCodeBlock } from '../sync/code-block-update.js';
import { planCodeBlockManifest, summarizeCodeBlockManifest } from '../sync/code-block-plan.js';
import { exportCodeBlockSnippets } from '../sync/code-block-export.js';
import { applyCodeBlockManifest } from '../sync/code-block-apply.js';
import { auditCodeBlockInventory } from '../sync/code-block-audit.js';
import { getSyncStatus, type SyncStatusResult } from '../sync/status.js';
import { applyReferenceManifest } from '../reference/apply.js';
import { auditReferenceManifest } from '../reference/audit.js';
import { planReferenceManifestFromImpact, type ReferenceImpactMatrix } from '../reference/plan.js';
import { parseMultisdkLanguage } from '../multisdk/language.js';
import { loadMultisdkTask, summarizeMultisdkTask } from '../multisdk/task.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  exportMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../multisdk/workflow.js';

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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    const normalized = normalizeBaseOptions(opts);
    const write = normalizeBooleanOption(opts, 'write', '--write');
    const yes = normalizeBooleanOption(opts, 'yes', '--yes') || optionFlagFromArgv('-y');
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    if (report.failed.length > 0) process.exitCode = 1;
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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const blocks = await client.getDocumentBlocks(documentId);
    const report = auditCodeBlockInventory(buildCodeBlockInventory(documentId, blocks), {
      expectLanguages: parseCsv(opts.expect),
      allowPlaceholders: opts.allowPlaceholders ? parseCsv(opts.allowPlaceholders) : []
    });
    printFormatted(report, opts.format);
    if (!report.passed) process.exitCode = 1;
  });

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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const documentId = await resolveDocumentId(client, feishuDoc);
    const blocks = await client.getDocumentBlocks(documentId);
    const result = await initMultisdkTask({
      document: feishuDoc,
      documentId,
      taskDir: opts.out,
      inventory: buildCodeBlockInventory(documentId, blocks)
    });
    printFormatted({
      task: summarizeMultisdkTask(result.task),
      manifestPath: `${opts.out}/manifest.json`,
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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
  .command('verify')
  .description('record validation evidence for one SDK language')
  .argument('<task-dir>', 'multi-SDK task directory')
  .requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
  .requiredOption('--evidence <file>', 'validation evidence file')
  .requiredOption('--command <command>', 'validation command that produced the evidence')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (taskDir: string, opts: MultisdkVerifyCommandOptions) => {
    const language = parseMultisdkLanguage(opts.language);
    const task = await recordMultisdkVerification({
      taskDir,
      language,
      evidencePath: opts.evidence,
      command: opts.command
    });
    printFormatted(summarizeMultisdkTask(task), opts.format);
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
    const write = normalizeBooleanOption(opts, 'write', '--write');
    const yes = normalizeBooleanOption(opts, 'yes', '--yes') || optionFlagFromArgv('-y');
    const task = await loadMultisdkTask(taskDir);
    if (write && !yes) {
      const rl = readline.createInterface({ input, output: stdout });
      const answer = await rl.question(`Apply ${language} snippets in ${task.documentId}? [y/N] `);
      rl.close();
      if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        throw new Error('Multi-SDK apply cancelled.');
      }
    }
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
  .description('run full multi-SDK audit and write handoff summary')
  .argument('<task-dir>', 'multi-SDK task directory')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (taskDir: string, opts: BaseCommandOptions & FormatCommandOptions) => {
    const task = await loadMultisdkTask(taskDir);
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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

const reference = program
  .command('reference')
  .description('publish and audit SDK reference docs from explicit manifests');

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
    const normalized = normalizeBaseOptions(opts);
    const write = normalizeBooleanOption(opts, 'write', '--write');
    const yes = normalizeBooleanOption(opts, 'yes', '--yes') || optionFlagFromArgv('-y');
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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
    if (report.failed.length > 0) process.exitCode = 1;
  });

reference
  .command('audit')
  .description('read back resources referenced by an SDK reference publish manifest')
  .requiredOption('--manifest <file>', 'reference publish manifest path')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (opts: ReferenceAuditCommandOptions) => {
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const report = await auditReferenceManifest(client, { manifestPath: opts.manifest });
    printFormatted(report, opts.format);
    if (!report.passed) process.exitCode = 1;
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
    const normalized = normalizeCodeBlockUpdateOptions(opts);
    const language = parseCodeBlockLanguage(normalized.language);
    const content = await readFile(normalized.file, 'utf8');
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
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

type CodeBlockUpdateCommandOptions = BaseCommandOptions & {
  language: string;
  blockId: string;
  file: string;
  write?: boolean;
  yes?: boolean;
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

type MultisdkInitCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  out: string;
};

type MultisdkLanguageCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language: string;
};

type MultisdkVerifyCommandOptions = FormatCommandOptions & {
  language: string;
  evidence: string;
  command: string;
};

type MultisdkApplyCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  language: string;
  write?: boolean;
  yes?: boolean;
};

type ReferencePlanCommandOptions = FormatCommandOptions & {
  impact: string;
  out: string;
};

type ReferenceApplyCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  manifest: string;
  write?: boolean;
  yes?: boolean;
};

type ReferenceAuditCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  manifest: string;
};

type NormalizedSyncCommandOptions = SyncCommandOptions & Required<BaseCommandOptions> & { strategy: string };

function normalizeBaseOptions(opts: BaseCommandOptions): Required<BaseCommandOptions> {
  const globals = program.opts<BaseCommandOptions>();
  const argvHost = optionFromArgv('--host');
  const argvTimeout = optionFromArgv('--timeout-ms');
  return {
    host: argvHost ?? commandOptionValue<string>(opts, 'host') ?? globals.host ?? process.env.FEISHU_HOST ?? 'https://open.feishu.cn',
    timeoutMs: argvTimeout ? parseIntOption(argvTimeout) : commandOptionValue<number>(opts, 'timeoutMs') ?? globals.timeoutMs ?? 20_000
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

function normalizeCodeBlockUpdateOptions(
  opts: CodeBlockUpdateCommandOptions
): CodeBlockUpdateCommandOptions & Required<BaseCommandOptions> {
  const base = normalizeBaseOptions(opts);
  return {
    ...base,
    language: opts.language,
    blockId: opts.blockId,
    file: opts.file,
    write: normalizeBooleanOption(opts, 'write', '--write'),
    yes: normalizeBooleanOption(opts, 'yes', '--yes') || optionFlagFromArgv('-y')
  };
}

function normalizeBooleanOption(opts: unknown, key: string, flag: string): boolean {
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

function printFormatted(value: unknown, format = 'pretty'): void {
  if (format === 'json') {
    printJson(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
