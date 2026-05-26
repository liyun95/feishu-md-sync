import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { loadReferenceManifest, type ReferenceAction, type ReferenceManifest } from './manifest.js';

const execFileAsync = promisify(execFile);

export type ReferenceExportScope = 'changed' | 'all';

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (file: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type ReferenceExportOptions = {
  manifestPath: string;
  webContentRepo: string;
  manual: string;
  configPath: string;
  scope?: ReferenceExportScope;
  skipImageDown?: boolean;
  outPath?: string;
  runCommand?: CommandRunner;
  caseSensitive?: boolean;
};

export type WebContentManualConfig = {
  base: string;
  outputDir: string;
};

export type GitStatusEntry = {
  status: string;
  path: string;
};

export type ReferenceExportReport = {
  manual: string;
  scope: ReferenceExportScope;
  webContentRepo: string;
  configPath: string;
  outputDir: string;
  sourceBase: string;
  docTitles: string[];
  commands: Array<{
    file: string;
    args: string[];
    cwd: string;
  }>;
  writtenFiles: string[];
  changedFiles: string[];
  untrackedFiles: string[];
  unrelatedDirtyFiles: string[];
  suggestedStagingFiles: string[];
  diffCheck: {
    passed: boolean;
    stdout: string;
    stderr: string;
  };
  warnings: string[];
};

type WebContentConfig = {
  milvus?: {
    manuals?: Record<string, unknown>;
  };
};

export async function exportReferenceToWebContent(options: ReferenceExportOptions): Promise<ReferenceExportReport> {
  const scope = options.scope ?? 'changed';
  if (scope !== 'changed' && scope !== 'all') {
    throw new Error(`Invalid reference export scope ${scope}. Expected changed or all.`);
  }

  const repoRoot = resolve(options.webContentRepo);
  await assertReadableDirectory(repoRoot, 'web-content repository');
  await assertCaseSafeWebContentRepo(repoRoot, options);

  const configPath = resolveConfigPath(repoRoot, options.configPath);
  const manual = await loadWebContentManualConfig(configPath, options.manual);
  const manifest = await loadReferenceManifest(options.manifestPath);
  const docTitles = scope === 'changed' ? collectReferenceExportDocTitles(manifest) : [];
  const commands = buildReferenceExportCommands({
    repoRoot,
    configPath,
    manual: options.manual,
    scope,
    docTitles,
    skipImageDown: options.skipImageDown ?? true
  });
  const runCommand = options.runCommand ?? defaultRunCommand;
  const commandOutputs: CommandResult[] = [];

  for (const command of commands) {
    commandOutputs.push(await runCommand(command.file, command.args, { cwd: command.cwd }));
  }

  const diffCheck = await runGitDiffCheck(repoRoot, runCommand);
  const status = await gitStatus(repoRoot, runCommand);
  const writtenFiles = Array.from(new Set(commandOutputs.flatMap((output) => parseWrittenFiles(output.stdout, repoRoot))));
  const relatedPaths = scope === 'changed' && writtenFiles.length > 0 ? new Set(writtenFiles) : undefined;
  const classification = classifyGitStatus(status, manual.outputDir, relatedPaths);

  const report: ReferenceExportReport = {
    manual: options.manual,
    scope,
    webContentRepo: repoRoot,
    configPath,
    outputDir: manual.outputDir,
    sourceBase: manual.base,
    docTitles,
    commands,
    writtenFiles,
    changedFiles: classification.changedFiles,
    untrackedFiles: classification.untrackedFiles,
    unrelatedDirtyFiles: classification.unrelatedDirtyFiles,
    suggestedStagingFiles: classification.suggestedStagingFiles,
    diffCheck,
    warnings: []
  };

  if (scope === 'changed' && docTitles.length === 0) {
    report.warnings.push('No changed reference docs were found in the manifest; no web-content files were exported.');
  }
  if (scope === 'changed' && writtenFiles.length === 0 && commands.length > 0) {
    report.warnings.push('The web-content script did not report any written files.');
  }
  if (!diffCheck.passed) {
    report.warnings.push('git diff --check reported whitespace or conflict-marker issues.');
  }

  if (options.outPath) {
    const outPath = resolve(options.outPath);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

export async function loadWebContentManualConfig(configPath: string, manual: string): Promise<WebContentManualConfig> {
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as WebContentConfig;
  const rawManual = parsed.milvus?.manuals?.[manual];
  if (!isRecord(rawManual)) {
    const available = Object.keys(parsed.milvus?.manuals ?? {}).sort().join(', ');
    throw new Error(`Web content manual "${manual}" was not found in ${configPath}. Available manuals: ${available}`);
  }

  const base = rawManual.base;
  const targets = rawManual.targets;
  if (typeof base !== 'string' || base.trim() === '') {
    throw new Error(`Web content manual "${manual}" in ${configPath} must define a non-empty base.`);
  }
  if (!isRecord(targets) || typeof targets.outputDir !== 'string' || targets.outputDir.trim() === '') {
    throw new Error(`Web content manual "${manual}" in ${configPath} must define targets.outputDir.`);
  }

  return {
    base,
    outputDir: toGitPath(targets.outputDir)
  };
}

export function collectReferenceExportDocTitles(manifest: ReferenceManifest): string[] {
  const titles: string[] = [];
  for (const action of manifest.actions) collectActionDocTitles(action, undefined, titles);
  return Array.from(new Set(titles));
}

export function buildReferenceExportCommands(input: {
  repoRoot: string;
  configPath: string;
  manual: string;
  scope: ReferenceExportScope;
  docTitles: string[];
  skipImageDown: boolean;
}): ReferenceExportReport['commands'] {
  const scriptPath = resolve(input.repoRoot, 'scripts/lark-docs/index.js');
  const baseArgs = [scriptPath, '-c', input.configPath, '-m', input.manual];
  const imageArgs = input.skipImageDown ? ['--skipImageDown'] : [];
  if (input.scope === 'all') {
    return [{
      file: 'node',
      args: [...baseArgs, '--all', ...imageArgs],
      cwd: input.repoRoot
    }];
  }

  return input.docTitles.map((title) => ({
    file: 'node',
    args: [...baseArgs, '--doc', title, ...imageArgs],
    cwd: input.repoRoot
  }));
}

export function parseGitStatus(output: string): GitStatusEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1) ?? rawPath : rawPath;
      return { status, path: unquoteGitPath(path) };
    });
}

