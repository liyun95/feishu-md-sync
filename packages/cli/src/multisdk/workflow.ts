import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CodeBlockInventory } from '../feishu/code-blocks.js';
import { appendHarnessTraceEvent } from '../harness/trace.js';
import { auditCodeBlockInventory, type CodeBlockAuditReport } from '../sync/code-block-audit.js';
import { exportCodeBlockSnippets } from '../sync/code-block-export.js';
import type { CodeBlockManifest } from '../sync/code-block-plan.js';
import { type MultisdkLanguage } from './language.js';
import { renderMultisdkHandoff } from './handoff.js';
import { prepareMultisdkVerifier } from './prepare.js';
import { writeMultisdkReviewMarkdown } from './review-markdown.js';
import {
  createInitialMultisdkTask,
  loadMultisdkTask,
  saveMultisdkTask,
  type MultisdkMilvusTarget,
  type MultisdkTask,
  type MultisdkValidationRunner
} from './task.js';

export async function initMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }> {
  const startedAt = new Date().toISOString();
  try {
    const result = await exportCodeBlockSnippets({
      document: input.document,
      inventory: input.inventory,
      expectLanguages: [input.language],
      outDir: input.taskDir,
      manifestPath: join(input.taskDir, 'manifest.json')
    });
    const task = createInitialMultisdkTask(input);
    await mkdir(join(input.taskDir, 'inputs'), { recursive: true });
    await mkdir(join(input.taskDir, 'evidence'), { recursive: true });
    await saveMultisdkTask(task);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.init',
      mode: 'initialize',
      startedAt,
      arguments: {
        document: input.document,
        documentId: input.documentId,
        language: input.language
      },
      artifactPaths: ['task.json', 'manifest.json', ...result.files],
      summary: `Initialized ${input.language} multi-SDK task.`
    });
    return { task, manifest: result.manifest, files: result.files };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.init',
      mode: 'initialize',
      startedAt,
      arguments: {
        document: input.document,
        documentId: input.documentId,
        language: input.language
      },
      error
    });
    throw error;
  }
}

export async function configureMultisdkEnvironment(input: {
  taskDir: string;
  milvusTarget: MultisdkMilvusTarget;
  runner?: MultisdkValidationRunner;
}): Promise<MultisdkTask> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    const updated: MultisdkTask = {
      ...task,
      status: 'environment-ready',
      milvusTarget: input.milvusTarget,
      runner: input.runner ?? 'manta'
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.environment',
      mode: 'configure-environment',
      startedAt,
      arguments: {
        language: task.language,
        runner: updated.runner,
        milvusTarget: updated.milvusTarget
      },
      artifactPaths: ['task.json'],
      summary: `Configured ${task.language} Milvus validation target.`
    });
    return updated;
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.environment',
      mode: 'configure-environment',
      startedAt,
      error
    });
    throw error;
  }
}

export async function prepareMultisdkTask(input: {
  taskDir: string;
  remoteMarkdownPath: string;
  snippetPaths: string[];
}): Promise<{ task: MultisdkTask; files: string[]; command: string }> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.milvusTarget) {
      throw new Error('multisdk prepare requires a Milvus target. Run multisdk environment first.');
    }
    const prepared = await prepareMultisdkVerifier({
      taskDir: input.taskDir,
      language: task.language,
      remoteMarkdownPath: input.remoteMarkdownPath,
      snippetPaths: input.snippetPaths,
      milvusVersion: task.milvusTarget.version
    });
    const updated: MultisdkTask = {
      ...task,
      status: 'prepared',
      lane: { ...task.lane, prepared: true, authored: false, validated: false, localApplied: false }
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.prepare',
      mode: 'prepare-verifier',
      startedAt,
      arguments: { language: task.language },
      artifactPaths: ['task.json', ...prepared.files.map((file) => relativeTaskPath(input.taskDir, file))],
      summary: `Prepared ${task.language} verifier artifacts.`
    });
    return { task: updated, files: prepared.files, command: prepared.command };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.prepare',
      mode: 'prepare-verifier',
      startedAt,
      error
    });
    throw error;
  }
}

