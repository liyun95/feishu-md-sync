import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unifiedDiff } from '../sync/diff.js';
import type { ReleaseTask } from './task.js';

export type ReleaseVariableChange = {
  variable: string;
  expectedValue: string | null;
};

export type ReleaseApplyFile = {
  path: string;
  before: string;
  after: string;
  diff: string;
};

export type ReleaseApplyPlan = {
  files: ReleaseApplyFile[];
};

export async function planReleaseApply(input: {
  milvusDocsPath: string;
  releaseNotesSection: string;
  variableChanges: ReleaseVariableChange[];
}): Promise<ReleaseApplyPlan> {
  const releaseNotesPath = 'site/en/release_notes.md';
  const variablesPath = 'site/en/Variables.json';

  const releaseNotesBefore = await readFile(join(input.milvusDocsPath, releaseNotesPath), 'utf8');
  const releaseNotesAfter = insertReleaseNotesSection(releaseNotesBefore, input.releaseNotesSection);
  const variablesBefore = await readFile(join(input.milvusDocsPath, variablesPath), 'utf8');
  const variablesAfter = applyVariableChanges(variablesBefore, input.variableChanges);

  return {
    files: [
      plannedFile(releaseNotesPath, releaseNotesBefore, releaseNotesAfter),
      plannedFile(variablesPath, variablesBefore, variablesAfter)
    ]
  };
}

export async function writeReleaseApply(input: {
  task: ReleaseTask;
  currentReportHash: string;
  plan: ReleaseApplyPlan;
}): Promise<ReleaseTask> {
  if (!input.task.steps.approved) {
    throw new Error('Release apply requires approval before writing.');
  }
  if (!input.task.steps.dryRunPassed) {
    throw new Error('Release apply requires a passing dry-run before writing.');
  }
  if (input.task.reportHash !== input.currentReportHash) {
    throw new Error('Release apply requires approval for the current report hash.');
  }

  for (const file of input.plan.files) {
    await writeFile(join(input.task.milvusDocsPath, file.path), file.after, 'utf8');
  }

  return {
    ...input.task,
    status: 'written',
    steps: {
      ...input.task.steps,
      writePassed: true
    }
  };
}

function plannedFile(path: string, before: string, after: string): ReleaseApplyFile {
  return {
    path,
    before,
    after,
    diff: unifiedDiff(`a/${path}`, `b/${path}`, before, after)
  };
}

function insertReleaseNotesSection(markdown: string, releaseNotesSection: string): string {
  const section = `${releaseNotesSection.trim()}\n`;
  const sectionHeading = section.split(/\r?\n/, 1)[0]?.trim();
  if (sectionHeading) {
    const lines = markdown.split(/\r?\n/);
    const startLine = lines.findIndex((line) => line.trim() === sectionHeading);
    if (startLine >= 0) {
      const nextSectionOffset = lines.slice(startLine + 1).findIndex((line) => /^##\s+v.+$/.test(line.trim()));
      const endLine = nextSectionOffset >= 0 ? startLine + 1 + nextSectionOffset : lines.length;
      return [
        ...lines.slice(0, startLine),
        ...section.trimEnd().split(/\r?\n/),
        ...lines.slice(endLine)
      ].join('\n').replace(/\s*$/, '\n');
    }
  }

  const firstVersionHeading = /^##\s+v.+$/m.exec(markdown);
  if (firstVersionHeading?.index !== undefined) {
    const before = markdown.slice(0, firstVersionHeading.index).replace(/\s*$/, '\n\n');
    const after = markdown.slice(firstVersionHeading.index).replace(/^\s*/, '');
    return `${before}${section}\n${after}`;
  }

  const title = /^#\s+.+$/m.exec(markdown);
  if (title?.index !== undefined) {
    const insertAt = title.index + title[0].length;
    const before = markdown.slice(0, insertAt).replace(/\s*$/, '');
    const after = markdown.slice(insertAt).replace(/^\s*/, '');
    return `${before}\n\n${section}${after ? `\n${after}` : ''}`;
  }

  return `${section}\n${markdown.trimStart()}`;
}

function applyVariableChanges(variablesJson: string, changes: ReleaseVariableChange[]): string {
  const variables = JSON.parse(variablesJson) as Record<string, unknown>;
  for (const change of changes) {
    variables[change.variable] = change.expectedValue;
  }
  return `${JSON.stringify(variables, null, 2)}\n`;
}
