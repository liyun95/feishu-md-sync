import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type ReferenceWebContentMode = 'check' | 'pull';

export type ReferenceWebContentConfig = {
  repo: string;
  config: string;
  manual: string;
  mode: ReferenceWebContentMode;
  doc?: string;
  output?: string;
  recursive?: boolean;
  all?: boolean;
  position?: number;
  skipImageDown?: boolean;
};

export type ReferencePrConfig = {
  base: string;
  branch: string;
  title?: string;
  bodyFile?: string;
  create?: boolean;
};

export type ReferenceReleaseWorkflowConfig = {
  kind: 'sdk-reference-release-workflow';
  sdk: string;
  versionRange?: string;
  impactMatrix?: string;
  manifest: string;
  reportsDir?: string;
  webContent: ReferenceWebContentConfig;
  pr?: ReferencePrConfig;
};

export async function loadReferenceReleaseWorkflowConfig(path: string): Promise<ReferenceReleaseWorkflowConfig> {
  const configPath = resolve(path);
  const value = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  validateReferenceReleaseWorkflowConfig(value, dirname(configPath));
  return value as ReferenceReleaseWorkflowConfig;
}

export function validateReferenceReleaseWorkflowConfig(value: unknown, baseDir: string): void {
  if (!isRecord(value) || value.kind !== 'sdk-reference-release-workflow') {
    throw new Error('Workflow config kind must be sdk-reference-release-workflow.');
  }

  requireString(value.sdk, 'sdk');
  requireString(value.manifest, 'manifest');

  if (!isRecord(value.webContent)) {
    throw new Error('Workflow config requires webContent.');
  }
  validateWebContentConfig(value.webContent, baseDir);

  if (value.pr !== undefined) validatePrConfig(value.pr);
}

function validateWebContentConfig(value: Record<string, unknown>, baseDir: string): void {
  const repo = requireString(value.repo, 'webContent.repo');
  requireString(value.config, 'webContent.config');
  requireString(value.manual, 'webContent.manual');

  if (value.mode !== 'check' && value.mode !== 'pull') {
    throw new Error('webContent.mode must be check or pull.');
  }

  const repoPath = resolve(baseDir, repo);
  if (/(^|[/\\])packages[/\\]web-content($|[/\\])/.test(repoPath)) {
    throw new Error('webContent.repo must point to an external repository, not packages/web-content.');
  }

  if (value.mode === 'pull') {
    const hasDocTarget = typeof value.doc === 'string' && value.doc.trim() !== '';
    const hasAllTarget = value.all === true;
    if (!hasDocTarget && !hasAllTarget) {
      throw new Error('webContent pull mode requires webContent.doc or webContent.all=true.');
    }
  }
}

function validatePrConfig(value: unknown): void {
  if (!isRecord(value)) throw new Error('pr must be an object.');
  requireString(value.base, 'pr.base');
  requireString(value.branch, 'pr.branch');
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Workflow config requires ${name}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
