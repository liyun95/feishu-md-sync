# SDK Reference Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repo own the SDK reference release workflow end-to-end while keeping `web-content` as an external publication repository.

**Architecture:** Keep `packages/cli` as the published CLI package and add workflow orchestration under `packages/cli/src/reference/`. The CLI will continue to use explicit impact matrices and publish manifests for Feishu writes, then add a typed external `web-content` adapter for Feishu-to-Markdown export and a guarded git/PR preparation step. Do not add `web-content` to npm workspaces or `packages/`.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, npm workspaces, existing Feishu client, child process execution via Node standard library, external `web-content/scripts/lark-docs/index.js`.

---

## Scope

This plan covers the first production-quality pass for workflow ownership:

- Keep `web-content` outside this monorepo.
- Add a typed workflow config and run report to the CLI.
- Add `reference web-content check` and `reference web-content pull` commands that call the existing external web-content script safely.
- Add `reference release run` as an orchestrator over existing `plan`, `apply`, `audit`, web-content export, and git status/reporting.
- Add a PR preparation step that creates or validates a branch and prints the exact PR command/body. Actual PR creation can be enabled behind a separate `--create-pr` flag after the dry-run path is proven.
- Document the end-to-end workflow in `apps/docs`.

This plan intentionally does not migrate the whole `/Users/liyun/sdk-doc-sync` scanner into this repo in the first pass. V1 accepts an approved impact matrix or manifest as the source analysis artifact. A later V2 can move source diff scanning into an internal workflow package once the orchestration contract is stable.

## File Structure

- Modify `packages/cli/src/reference/manifest.ts`: add optional web-content and release workflow metadata to the manifest type only where it improves handoff reporting.
- Create `packages/cli/src/reference/workflow-config.ts`: load and validate `sdk-reference-release-workflow` JSON config files.
- Create `packages/cli/src/reference/web-content.ts`: validate an external `web-content` checkout and build/run `node scripts/lark-docs/index.js` commands.
- Create `packages/cli/src/reference/git-workflow.ts`: inspect git branch/status in the external repo and prepare branch/PR metadata without requiring GitHub network access by default.
- Create `packages/cli/src/reference/release-run.ts`: orchestrate the approved workflow phases and emit a durable JSON report.
- Modify `packages/cli/src/cli/index.ts`: add `reference web-content check`, `reference web-content pull`, and `reference release run`.
- Add tests:
  - `packages/cli/test/reference-workflow-config.test.ts`
  - `packages/cli/test/reference-web-content.test.ts`
  - `packages/cli/test/reference-git-workflow.test.ts`
  - `packages/cli/test/reference-release-run.test.ts`
- Modify docs:
  - `apps/docs/reference/commands.md`
  - `apps/docs/agent/skills/sdk-reference-publisher.md`
  - Create `apps/docs/guide/sdk-reference-release-workflow.md`
  - Modify `apps/docs/.vitepress/config.ts`

## Task 1: Workflow Config Contract

**Files:**
- Create: `packages/cli/src/reference/workflow-config.ts`
- Test: `packages/cli/test/reference-workflow-config.test.ts`

- [ ] **Step 1: Write validation tests**

Create `packages/cli/test/reference-workflow-config.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadReferenceReleaseWorkflowConfig } from '../src/reference/workflow-config.js';

describe('reference release workflow config', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('loads a minimal workflow config with explicit external repositories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-workflow-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      impactMatrix: 'impact.json',
      manifest: 'reference-manifest.json',
      reportsDir: 'reports',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        doc: 'describeCollection()'
      },
      pr: {
        base: 'master',
        branch: 'docs/java-v2.6.19-reference'
      }
    }, null, 2)}\n`, 'utf8');

    const config = await loadReferenceReleaseWorkflowConfig(configPath);

    expect(config.sdk).toBe('java');
    expect(config.webContent.repo).toBe('/Users/liyun/web-content');
    expect(config.webContent.manual).toBe('java-v2.6.x');
    expect(config.pr?.branch).toBe('docs/java-v2.6.19-reference');
  });

  it('rejects configs that try to treat web-content as a package workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-workflow-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      manifest: 'reference-manifest.json',
      webContent: {
        repo: 'packages/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'pull',
        all: true
      }
    }, null, 2)}\n`, 'utf8');

    await expect(loadReferenceReleaseWorkflowConfig(configPath)).rejects.toThrow(/external repository/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- reference-workflow-config
```