export async function authorMultisdkTask(input: {
  taskDir: string;
  snippetPaths: string[];
}): Promise<{ task: MultisdkTask; files: string[] }> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.lane.prepared) throw new Error('multisdk author requires prepared verifier artifacts.');
    if (input.snippetPaths.length === 0) throw new Error('multisdk author requires selected-language snippet files.');

    const emptySnippets: string[] = [];
    const files: string[] = [];
    const workSnippetDir = join(input.taskDir, 'work', task.language, 'snippets');
    await mkdir(workSnippetDir, { recursive: true });
    for (const snippetPath of input.snippetPaths) {
      const content = await readFile(snippetPath, 'utf8');
      if (content.trim().length === 0) {
        emptySnippets.push(snippetPath);
        continue;
      }
      const target = join(workSnippetDir, basename(snippetPath));
      await writeFile(target, content, 'utf8');
      files.push(target);
    }

    if (emptySnippets.length > 0) {
      throw new Error(`multisdk author found empty snippets: ${emptySnippets.join(', ')}`);
    }

    const updated: MultisdkTask = {
      ...task,
      status: 'authored',
      lane: { ...task.lane, authored: true, validated: false, localApplied: false }
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.author',
      mode: 'record-authored-snippets',
      startedAt,
      arguments: { language: task.language },
      artifactPaths: ['task.json', ...files.map((file) => relativeTaskPath(input.taskDir, file))],
      summary: `Recorded authored ${task.language} snippets.`
    });
    return { task: updated, files };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.author',
      mode: 'record-authored-snippets',
      startedAt,
      error
    });
    throw error;
  }
}

export async function validateMultisdkTask(input: {
  taskDir: string;
  command: string;
  evidencePath: string;
  runner?: MultisdkValidationRunner;
  jobId?: string;
}): Promise<MultisdkTask> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.milvusTarget) throw new Error('multisdk validate requires a configured Milvus target.');
    if (!task.lane.prepared) throw new Error('multisdk validate requires prepared verifier artifacts.');
    if (!task.lane.authored) throw new Error('multisdk validate requires authored snippets. Fill the selected-language snippets from Python context and run multisdk author first.');
    await assertSuccessfulValidationEvidence(input.evidencePath);
    const evidence = {
      runner: input.runner ?? task.runner,
      command: input.command,
      evidencePath: input.evidencePath,
      recordedAt: new Date().toISOString(),
      milvusTarget: task.milvusTarget,
      jobId: input.jobId
    };
    const updated: MultisdkTask = {
      ...task,
      status: 'validated',
      lane: {
        ...task.lane,
        validated: true,
        evidence: [...task.lane.evidence, evidence]
      }
    };
    await saveMultisdkTask(updated);
    await writeMultisdkEvidenceSummary(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.validate',
      mode: 'record-validation',
      startedAt,
      arguments: {
        language: task.language,
        runner: evidence.runner,
        jobId: evidence.jobId
      },
      artifactPaths: ['task.json', input.evidencePath, 'evidence/evidence.json', 'evidence/evidence.md'],
      summary: `Recorded ${task.language} validation evidence.`
    });
    return updated;
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.validate',
      mode: 'record-validation',
      startedAt,
      error
    });
    throw error;
  }
}

async function assertSuccessfulValidationEvidence(evidencePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(evidencePath, 'utf8');
  } catch (error) {
    throw new Error(`multisdk validate requires a readable validation evidence file at ${evidencePath}: ${errorMessage(error)}`);
  }

  const normalized = content.trim();
  if (!normalized) {
    throw new Error(`multisdk validate evidence file is empty: ${evidencePath}`);
  }

  const hasSuccessSignal =
    /\bPASS(?:ED)?\b/i.test(normalized) ||
    /BUILD SUCCESS/i.test(normalized) ||
    /Tests run:\s*\d+,\s*Failures:\s*0,\s*Errors:\s*0/i.test(normalized);
  const hasFailureSignal =
    /BUILD FAILURE/i.test(normalized) ||
    /<<< FAILURE!/i.test(normalized) ||
    /Failures:\s*[1-9]\d*/i.test(normalized) ||
    /Errors:\s*[1-9]\d*/i.test(normalized) ||
    /\b(DEADLINE_EXCEEDED|StatusRuntimeException|NoClassDefFoundError|Exception)\b/i.test(normalized);

  if (!hasSuccessSignal || hasFailureSignal) {
    throw new Error(`multisdk validate evidence at ${evidencePath} does not prove successful live Milvus validation.`);
  }
}

