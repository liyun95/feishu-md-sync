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
      const existingSection = lines.slice(startLine, endLine).join('\n');
      const mergedSection = mergeExistingReleaseSection(existingSection, section);
      const mergedLines = mergedSection.trimEnd().split(/\r?\n/);
      const tailLines = lines.slice(endLine);
      if (tailLines.length > 0 && mergedLines.at(-1)?.trim() !== '' && tailLines[0]?.trim() !== '') {
        mergedLines.push('');
      }
      return [
        ...lines.slice(0, startLine),
        ...mergedLines,
        ...tailLines
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

type ReleaseSubsection = {
  key: string;
  heading: string;
  content: string[];
};

function mergeExistingReleaseSection(existingSection: string, incomingSection: string): string {
  const existingLines = existingSection.trimEnd().split(/\r?\n/);
  const incomingLines = normalizeIncomingReleaseSection(incomingSection).trimEnd().split(/\r?\n/);
  const existingFirstSubsection = firstSubsectionIndex(existingLines);
  const incomingFirstSubsection = firstSubsectionIndex(incomingLines);
  if (existingFirstSubsection < 0 || incomingFirstSubsection < 0) {
    return incomingSection.trimEnd();
  }

  const prefix = existingLines.slice(0, existingFirstSubsection);
  const existingSubsections = parseSubsections(existingLines, existingFirstSubsection);
  const incomingSubsections = parseSubsections(incomingLines, incomingFirstSubsection);
  const incomingByKey = new Map(incomingSubsections.map((section) => [section.key, section]));
  const usedIncoming = new Set<string>();
  const mergedSubsections: ReleaseSubsection[] = [];

  for (const existing of existingSubsections) {
    const incoming = incomingByKey.get(existing.key);
    if (!incoming) {
      mergedSubsections.push(existing);
      continue;
    }
    usedIncoming.add(incoming.key);
    mergedSubsections.push({
      ...existing,
      content: mergeSubsectionContent(existing.content, incoming.content)
    });
  }

  for (const incoming of incomingSubsections) {
    if (!usedIncoming.has(incoming.key)) {
      mergedSubsections.push(incoming);
    }
  }

  return [...prefix, ...renderSubsections(mergedSubsections)].join('\n');
}

function normalizeIncomingReleaseSection(section: string): string {
  const lines = section.trimEnd().split(/\r?\n/);
  return lines.map((line, index) => {
    if (index > 0 && /^##\s+(?!v)/i.test(line.trim())) {
      return line.replace(/^##\s+/, '### ');
    }
    return line;
  }).join('\n');
}

function firstSubsectionIndex(lines: string[]): number {
  return lines.findIndex((line, index) => index > 0 && /^#{3,6}\s+/.test(line.trim()));
}

function parseSubsections(lines: string[], startIndex: number): ReleaseSubsection[] {
  const sections: ReleaseSubsection[] = [];
  for (let index = startIndex; index < lines.length;) {
    const heading = lines[index];
    const nextOffset = lines.slice(index + 1).findIndex((line) => /^#{3,6}\s+/.test(line.trim()));
    const endIndex = nextOffset >= 0 ? index + 1 + nextOffset : lines.length;
    sections.push({
      key: subsectionKey(heading),
      heading,
      content: lines.slice(index + 1, endIndex)
    });
    index = endIndex;
  }
  return sections;
}

function renderSubsections(sections: ReleaseSubsection[]): string[] {
  return sections.flatMap((section) => [section.heading, ...section.content]);
}

function subsectionKey(heading: string): string {
  return heading.replace(/^#+\s+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function mergeSubsectionContent(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.filter((line) => line.trimStart().startsWith('- ')).map(bulletFingerprint));
  const merged = [...existing];
  for (const line of incoming) {
    if (!line.trimStart().startsWith('- ')) continue;
    const fingerprint = bulletFingerprint(line);
    if (!seen.has(fingerprint)) {
      if (merged.length > 0 && merged.at(-1)?.trim() !== '') merged.push('');
      merged.push(line);
      seen.add(fingerprint);
    }
  }
  return merged;
}

function bulletFingerprint(line: string): string {
  const issueRefs = Array.from(line.matchAll(/(?:\/pull\/|#)(\d+)/g)).map((match) => match[1]);
  if (issueRefs.length > 0) {
    return `refs:${issueRefs.sort().join(',')}`;
  }
  return line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function applyVariableChanges(variablesJson: string, changes: ReleaseVariableChange[]): string {
  const variables = JSON.parse(variablesJson) as Record<string, unknown>;
  for (const change of changes) {
    variables[change.variable] = change.expectedValue;
  }
  return `${JSON.stringify(variables, null, 2)}\n`;
}