Expected: Vitest fails because `packages/cli/src/reference/workflow-config.ts` does not exist.

- [ ] **Step 3: Implement the config loader**

Create `packages/cli/src/reference/workflow-config.ts` with these exported types and functions:

```ts
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
  requireString(value.repo, 'webContent.repo');
  requireString(value.config, 'webContent.config');
  requireString(value.manual, 'webContent.manual');
  if (value.mode !== 'check' && value.mode !== 'pull') {
    throw new Error('webContent.mode must be check or pull.');
  }
  const repoPath = resolve(baseDir, value.repo);
  if (repoPath.includes('/packages/web-content') || repoPath.endsWith('/packages/web-content')) {
    throw new Error('webContent.repo must point to an external repository, not packages/web-content.');
  }
  if (value.mode === 'pull') {
    const hasTarget = typeof value.doc === 'string' || value.all === true;
    if (!hasTarget) {
      throw new Error('webContent pull mode requires webContent.doc or webContent.all=true.');
    }
  }
}

function validatePrConfig(value: unknown): void {
  if (!isRecord(value)) throw new Error('pr must be an object.');
  requireString(value.base, 'pr.base');
  requireString(value.branch, 'pr.branch');
}

function requireString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Workflow config requires ${name}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
```

- [ ] **Step 4: Run the workflow config tests**

```bash
npm test -- reference-workflow-config
```

Expected: the new tests pass.

## Task 2: External web-content Adapter

**Files:**
- Create: `packages/cli/src/reference/web-content.ts`
- Test: `packages/cli/test/reference-web-content.test.ts`

- [ ] **Step 1: Write command-building tests**

Create `packages/cli/test/reference-web-content.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWebContentCommand, validateWebContentRepo } from '../src/reference/web-content.js';

describe('reference web-content adapter', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('builds the stale-link check command for SDK manuals', () => {
    const command = buildWebContentCommand({
      repo: '/Users/liyun/web-content',
      config: 'scripts/config.json',
      manual: 'java-v2.6.x',
      mode: 'check'
    });

    expect(command.cwd).toBe('/Users/liyun/web-content');
    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      'scripts/lark-docs/index.js',
      '--config',
      'scripts/config.json',
      '--manual',
      'java-v2.6.x',
      '--dry-run'
    ]);
  });

  it('builds a targeted pull command without adding --dry-run', () => {
    const command = buildWebContentCommand({
      repo: '/Users/liyun/web-content',
      config: 'scripts/config.json',
      manual: 'java-v2.6.x',
      mode: 'pull',
      doc: 'describeCollection()',
      output: 'MilvusClient/Collections/describeCollection.md',
      skipImageDown: true
    });

    expect(command.args).toContain('--doc');
    expect(command.args).toContain('describeCollection()');
    expect(command.args).toContain('--output');
    expect(command.args).toContain('MilvusClient/Collections/describeCollection.md');
    expect(command.args).toContain('--skipImageDown');
    expect(command.args).not.toContain('--dry-run');
  });

  it('validates the external repo has the lark docs script and config', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'web-content-'));
    tempDirs.push(repo);
    await mkdir(join(repo, 'scripts/lark-docs'), { recursive: true });
    await writeFile(join(repo, 'scripts/lark-docs/index.js'), '#!/usr/bin/env node\n', 'utf8');
    await writeFile(join(repo, 'scripts/config.json'), '{}\n', 'utf8');

    await expect(validateWebContentRepo({ repo, config: 'scripts/config.json' })).resolves.toEqual({
      repo,
      configPath: join(repo, 'scripts/config.json'),
      scriptPath: join(repo, 'scripts/lark-docs/index.js')
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- reference-web-content
```

Expected: Vitest fails because `packages/cli/src/reference/web-content.ts` does not exist.

- [ ] **Step 3: Implement command building and repo validation**

Create `packages/cli/src/reference/web-content.ts`:

