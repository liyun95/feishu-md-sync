import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { CodeBlockInventory } from '../feishu/code-blocks.js';
import {
  applyCodeBlockManifest,
  type CodeBlockApplyClient,
  type CodeBlockApplyReport
} from '../sync/code-block-apply.js';
import { auditCodeBlockInventory, type CodeBlockAuditReport } from '../sync/code-block-audit.js';
import { exportCodeBlockSnippets, loadCodeBlockManifest } from '../sync/code-block-export.js';
import type { CodeBlockManifest } from '../sync/code-block-plan.js';
import { mergeLanguageManifestItems, writeLanguageScopedManifest } from './manifest.js';
import { MULTISDK_LANGUAGES, type MultisdkLanguage } from './language.js';
import { renderMultisdkHandoff } from './handoff.js';
import {
  createInitialMultisdkTask,
  loadMultisdkTask,
  saveMultisdkTask,
  type MultisdkTask
} from './task.js';

export async function initMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }> {
  const result = await exportCodeBlockSnippets({
    document: input.document,
    inventory: input.inventory,
    expectLanguages: [...MULTISDK_LANGUAGES],
    outDir: input.taskDir,
    manifestPath: join(input.taskDir, 'manifest.json')
  });
  const task = createInitialMultisdkTask(input);
  for (const language of MULTISDK_LANGUAGES) {
    task.languages[language] = {
      ...task.languages[language],
      status: 'exported',
      snippetsReady: true
    };
  }
  await mkdir(join(input.taskDir, 'validation'), { recursive: true });
  await mkdir(join(input.taskDir, 'evidence'), { recursive: true });
  await saveMultisdkTask(task);
  return { task, manifest: result.manifest, files: result.files };
}