export function classifyGitStatus(
  entries: GitStatusEntry[],
  outputDir: string,
  relatedPaths?: Set<string>
): {
  changedFiles: string[];
  untrackedFiles: string[];
  unrelatedDirtyFiles: string[];
  suggestedStagingFiles: string[];
} {
  const normalizedOutputDir = toGitPath(outputDir).replace(/\/+$/, '');
  const outputPrefix = `${normalizedOutputDir}/`;
  const changedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const unrelatedDirtyFiles: string[] = [];
  const suggestedStagingFiles: string[] = [];

  for (const entry of entries) {
    const path = toGitPath(entry.path);
    const inOutputDir = path === normalizedOutputDir || path.startsWith(outputPrefix);
    const isRelated = inOutputDir && (!relatedPaths || relatedPaths.has(path));
    if (!isRelated) {
      unrelatedDirtyFiles.push(path);
      continue;
    }

    if (entry.status === '??') {
      untrackedFiles.push(path);
    } else {
      changedFiles.push(path);
    }
    suggestedStagingFiles.push(path);
  }

  return {
    changedFiles: Array.from(new Set(changedFiles)).sort(),
    untrackedFiles: Array.from(new Set(untrackedFiles)).sort(),
    unrelatedDirtyFiles: Array.from(new Set(unrelatedDirtyFiles)).sort(),
    suggestedStagingFiles: Array.from(new Set(suggestedStagingFiles)).sort()
  };
}

export function caseConflictingPaths(paths: string[]): string[] {
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const existing = seen.get(key);
    if (existing && existing !== path) {
      conflicts.add(existing);
      conflicts.add(path);
    } else {
      seen.set(key, path);
    }
  }
  return Array.from(conflicts).sort();
}

async function assertCaseSafeWebContentRepo(repoRoot: string, options: ReferenceExportOptions): Promise<void> {
  const caseSensitive = options.caseSensitive ?? await isCaseSensitiveDirectory(repoRoot);
  if (caseSensitive) return;

  const trackedPaths = (await gitLsFiles(repoRoot, options.runCommand ?? defaultRunCommand))
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  const conflicts = caseConflictingPaths(trackedPaths);
  if (conflicts.length === 0) return;

  throw new Error(
    `The web-content checkout is on a case-insensitive filesystem but contains case-conflicting tracked paths. ` +
    `Use a case-sensitive worktree or disk image before exporting SDK reference docs. Conflicts include: ${conflicts.slice(0, 6).join(', ')}`
  );
}

async function runGitDiffCheck(repoRoot: string, runCommand: CommandRunner): Promise<ReferenceExportReport['diffCheck']> {
  try {
    const result = await runCommand('git', ['diff', '--check'], { cwd: repoRoot });
    return { passed: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as CommandResult & Error;
    return {
      passed: false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.message
    };
  }
}

async function gitStatus(repoRoot: string, runCommand: CommandRunner): Promise<GitStatusEntry[]> {
  const result = await runCommand('git', ['status', '--porcelain'], { cwd: repoRoot });
  return parseGitStatus(result.stdout);
}

async function gitLsFiles(repoRoot: string, runCommand: CommandRunner): Promise<string> {
  const result = await runCommand('git', ['ls-files'], { cwd: repoRoot });
  return result.stdout;
}

async function defaultRunCommand(file: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    maxBuffer: 50 * 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function assertReadableDirectory(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Cannot access ${label}: ${path}`);
  }
}

function resolveConfigPath(repoRoot: string, configPath: string): string {
  return isAbsolute(configPath) ? configPath : resolve(repoRoot, configPath);
}

function collectActionDocTitles(action: ReferenceAction, inheritedTitle: string | undefined, titles: string[]): void {
  const title = actionTitle(action) ?? inheritedTitle;
  if ((action.action === 'createDoc' || action.action === 'patchDoc' || action.action === 'copyDoc') && title) {
    titles.push(title);
  }

  for (const child of action.then ?? []) {
    collectActionDocTitles(child, title, titles);
  }
}

function actionTitle(action: ReferenceAction): string | undefined {
  if (typeof action.title === 'string' && action.title.trim()) return action.title;
  return fieldString(action.tracker?.fields?.['文档/接口']);
}

function fieldString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (isRecord(value) && typeof value.text === 'string' && value.text.trim()) return value.text;
  return undefined;
}

function parseWrittenFiles(output: string, repoRoot: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => /^Written:\s+(.+)$/.exec(line.trim())?.[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => toRepoRelativePath(repoRoot, path));
}

function toRepoRelativePath(repoRoot: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(repoRoot, path);
  return toGitPath(relative(repoRoot, absolutePath));
}

async function isCaseSensitiveDirectory(directory: string): Promise<boolean> {
  const probe = await mkdtemp(resolve(directory, '.md2feishu-case-check-'));
  try {
    const upper = resolve(probe, 'CaseProbe');
    const lower = resolve(probe, 'caseprobe');
    await writeFile(upper, 'x', 'utf8');
    try {
      await access(lower);
      return false;
    } catch {
      return true;
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function toGitPath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