export async function applyMultisdkLocalReview(input: {
  taskDir: string;
  remoteMarkdownPath: string;
  snippetPaths: string[];
}): Promise<{ task: MultisdkTask; markdownPath: string; diffPath: string }> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.lane.validated) throw new Error('multisdk apply-local requires live validation evidence.');
    const review = await writeMultisdkReviewMarkdown({
      taskDir: input.taskDir,
      language: task.language,
      remoteMarkdownPath: input.remoteMarkdownPath,
      snippetPaths: input.snippetPaths
    });
    const updated: MultisdkTask = {
      ...task,
      status: 'local-applied',
      lane: { ...task.lane, localApplied: true },
      localReview: {
        markdownPath: review.markdownPath,
        diffPath: review.diffPath,
        generatedAt: new Date().toISOString()
      }
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.apply-local',
      mode: 'write-review-markdown',
      startedAt,
      arguments: { language: task.language },
      artifactPaths: ['task.json', review.markdownPath, review.diffPath],
      summary: `Wrote local ${task.language} review Markdown.`
    });
    return { task: updated, ...review };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.apply-local',
      mode: 'write-review-markdown',
      startedAt,
      error
    });
    throw error;
  }
}

export async function recordMultisdkPush(input: {
  taskDir: string;
  mode: 'dry-run' | 'write';
  command: string;
  resultPath?: string;
}): Promise<MultisdkTask> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.localReview) throw new Error('multisdk record-push requires local review Markdown. Run multisdk apply-local first.');
    const remotePush = {
      ...(task.remotePush ?? {}),
      command: input.command,
      resultPath: input.resultPath,
      ...(input.mode === 'dry-run'
        ? { dryRunAt: new Date().toISOString() }
        : { writeAt: new Date().toISOString() })
    };
    const updated: MultisdkTask = {
      ...task,
      status: input.mode === 'write' ? 'remote-written' : 'remote-dry-run',
      lane: {
        ...task.lane,
        remoteWritten: input.mode === 'write' ? true : task.lane.remoteWritten
      },
      remotePush
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.record-push',
      mode: input.mode,
      startedAt,
      arguments: { language: task.language, command: input.command },
      artifactPaths: ['task.json'],
      summary: `Recorded ${input.mode} push state.`
    });
    return updated;
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.record-push',
      mode: input.mode,
      startedAt,
      error
    });
    throw error;
  }
}

export async function auditMultisdkLanguage(input: {
  taskDir: string;
  language?: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: CodeBlockAuditReport }> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    const language = input.language ?? task.language;
    if (language !== task.language) throw new Error(`Task is for ${task.language}, not ${language}.`);
    if (!task.lane.remoteWritten) throw new Error('multisdk audit requires a recorded remote write.');

    const report = auditCodeBlockInventory(input.inventory, { expectLanguages: [task.language] });
    if (!report.passed) {
      const blocked: MultisdkTask = {
        ...task,
        status: 'blocked',
        lane: { ...task.lane, audited: false, reason: 'Audit failed.' },
        finalAuditPassed: false
      };
      await saveMultisdkTask(blocked);
      throw new Error(`${task.language} audit failed.`);
    }

    const updated: MultisdkTask = {
      ...task,
      status: 'audited',
      lane: { ...task.lane, audited: true, reason: undefined },
      finalAuditPassed: true
    };
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.audit',
      mode: 'readback-audit',
      startedAt,
      arguments: { language: task.language },
      artifactPaths: ['task.json'],
      summary: `Audited ${task.language} readback.`
    });
    return { task: updated, report };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.audit',
      mode: 'readback-audit',
      startedAt,
      error
    });
    throw error;
  }
}