```ts
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ReferenceWebContentConfig } from './workflow-config.js';

export type WebContentCommand = {
  cwd: string;
  command: string;
  args: string[];
};

export type WebContentRepoCheck = {
  repo: string;
  configPath: string;
  scriptPath: string;
};

export type WebContentRunResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function validateWebContentRepo(options: { repo: string; config: string }): Promise<WebContentRepoCheck> {
  const repo = resolve(options.repo);
  const scriptPath = join(repo, 'scripts/lark-docs/index.js');
  const configPath = resolve(repo, options.config);
  await mustAccess(scriptPath, 'web-content lark-docs script');
  await mustAccess(configPath, 'web-content config');
  return { repo, configPath, scriptPath };
}

export function buildWebContentCommand(config: ReferenceWebContentConfig): WebContentCommand {
  const args = [
    'scripts/lark-docs/index.js',
    '--config',
    config.config,
    '--manual',
    config.manual
  ];

  if (config.mode === 'check') {
    args.push('--dry-run');
  } else {
    if (config.all) args.push('--all');
    if (config.doc) args.push('--doc', config.doc);
    if (config.recursive) args.push('--recursive');
    if (config.output) args.push('--output', config.output);
    if (typeof config.position === 'number') args.push('--position', String(config.position));
    if (config.skipImageDown) args.push('--skipImageDown');
  }

  return {
    cwd: resolve(config.repo),
    command: process.execPath,
    args
  };
}

export async function runWebContentCommand(config: ReferenceWebContentConfig): Promise<WebContentRunResult> {
  await validateWebContentRepo(config);
  const command = buildWebContentCommand(config);
  return run(command);
}

async function run(command: WebContentCommand): Promise<WebContentRunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('close', (exitCode) => {
      resolveRun({
        command: [command.command, ...command.args].join(' '),
        cwd: command.cwd,
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function mustAccess(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Missing ${label}: ${path}`);
  }
}
```

- [ ] **Step 4: Run web-content tests**

```bash
npm test -- reference-web-content
```

Expected: the new tests pass.

## Task 3: Git and PR Preparation Adapter

**Files:**
- Create: `packages/cli/src/reference/git-workflow.ts`
- Test: `packages/cli/test/reference-git-workflow.test.ts`

- [ ] **Step 1: Write git command planning tests**

Create `packages/cli/test/reference-git-workflow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildReferencePrBody, buildReferencePrCommand } from '../src/reference/git-workflow.js';