export async function exportMultisdkLanguage(input: {
  document: string;
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }> {
  const task = await loadMultisdkTask(input.taskDir);
  const fullManifestPath = join(input.taskDir, 'manifest.json');
  const current = await loadCodeBlockManifest(fullManifestPath);
  const refreshed = await exportCodeBlockSnippets({
    document: input.document,
    inventory: input.inventory,
    expectLanguages: [input.language],
    outDir: input.taskDir,
    manifestPath: join(input.taskDir, `.multisdk-${input.language}-refresh.json`)
  });
  const manifest = mergeLanguageManifestItems(current, refreshed.manifest, input.language);
  await writeFile(fullManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  task.languages[input.language] = {
    ...task.languages[input.language],
    status: 'exported',
    sourceVerified: false,
    snippetsReady: true,
    validated: false,
    dryRunPassed: false,
    dryRunHashes: [],
    writePassed: false,
    auditPassed: false,
    evidence: [],
    reason: undefined
  };
  await saveMultisdkTask(task);
  return { task, manifest, files: refreshed.files };
}

export async function recordMultisdkVerification(input: {
  taskDir: string;
  language: MultisdkLanguage;
  evidencePath: string;
  command: string;
}): Promise<MultisdkTask> {
  const task = await loadMultisdkTask(input.taskDir);
  if (!task.languages[input.language].snippetsReady) {
    throw new Error(`${input.language} verification requires fresh exported snippets. Run multisdk export --language ${input.language} first.`);
  }
  const recordedAt = new Date().toISOString();
  const evidenceDir = join(input.taskDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const targetPath = join(evidenceDir, `${input.language}-${Date.now()}-${basename(input.evidencePath)}`);
  await copyFile(input.evidencePath, targetPath);

  task.languages[input.language] = {
    ...task.languages[input.language],
    status: 'ready',
    sourceVerified: true,
    validated: true,
    dryRunPassed: false,
    dryRunHashes: [],
    reason: undefined,
    evidence: [
      ...task.languages[input.language].evidence,
      {
        path: relative(input.taskDir, targetPath),
        command: input.command,
        recordedAt
      }
    ]
  };
  await saveMultisdkTask(task);
  return task;
}

export async function applyMultisdkLanguage(input: {
  taskDir: string;
  language: MultisdkLanguage;
  write: boolean;
  client: CodeBlockApplyClient;
}): Promise<{ task: MultisdkTask; report: CodeBlockApplyReport }> {
  const task = await loadMultisdkTask(input.taskDir);
  const state = task.languages[input.language];
  if (!state.snippetsReady) {
    throw new Error(`${input.language} apply requires fresh exported snippets. Run multisdk export --language ${input.language} first.`);
  }
  if (input.write && !state.validated) {
    throw new Error(`${input.language} write requires verification evidence. Run multisdk verify first.`);
  }
  if (input.write && !state.dryRunPassed) {
    throw new Error(`${input.language} write requires a successful dry-run. Run multisdk apply without --write first.`);
  }

  const manifest = await loadCodeBlockManifest(join(input.taskDir, 'manifest.json'));
  const scopedManifestPath = await writeLanguageScopedManifest(input.taskDir, manifest, input.language);
  if (input.write) {
    const currentDryRun = await applyCodeBlockManifest(input.client, {
      manifestPath: scopedManifestPath,
      write: false,
      expectedDocumentId: task.documentId
    });
    if (!sameSnippetHashes(task.languages[input.language].dryRunHashes, snippetHashesFromReport(currentDryRun))) {
      throw new Error(`${input.language} write requires a fresh dry-run because snippet content changed.`);
    }
  }
  const report = await applyCodeBlockManifest(input.client, {
    manifestPath: scopedManifestPath,
    write: input.write,
    expectedDocumentId: task.documentId
  });
  if (report.failed.length > 0) {
    task.languages[input.language] = {
      ...task.languages[input.language],
      status: 'blocked',
      reason: report.failed.map((failure) => failure.message).join('; ')
    };
    await saveMultisdkTask(task);
    throw new Error(`${input.language} apply failed for ${report.failed.length} item(s).`);
  }

  if (input.write) {
    task.languages[input.language] = {
      ...task.languages[input.language],
      status: 'written',
      writePassed: true,
      reason: undefined
    };
    invalidateLaterLanguages(task, input.language);
  } else {
    task.languages[input.language] = {
      ...task.languages[input.language],
      status: 'dry-run-passed',
      dryRunPassed: true,
      dryRunHashes: snippetHashesFromReport(report),
      reason: undefined
    };
  }
  await saveMultisdkTask(task);
  return { task, report };
}

export async function auditMultisdkLanguage(input: {
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: CodeBlockAuditReport }> {
  const task = await loadMultisdkTask(input.taskDir);
  const report = auditCodeBlockInventory(input.inventory, { expectLanguages: [input.language] });
  if (!report.passed) {
    task.languages[input.language] = {
      ...task.languages[input.language],
      status: 'blocked',
      auditPassed: false,
      reason: 'Audit failed.'
    };
    await saveMultisdkTask(task);
    throw new Error(`${input.language} audit failed.`);
  }

  task.languages[input.language] = {
    ...task.languages[input.language],
    status: 'audited',
    auditPassed: true,
    reason: undefined
  };
  await saveMultisdkTask(task);
  return { task, report };
}

export async function finalizeMultisdkTask(input: {
  taskDir: string;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: CodeBlockAuditReport; handoffPath: string }> {
  const task = await loadMultisdkTask(input.taskDir);
  const incomplete = MULTISDK_LANGUAGES.filter((language) => task.languages[language].status !== 'audited');
  if (incomplete.length > 0) {
    throw new Error(`Cannot finalize before all languages are audited. Incomplete: ${incomplete.join(', ')}.`);
  }

  const report = auditCodeBlockInventory(input.inventory, { expectLanguages: [...MULTISDK_LANGUAGES] });
  task.finalAuditPassed = report.passed;
  if (!report.passed) {
    await saveMultisdkTask(task);
    throw new Error('Final multi-SDK audit failed.');
  }

  const handoffPath = join(input.taskDir, 'handoff.md');
  await writeFile(handoffPath, renderMultisdkHandoff(task), 'utf8');
  await saveMultisdkTask(task);
  return { task, report, handoffPath };
}

function invalidateLaterLanguages(task: MultisdkTask, language: MultisdkLanguage): void {
  const writtenIndex = MULTISDK_LANGUAGES.indexOf(language);
  for (const laterLanguage of MULTISDK_LANGUAGES.slice(writtenIndex + 1)) {
    task.languages[laterLanguage] = {
      ...task.languages[laterLanguage],
      status: 'pending',
      sourceVerified: false,
      snippetsReady: false,
      validated: false,
      dryRunPassed: false,
      dryRunHashes: [],
      writePassed: false,
      auditPassed: false,
      evidence: [],
      reason: `Re-export after ${language} write because document anchors changed.`
    };
  }
}

function snippetHashesFromReport(report: CodeBlockApplyReport): Array<{ file: string; contentHash: string }> {
  return [...report.updated, ...report.inserted].map((item) => ({
    file: item.file,
    contentHash: item.contentHash
  }));
}

function sameSnippetHashes(
  expected: Array<{ file: string; contentHash: string }>,
  actual: Array<{ file: string; contentHash: string }>
): boolean {
  if (expected.length === 0 || expected.length !== actual.length) return false;
  const actualByFile = new Map(actual.map((item) => [item.file, item.contentHash]));
  return expected.every((item) => actualByFile.get(item.file) === item.contentHash);
}