export async function finalizeMultisdkTask(input: {
  taskDir: string;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: CodeBlockAuditReport; handoffPath: string }> {
  const startedAt = new Date().toISOString();
  try {
    const task = await loadMultisdkTask(input.taskDir);
    if (!task.lane.audited) throw new Error(`Cannot finalize before ${task.language} is audited.`);
    const report = auditCodeBlockInventory(input.inventory, { expectLanguages: [task.language] });
    const updated: MultisdkTask = {
      ...task,
      finalAuditPassed: report.passed
    };
    if (!report.passed) {
      await saveMultisdkTask(updated);
      throw new Error('Final multi-SDK audit failed.');
    }

    const handoffPath = join(input.taskDir, 'handoff.md');
    await writeFile(handoffPath, renderMultisdkHandoff(updated), 'utf8');
    await saveMultisdkTask(updated);
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.finalize',
      mode: 'finalize',
      startedAt,
      arguments: { language: task.language },
      artifactPaths: ['task.json', 'handoff.md'],
      summary: 'Finalized multi-SDK task.'
    });
    return { task: updated, report, handoffPath };
  } catch (error) {
    await traceMultisdkFailure({
      taskDir: input.taskDir,
      tool: 'multisdk.finalize',
      mode: 'finalize',
      startedAt,
      error
    });
    throw error;
  }
}

async function traceMultisdkSuccess(input: {
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  arguments?: Record<string, unknown>;
  artifactPaths?: string[];
  summary: string;
}): Promise<void> {
  try {
    await appendHarnessTraceEvent({
      workflow: 'multisdk',
      taskDir: input.taskDir,
      tool: input.tool,
      mode: input.mode,
      startedAt: input.startedAt,
      status: 'passed',
      arguments: input.arguments,
      artifactPaths: input.artifactPaths,
      summary: input.summary
    });
  } catch (error) {
    console.warn(`Failed to write harness trace: ${errorMessage(error)}`);
  }
}

async function traceMultisdkFailure(input: {
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  arguments?: Record<string, unknown>;
  error: unknown;
}): Promise<void> {
  try {
    await appendHarnessTraceEvent({
      workflow: 'multisdk',
      taskDir: input.taskDir,
      tool: input.tool,
      mode: input.mode,
      startedAt: input.startedAt,
      status: 'failed',
      arguments: input.arguments,
      summary: errorMessage(input.error)
    });
  } catch (traceError) {
    console.warn(`Failed to write harness trace after workflow error: ${errorMessage(traceError)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTaskPath(taskDir: string, path: string): string {
  return path.startsWith(`${taskDir}/`) ? path.slice(taskDir.length + 1) : path;
}

async function writeMultisdkEvidenceSummary(task: MultisdkTask): Promise<void> {
  const evidenceDir = join(task.taskDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  await Promise.all([
    writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify({
      kind: 'feishu-multisdk-evidence',
      version: 2,
      document: task.document,
      documentId: task.documentId,
      language: task.language,
      generatedAt: new Date().toISOString(),
      items: task.lane.evidence
    }, null, 2)}\n`, 'utf8'),
    writeFile(join(evidenceDir, 'evidence.md'), renderMultisdkEvidenceMarkdown(task), 'utf8')
  ]);
}

function renderMultisdkEvidenceMarkdown(task: MultisdkTask): string {
  const lines = [
    '# Multi-SDK Evidence',
    '',
    `Document: ${task.document}`,
    `Document ID: ${task.documentId}`,
    `Language: ${task.language}`,
    ''
  ];
  for (const evidence of task.lane.evidence) {
    lines.push(`## ${evidence.runner}`, '');
    lines.push(`- evidence: ${evidence.evidencePath}`);
    lines.push(`- command: ${evidence.command}`);
    lines.push(`- recorded: ${evidence.recordedAt}`);
    lines.push(`- Milvus: ${evidence.milvusTarget.version}`);
    if (evidence.jobId) lines.push(`- Manta job: ${evidence.jobId}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