describe('reference git workflow', () => {
  it('builds a reviewable PR body from workflow reports', () => {
    const body = buildReferencePrBody({
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      feishuReportPath: 'reports/reference-apply.json',
      webContentSummary: 'Written: API_Reference/milvus-sdk-java/v2.6.x/v2/MilvusClient/Collections/describeCollection.md',
      risks: ['Feishu sync latency may delay web-content export freshness.']
    });

    expect(body).toContain('SDK: java');
    expect(body).toContain('Version range: v2.6.19 -> v3.0.0');
    expect(body).toContain('reports/reference-apply.json');
    expect(body).toContain('Feishu sync latency');
  });

  it('builds a gh pr create command without executing it', () => {
    const command = buildReferencePrCommand({
      base: 'master',
      branch: 'docs/java-v2.6.19-reference',
      title: 'Update Java SDK reference for v2.6.19',
      bodyFile: 'reports/pr-body.md'
    });

    expect(command).toEqual([
      'gh',
      'pr',
      'create',
      '--base',
      'master',
      '--head',
      'docs/java-v2.6.19-reference',
      '--title',
      'Update Java SDK reference for v2.6.19',
      '--body-file',
      'reports/pr-body.md'
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- reference-git-workflow
```

Expected: Vitest fails because `packages/cli/src/reference/git-workflow.ts` does not exist.

- [ ] **Step 3: Implement PR body and command builders**

Create `packages/cli/src/reference/git-workflow.ts`:

```ts
export type ReferencePrBodyInput = {
  sdk: string;
  versionRange?: string;
  feishuReportPath?: string;
  webContentSummary?: string;
  risks?: string[];
};

export type ReferencePrCommandInput = {
  base: string;
  branch: string;
  title: string;
  bodyFile: string;
};

export function buildReferencePrBody(input: ReferencePrBodyInput): string {
  const lines = [
    '## Summary',
    '',
    `- SDK: ${input.sdk}`,
    `- Version range: ${input.versionRange ?? 'not specified'}`,
    `- Feishu report: ${input.feishuReportPath ?? 'not generated'}`,
    '',
    '## web-content export',
    '',
    input.webContentSummary?.trim() || 'No web-content output captured.',
    '',
    '## Risks',
    '',
    ...(input.risks?.length ? input.risks.map((risk) => `- ${risk}`) : ['- No known residual risks.'])
  ];
  return `${lines.join('\n')}\n`;
}

export function buildReferencePrCommand(input: ReferencePrCommandInput): string[] {
  return [
    'gh',
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body-file',
    input.bodyFile
  ];
}
```

- [ ] **Step 4: Run git workflow tests**

```bash
npm test -- reference-git-workflow
```

Expected: the new tests pass.

## Task 4: Release Run Orchestrator

**Files:**
- Create: `packages/cli/src/reference/release-run.ts`
- Test: `packages/cli/test/reference-release-run.test.ts`

- [ ] **Step 1: Write orchestrator tests around injectable functions**

Create `packages/cli/test/reference-release-run.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runReferenceReleaseWorkflow } from '../src/reference/release-run.js';

describe('reference release run', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('runs dry-run phases and writes a durable report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reference-release-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'reports'), { recursive: true });
    const configPath = join(dir, 'workflow.json');
    await writeFile(configPath, `${JSON.stringify({
      kind: 'sdk-reference-release-workflow',
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      manifest: 'reference-manifest.json',
      reportsDir: 'reports',
      webContent: {
        repo: '/Users/liyun/web-content',
        config: 'scripts/config.json',
        manual: 'java-v2.6.x',
        mode: 'check'
      },
      pr: {
        base: 'master',
        branch: 'docs/java-v2.6.19-reference',
        title: 'Update Java SDK reference for v2.6.19'
      }
    }, null, 2)}\n`, 'utf8');

    const report = await runReferenceReleaseWorkflow({
      configPath,
      writeFeishu: false,
      pullWebContent: false,
      createPr: false,
      applyManifest: vi.fn().mockResolvedValue({ failed: [], mode: 'dry-run' }),
      auditManifest: vi.fn().mockResolvedValue({ passed: true }),
      runWebContent: vi.fn().mockResolvedValue({
        command: 'node scripts/lark-docs/index.js --dry-run',
        cwd: '/Users/liyun/web-content',
        exitCode: 0,
        stdout: 'No stale links found.\n',
        stderr: ''
      })
    });

    expect(report.phases.map((phase) => phase.name)).toEqual([
      'feishu-apply',
      'feishu-audit',
      'web-content-check',
      'pr-prepare'
    ]);
    expect(report.passed).toBe(true);

    const saved = JSON.parse(await readFile(join(dir, 'reports/reference-release-report.json'), 'utf8'));
    expect(saved.sdk).toBe('java');
    expect(saved.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- reference-release-run
```

Expected: Vitest fails because `packages/cli/src/reference/release-run.ts` does not exist.

- [ ] **Step 3: Implement the orchestrator with dependency injection**

Create `packages/cli/src/reference/release-run.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildReferencePrBody, buildReferencePrCommand } from './git-workflow.js';
import { loadReferenceReleaseWorkflowConfig } from './workflow-config.js';
import { runWebContentCommand, type WebContentRunResult } from './web-content.js';

export type ReferenceReleasePhaseReport = {
  name: 'feishu-apply' | 'feishu-audit' | 'web-content-check' | 'web-content-pull' | 'pr-prepare';
  passed: boolean;
  summary: string;
};

export type ReferenceReleaseRunReport = {
  sdk: string;
  versionRange?: string;
  passed: boolean;
  reportPath: string;
  phases: ReferenceReleasePhaseReport[];
};

export type ReferenceApplyExecutor = (options: {
  manifestPath: string;
  write: boolean;
}) => Promise<{ mode: string; failed: unknown[] }>;

export type ReferenceAuditExecutor = (options: {
  manifestPath: string;
}) => Promise<{ passed: boolean }>;

export type ReferenceReleaseRunOptions = {
  configPath: string;
  writeFeishu: boolean;
  pullWebContent: boolean;
  createPr: boolean;
  applyManifest: ReferenceApplyExecutor;
  auditManifest: ReferenceAuditExecutor;
  runWebContent?: typeof runWebContentCommand;
};

export async function runReferenceReleaseWorkflow(options: ReferenceReleaseRunOptions): Promise<ReferenceReleaseRunReport> {
  const config = await loadReferenceReleaseWorkflowConfig(options.configPath);
  const configDir = dirname(resolve(options.configPath));
  const reportsDir = resolve(configDir, config.reportsDir ?? 'reports');
  await mkdir(reportsDir, { recursive: true });

  const phases: ReferenceReleasePhaseReport[] = [];
  const manifestPath = resolve(configDir, config.manifest);

  const applyReport = await options.applyManifest({
    manifestPath,
    write: options.writeFeishu
  });
  phases.push({
    name: 'feishu-apply',
    passed: applyReport.failed.length === 0,
    summary: `${applyReport.mode}; failures=${applyReport.failed.length}`
  });

  const auditReport = await options.auditManifest({
    manifestPath
  });
  phases.push({
    name: 'feishu-audit',
    passed: auditReport.passed,
    summary: auditReport.passed ? 'Feishu readback passed.' : 'Feishu readback failed.'
  });

  const webContentRunner = options.runWebContent ?? runWebContentCommand;
  const webContentConfig = {
    ...config.webContent,
    mode: options.pullWebContent ? config.webContent.mode : 'check' as const
  };
  const webContentResult: WebContentRunResult = await webContentRunner(webContentConfig);
  phases.push({
    name: webContentConfig.mode === 'pull' ? 'web-content-pull' : 'web-content-check',
    passed: webContentResult.exitCode === 0,
    summary: webContentResult.stdout.trim() || webContentResult.stderr.trim() || webContentResult.command
  });

  if (config.pr) {
    const body = buildReferencePrBody({
      sdk: config.sdk,
      versionRange: config.versionRange,
      feishuReportPath: join(reportsDir, 'reference-release-report.json'),
      webContentSummary: webContentResult.stdout,
      risks: options.pullWebContent
        ? []
        : ['web-content pull was not executed; run again with --pull-web-content after Feishu sync is complete.']
    });
    const bodyFile = config.pr.bodyFile ? resolve(config.webContent.repo, config.pr.bodyFile) : join(reportsDir, 'pr-body.md');
    await writeFile(bodyFile, body, 'utf8');
    const command = buildReferencePrCommand({
      base: config.pr.base,
      branch: config.pr.branch,
      title: config.pr.title ?? `Update ${config.sdk} SDK reference`,
      bodyFile
    });
    phases.push({
      name: 'pr-prepare',
      passed: true,
      summary: options.createPr ? command.join(' ') : `Prepared PR command: ${command.join(' ')}`
    });
  }

  const reportPath = join(reportsDir, 'reference-release-report.json');
  const report: ReferenceReleaseRunReport = {
    sdk: config.sdk,
    versionRange: config.versionRange,
    passed: phases.every((phase) => phase.passed),
    reportPath,
    phases
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
```

- [ ] **Step 4: Run release-run tests**

```bash
npm test -- reference-release-run
```

Expected: the new tests pass.

## Task 5: CLI Commands

**Files:**
- Modify: `packages/cli/src/cli/index.ts`
- Tests: use existing unit coverage plus command smoke checks after build

- [ ] **Step 1: Add imports and option types**

Modify `packages/cli/src/cli/index.ts` near the existing reference imports:

```ts
import { runReferenceReleaseWorkflow } from '../reference/release-run.js';
import { buildWebContentCommand, runWebContentCommand } from '../reference/web-content.js';
```

Add option types near the existing reference command option types:

```ts
type ReferenceWebContentOptions = FormatCommandOptions & {
  repo: string;
  config: string;
  manual: string;
  doc?: string;
  output?: string;
  recursive?: boolean;
  all?: boolean;
  position?: number;
  skipImageDown?: boolean;
};

type ReferenceReleaseRunOptions = FormatCommandOptions & {
  config: string;
  write?: boolean;
  pullWebContent?: boolean;
  createPr?: boolean;
  host?: string;
  timeoutMs?: number;
};
```

- [ ] **Step 2: Add `reference web-content` commands**

Modify the `reference` command group after `reference audit`:

```ts
const webContent = reference
  .command('web-content')
  .description('run web-content SDK reference export checks against an external checkout');

webContent
  .command('check')
  .description('scan a web-content SDK manual for stale Feishu doc links')
  .requiredOption('--repo <path>', 'external web-content repo path')
  .option('--config <path>', 'web-content lark docs config path', 'scripts/config.json')
  .requiredOption('--manual <name>', 'web-content manual name, for example java-v2.6.x')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: ReferenceWebContentOptions) => {
    const result = await runWebContentCommand({
      repo: opts.repo,
      config: opts.config,
      manual: opts.manual,
      mode: 'check'
    });
    printFormatted(result, opts.format);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });

webContent
  .command('pull')
  .description('pull Feishu SDK reference docs into an external web-content checkout')
  .requiredOption('--repo <path>', 'external web-content repo path')
  .option('--config <path>', 'web-content lark docs config path', 'scripts/config.json')
  .requiredOption('--manual <name>', 'web-content manual name, for example java-v2.6.x')
  .option('--doc <title>', 'single Feishu doc title to pull')
  .option('--output <path>', 'output path relative to the manual output directory')
  .option('--recursive', 'pull child documents recursively')
  .option('--all', 'pull all top-level documents from the manual')
  .option('--position <number>', 'menu position for new docs', parseIntOption)
  .option('--skip-image-down', 'pass --skipImageDown to the web-content script')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: ReferenceWebContentOptions) => {
    const all = normalizeBooleanOption(opts, 'all', '--all');
    const recursive = normalizeBooleanOption(opts, 'recursive', '--recursive');
    const skipImageDown = normalizeBooleanOption(opts, 'skipImageDown', '--skip-image-down');
    if (!opts.doc && !all) throw new Error('reference web-content pull requires --doc or --all.');
    const result = await runWebContentCommand({
      repo: opts.repo,
      config: opts.config,
      manual: opts.manual,
      mode: 'pull',
      doc: opts.doc,
      output: opts.output,
      recursive,
      all,
      position: opts.position,
      skipImageDown
    });
    printFormatted(result, opts.format);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });
```

- [ ] **Step 3: Add `reference release run`**

Add a nested `release` command:

```ts
const release = reference
  .command('release')
  .description('run the SDK reference release workflow from a config file');

release
  .command('run')
  .description('apply/audit Feishu, check or pull web-content, and prepare PR handoff')
  .requiredOption('--config <file>', 'sdk-reference-release-workflow config path')
  .option('--write', 'write Feishu changes; omitted means dry-run')
  .option('--pull-web-content', 'pull Feishu output into web-content; omitted means stale-link check only')
  .option('--create-pr', 'create the GitHub PR; omitted means prepare command/body only')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
  .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
  .action(async (opts: ReferenceReleaseRunOptions) => {
    const normalized = normalizeBaseOptions(opts);
    const client = new FeishuClient({ host: normalized.host, timeoutMs: normalized.timeoutMs });
    const report = await runReferenceReleaseWorkflow({
      configPath: opts.config,
      writeFeishu: normalizeBooleanOption(opts, 'write', '--write'),
      pullWebContent: normalizeBooleanOption(opts, 'pullWebContent', '--pull-web-content'),
      createPr: normalizeBooleanOption(opts, 'createPr', '--create-pr'),
      applyManifest: (options) => applyReferenceManifest(client, options),
      auditManifest: (options) => auditReferenceManifest(client, options)
    });
    printFormatted(report, opts.format);
    if (!report.passed) process.exitCode = 1;
  });
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: TypeScript passes.

## Task 6: Documentation

**Files:**
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/agent/skills/sdk-reference-publisher.md`
- Create: `apps/docs/guide/sdk-reference-release-workflow.md`
- Modify: `apps/docs/.vitepress/config.ts`

- [ ] **Step 1: Update command reference**

Add to `apps/docs/reference/commands.md` under the existing `reference` section:

```md
### `reference web-content`

Run the Feishu-to-Markdown publication step against an external `web-content` checkout. The checkout is not an npm workspace in this repo.

```bash
md2feishu reference web-content check --repo /Users/liyun/web-content --manual java-v2.6.x --format json
md2feishu reference web-content pull --repo /Users/liyun/web-content --manual java-v2.6.x --doc "describeCollection()" --format json
```

`check` runs the `web-content` stale-link dry run. `pull` delegates to `web-content/scripts/lark-docs/index.js` and writes generated Markdown into the external `web-content` checkout.

### `reference release`

Run the approved SDK reference release workflow from a config file.

```bash
md2feishu reference release run --config reference-release.json --format json
md2feishu reference release run --config reference-release.json --write --format json
md2feishu reference release run --config reference-release.json --write --pull-web-content --format json
```

Without `--write`, Feishu apply is dry-run only. Without `--pull-web-content`, the command performs only the stale-link check for `web-content`.
```

- [ ] **Step 2: Add workflow guide**

Create `apps/docs/guide/sdk-reference-release-workflow.md`:

```md
# SDK Reference Release Workflow

Use this workflow when an SDK reference update needs to move from source diff to Feishu docs, Feishu Bitable tracking, `web-content` export, and PR handoff.

## Repository Boundary

`feishu-md-sync` owns the workflow and CLI contract. `web-content` remains an external publication repository because it is the production content source, not a package in this npm workspace.

## Config

```json
{
  "kind": "sdk-reference-release-workflow",
  "sdk": "java",
  "versionRange": "v2.6.19 -> v3.0.0",
  "manifest": "reference-manifest.json",
  "reportsDir": "reports",
  "webContent": {
    "repo": "/Users/liyun/web-content",
    "config": "scripts/config.json",
    "manual": "java-v2.6.x",
    "mode": "pull",
    "doc": "describeCollection()"
  },
  "pr": {
    "base": "master",
    "branch": "docs/java-v2.6.19-reference",
    "title": "Update Java SDK reference for v2.6.19"
  }
}
```

## Phases

1. Build or review the source impact matrix.
2. Convert the impact matrix into a Feishu publish manifest.
3. Dry-run Feishu apply.
4. Write Feishu changes after review.
5. Audit Feishu readback.
6. Wait for Feishu content to be ready for export.
7. Pull into the external `web-content` checkout.
8. Review the `web-content` git diff.
9. Prepare the PR body and command.

## Safety Rules

- Do not put `web-content` under `packages/`.
- Do not write the SDK reference Bitable `Slug` field.
- Run Feishu apply without `--write` before any write.
- Run Feishu audit before pulling into `web-content`.
- Review the external `web-content` diff before creating a PR.
```

- [ ] **Step 3: Update skill docs**

Modify `apps/docs/agent/skills/sdk-reference-publisher.md` so the workflow includes:

```md
After Feishu apply and audit, use `md2feishu reference web-content check` first. Once Feishu sync is ready, use `md2feishu reference web-content pull` against the external `web-content` checkout, review its git diff, then prepare the PR handoff from `md2feishu reference release run`.

Do not add `web-content` to this repo's npm workspaces. Treat it as an external publication repository owned by the publishing phase.
```

- [ ] **Step 4: Add guide to VitePress nav**

Modify `apps/docs/.vitepress/config.ts` to include `guide/sdk-reference-release-workflow` under the guide section.

- [ ] **Step 5: Build docs**

```bash
npm run docs:build
```

Expected: VitePress build passes.

## Task 7: End-to-End Verification

**Files:**
- No new files beyond previous tasks.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- reference-workflow-config reference-web-content reference-git-workflow reference-release-run
```

Expected: focused tests pass.

- [ ] **Step 2: Run full CLI verification**

```bash
npm run typecheck
npm test
npm run build
```

Expected: typecheck, Vitest, and build pass.

- [ ] **Step 3: Verify command help after build**

```bash
npm exec -- md2feishu reference --help
npm exec -- md2feishu reference web-content --help
npm exec -- md2feishu reference release run --help
```

Expected: help output lists the new command groups and flags.

- [ ] **Step 4: Verify package contents remain CLI-only**

```bash
npm pack --workspace=feishu-md-sync --dry-run
```

Expected: package tarball includes `dist`, `README.md`, `NOTICE`, and `package.json`; it does not include `apps/docs`, `web-content`, test fixtures, reports, or local run artifacts.

- [ ] **Step 5: Verify generated artifacts are ignored**

```bash
git status --short
```

Expected: no tracked build output, docs output, `dogfood/`, `.sync/`, `runs/`, or external `web-content` output appears inside this repo. Changes should be limited to source, tests, docs, and package metadata if needed.

## Rollout Notes

- First release this as explicit commands and config, not an all-in-one autonomous publisher.
- Keep `--write`, `--pull-web-content`, and `--create-pr` separate so each destructive or external side-effect phase is intentionally enabled.
- Keep source scanning as an approved artifact input in V1. After the workflow is used successfully for one Java or Node release, evaluate moving source scanners from `/Users/liyun/sdk-doc-sync` into `packages/cli/src/reference/source/` or a private `packages/reference-workflow` workspace.
