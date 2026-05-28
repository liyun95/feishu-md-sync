# Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the V1 shared harness contract for `multisdk`: environment reporting, tools registry, trace artifacts, grading, CLI commands, and docs.

**Architecture:** Add focused modules under `packages/cli/src/harness/` for environment, tools, trace, and multi-SDK grading. Keep existing `multisdk` workflow semantics intact, instrument those workflow functions to append trace events, and wire a new `md2feishu harness` command group through Commander. Documentation explains Task, Environment, Tools, Trace, and Grader without changing existing release/reference workflows.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, VitePress, existing `multisdk` task model and CLI env loader.

---

## File Structure

- Create `packages/cli/src/harness/environment.ts`: builds the machine-readable environment report and writes `environment.json`.
- Create `packages/cli/src/harness/tools.ts`: exposes the static `multisdk` tool registry and workflow parser.
- Create `packages/cli/src/harness/trace.ts`: serializes append-only `trace/events.jsonl`, hashes artifacts, and redacts secret-like arguments.
- Create `packages/cli/src/harness/multisdk-grade.ts`: grades `feishu-multisdk-task` directories and writes `grade.json` / `grade.md`.
- Create `packages/cli/test/harness-environment.test.ts`: tests environment report shape and secret safety.
- Create `packages/cli/test/harness-tools.test.ts`: tests the tool registry.
- Create `packages/cli/test/harness-trace.test.ts`: tests trace writing, hashing, reading, and redaction.
- Create `packages/cli/test/harness-multisdk-grade.test.ts`: tests incomplete, blocked, and passed grade results.
- Create `packages/cli/test/harness-cli.test.ts`: tests the new CLI command group through `tsx`.
- Modify `packages/cli/src/multisdk/workflow.ts`: append trace events from task-level workflow functions.
- Modify `packages/cli/src/cli/index.ts`: add `harness env`, `harness tools`, and `harness grade`.
- Create `apps/docs/guide/agent-harness.md`: team-facing harness overview.
- Modify `apps/docs/.vitepress/config.ts`: add the harness page to Guide navigation.
- Modify `apps/docs/reference/commands.md`: document harness commands.
- Modify `apps/docs/guide/multisdk-workflow.md`: show new harness artifacts and final grade command.
- Modify `apps/docs/agent/skills/milvus-multisdk-example-sync.md`: tell agents to inspect tools and finish with grade.

---

### Task 1: Harness Environment Report

**Files:**
- Create: `packages/cli/src/harness/environment.ts`
- Test: `packages/cli/test/harness-environment.test.ts`

- [ ] **Step 1: Write failing environment tests**

Create `packages/cli/test/harness-environment.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildHarnessEnvironmentReport,
  writeHarnessEnvironment
} from '../src/harness/environment.js';

const tempDirs: string[] = [];

describe('harness environment report', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('reports runtime, package, auth presence, env files, validation profiles, and path checks without secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-env-'));
    tempDirs.push(dir);
    const repo = join(dir, 'milvus-docs');
    await mkdir(repo, { recursive: true });

    const report = await buildHarnessEnvironmentReport({
      envLoadReport: {
        cwd: dir,
        explicitEnvFile: join(dir, 'custom.env'),
        attemptedFiles: [join(dir, 'custom.env'), join(dir, '.env')],
        loadedFiles: [join(dir, 'custom.env')]
      },
      env: {
        APP_ID: 'cli_1234567890',
        APP_SECRET: 'super-secret',
        FEISHU_HOST: 'https://open.feishu.cn',
        npm_config_user_agent: 'npm/10.8.2 node/v20.19.0 darwin arm64'
      },
      cwd: dir,
      now: () => '2026-05-26T00:00:00.000Z',
      nodeVersion: 'v20.19.0',
      packageInfo: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      },
      pathChecks: [
        { name: 'milvusDocs', path: repo },
        { name: 'missingRepo', path: join(dir, 'missing') }
      ]
    });

    expect(report).toEqual(expect.objectContaining({
      kind: 'feishu-harness-environment',
      version: 1,
      generatedAt: '2026-05-26T00:00:00.000Z',
      node: 'v20.19.0',
      npm: '10.8.2',
      cwd: dir,
      cli: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      },
      feishu: {
        host: 'https://open.feishu.cn',
        appIdPresent: true,
        appSecretPresent: true
      }
    }));
    expect(report.envFiles).toEqual([
      { path: join(dir, 'custom.env'), loaded: true, explicit: true },
      { path: join(dir, '.env'), loaded: false, explicit: false }
    ]);
    expect(report.validationProfiles.map((profile) => profile.id)).toContain('manta-k8s-maven');
    expect(report.pathChecks).toEqual([
      { name: 'milvusDocs', path: repo, exists: true, type: 'directory' },
      { name: 'missingRepo', path: join(dir, 'missing'), exists: false, type: 'missing' }
    ]);
    expect(JSON.stringify(report)).not.toContain('super-secret');
  });

  it('writes environment.json into a task directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-env-write-'));
    tempDirs.push(dir);
    const report = await buildHarnessEnvironmentReport({
      envLoadReport: {
        cwd: dir,
        attemptedFiles: [],
        loadedFiles: []
      },
      env: {},
      cwd: dir,
      now: () => '2026-05-26T00:00:00.000Z',
      nodeVersion: 'v20.19.0',
      packageInfo: {
        name: 'feishu-md-sync',
        version: '0.1.0'
      }
    });

    await writeHarnessEnvironment(dir, report);

    const saved = JSON.parse(await readFile(join(dir, 'environment.json'), 'utf8'));
    expect(saved.kind).toBe('feishu-harness-environment');
    expect(saved.feishu.appSecretPresent).toBe(false);
  });
});
```

- [ ] **Step 2: Run the environment tests and verify they fail**

Run:

```bash
npm test -- harness-environment
```

Expected: Vitest fails because `packages/cli/src/harness/environment.ts` does not exist.

- [ ] **Step 3: Implement the environment module**

Create `packages/cli/src/harness/environment.ts`:

```ts
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthDoctorReport, CliEnvLoadReport } from '../cli/env.js';
import { buildAuthDoctorReport } from '../cli/env.js';
import { listValidationProfiles } from '../multisdk/validation-profile.js';

export type HarnessPathCheckInput = {
  name: string;
  path: string;
};

export type HarnessPathCheck = HarnessPathCheckInput & {
  exists: boolean;
  type: 'file' | 'directory' | 'other' | 'missing';
};

export type HarnessValidationProfileSummary = {
  id: string;
  language: string;
  title: string;
  containerImage?: string;
  commands: string[];
};

export type HarnessEnvironmentReport = {
  kind: 'feishu-harness-environment';
  version: 1;
  generatedAt: string;
  node: string;
  npm: string | null;
  cwd: string;
  cli: {
    name: string;
    version: string;
  };
  feishu: {
    host: string;
    appIdPresent: boolean;
    appSecretPresent: boolean;
  };
  envFiles: AuthDoctorReport['envFiles'];
  validationProfiles: HarnessValidationProfileSummary[];
  pathChecks: HarnessPathCheck[];
};

export type HarnessPackageInfo = {
  name: string;
  version: string;
};

export type HarnessEnvironmentInput = {
  envLoadReport: CliEnvLoadReport;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => string;
  nodeVersion?: string;
  npmVersion?: string | null;
  packageInfo?: HarnessPackageInfo;
  pathChecks?: HarnessPathCheckInput[];
};

export async function buildHarnessEnvironmentReport(
  input: HarnessEnvironmentInput
): Promise<HarnessEnvironmentReport> {
  const env = input.env ?? process.env;
  const auth = buildAuthDoctorReport(input.envLoadReport, env);
  const packageInfo = input.packageInfo ?? await readCliPackageInfo();
  return {
    kind: 'feishu-harness-environment',
    version: 1,
    generatedAt: input.now?.() ?? new Date().toISOString(),
    node: input.nodeVersion ?? process.version,
    npm: input.npmVersion ?? npmVersionFromUserAgent(env.npm_config_user_agent),
    cwd: input.cwd ?? input.envLoadReport.cwd,
    cli: packageInfo,
    feishu: {
      host: auth.feishuHost,
      appIdPresent: auth.appId.present,
      appSecretPresent: auth.appSecret.present
    },
    envFiles: auth.envFiles,
    validationProfiles: listValidationProfiles().map((profile) => ({
      id: profile.id,
      language: profile.language,
      title: profile.title,
      containerImage: profile.containerImage,
      commands: profile.commands
    })),
    pathChecks: await Promise.all((input.pathChecks ?? []).map(checkHarnessPath))
  };
}

export async function writeHarnessEnvironment(
  taskDir: string,
  report: HarnessEnvironmentReport
): Promise<string> {
  await mkdir(taskDir, { recursive: true });
  const path = join(taskDir, 'environment.json');
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

async function checkHarnessPath(input: HarnessPathCheckInput): Promise<HarnessPathCheck> {
  try {
    const info = await stat(input.path);
    return {
      ...input,
      exists: true,
      type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      ...input,
      exists: false,
      type: 'missing'
    };
  }
}

async function readCliPackageInfo(): Promise<HarnessPackageInfo> {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  ) as Partial<HarnessPackageInfo>;
  return {
    name: packageJson.name ?? 'feishu-md-sync',
    version: packageJson.version ?? '0.0.0'
  };
}

function npmVersionFromUserAgent(userAgent: string | undefined): string | null {
  const match = userAgent?.match(/(?:^|\s)npm\/([^\s]+)/);
  return match?.[1] ?? null;
}
```

- [ ] **Step 4: Run the environment tests and verify they pass**

Run:

```bash
npm test -- harness-environment
```

Expected: `packages/cli/test/harness-environment.test.ts` passes.

- [ ] **Step 5: Commit the environment module**

Run:

```bash
git add packages/cli/src/harness/environment.ts packages/cli/test/harness-environment.test.ts
git commit -m "Add harness environment report"
```

Expected: commit succeeds.

---

### Task 2: Harness Tools Registry

**Files:**
- Create: `packages/cli/src/harness/tools.ts`
- Test: `packages/cli/test/harness-tools.test.ts`

- [ ] **Step 1: Write failing tools registry tests**

Create `packages/cli/test/harness-tools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getHarnessTools, parseHarnessWorkflow } from '../src/harness/tools.js';

describe('harness tools registry', () => {
  it('lists the multisdk tool surface with safety metadata', () => {
    const registry = getHarnessTools('multisdk');

    expect(registry).toEqual(expect.objectContaining({
      kind: 'feishu-harness-tools',
      version: 1,
      workflow: 'multisdk'
    }));
    expect(registry.tools.map((tool) => tool.name)).toEqual([
      'multisdk init',
      'multisdk status',
      'multisdk export',
      'multisdk profile',
      'multisdk verify',
      'multisdk diff',
      'multisdk apply',
      'multisdk audit',
      'multisdk land-docs',
      'multisdk finalize',
      'doctor auth',
      'code-blocks inspect',
      'code-blocks audit',
      'pull'
    ]);
    expect(registry.tools.find((tool) => tool.name === 'multisdk apply')).toEqual(expect.objectContaining({
      mode: 'dry-run-or-write',
      writesFeishu: true,
      writesLocalFiles: true,
      writesExternalRepos: false,
      requires: ['taskDir', 'language'],
      writeRequires: ['--write', 'validation evidence', 'fresh dry-run']
    }));
  });

  it('parses supported workflows and rejects unsupported workflows', () => {
    expect(parseHarnessWorkflow('multisdk')).toBe('multisdk');
    expect(() => parseHarnessWorkflow('release')).toThrow(/Unsupported harness workflow release/);
    expect(() => parseHarnessWorkflow('')).toThrow(/Unsupported harness workflow/);
  });
});
```

- [ ] **Step 2: Run the tools tests and verify they fail**

Run:

```bash
npm test -- harness-tools
```

Expected: Vitest fails because `packages/cli/src/harness/tools.ts` does not exist.

- [ ] **Step 3: Implement the tools registry**

Create `packages/cli/src/harness/tools.ts`:

```ts
export type HarnessWorkflow = 'multisdk';

export type HarnessToolMode =
  | 'read'
  | 'write-task'
  | 'record-evidence'
  | 'dry-run-or-write'
  | 'readback-audit'
  | 'external-dry-run-or-write'
  | 'finalize';

export type HarnessTool = {
  name: string;
  mode: HarnessToolMode;
  writesFeishu: boolean;
  writesLocalFiles: boolean;
  writesExternalRepos: boolean;
  requires: string[];
  writeRequires: string[];
  artifacts: string[];
  description: string;
};

export type HarnessToolsRegistry = {
  kind: 'feishu-harness-tools';
  version: 1;
  workflow: HarnessWorkflow;
  tools: HarnessTool[];
};

const MULTISDK_TOOLS: HarnessTool[] = [
  {
    name: 'multisdk init',
    mode: 'write-task',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['feishuDoc', '--out'],
    writeRequires: [],
    artifacts: ['task.json', 'manifest.json', 'snippets/', 'environment.json', 'trace/events.jsonl'],
    description: 'Initialize a resumable multi-SDK task from a Feishu document.'
  },
  {
    name: 'multisdk status',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['taskDir'],
    writeRequires: [],
    artifacts: [],
    description: 'Show task progress from task.json.'
  },
  {
    name: 'multisdk export',
    mode: 'write-task',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['manifest.json', 'snippets/', 'task.json', 'trace/events.jsonl'],
    description: 'Refresh snippet files for one SDK language.'
  },
  {
    name: 'multisdk profile',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['language'],
    writeRequires: [],
    artifacts: [],
    description: 'Show validation profiles for one SDK language.'
  },
  {
    name: 'multisdk verify',
    mode: 'record-evidence',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language', '--evidence', '--command'],
    writeRequires: [],
    artifacts: ['task.json', 'evidence/evidence.json', 'evidence/evidence.md', 'trace/events.jsonl'],
    description: 'Record validation evidence for one SDK language.'
  },
  {
    name: 'multisdk diff',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['trace/events.jsonl'],
    description: 'Show a block-level diff before apply.'
  },
  {
    name: 'multisdk apply',
    mode: 'dry-run-or-write',
    writesFeishu: true,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: ['--write', 'validation evidence', 'fresh dry-run'],
    artifacts: ['task.json', 'trace/events.jsonl'],
    description: 'Dry-run or write one SDK language.'
  },
  {
    name: 'multisdk audit',
    mode: 'readback-audit',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir', 'language'],
    writeRequires: [],
    artifacts: ['task.json', 'trace/events.jsonl'],
    description: 'Read back and audit one SDK language.'
  },
  {
    name: 'multisdk land-docs',
    mode: 'external-dry-run-or-write',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: true,
    requires: ['taskDir', 'language', '--repo', '--target'],
    writeRequires: ['--write', 'passing multisdk audit', 'branch hygiene when --base is provided'],
    artifacts: ['task.json', 'inputs/feishu.reviewed-baseline.md', 'trace/events.jsonl'],
    description: 'Patch reviewed Feishu code blocks into a local docs repo target.'
  },
  {
    name: 'multisdk finalize',
    mode: 'finalize',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['taskDir'],
    writeRequires: ['all languages audited'],
    artifacts: ['task.json', 'handoff.md', 'trace/events.jsonl'],
    description: 'Run final full audit and write the handoff summary.'
  },
  {
    name: 'doctor auth',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: [],
    writeRequires: [],
    artifacts: [],
    description: 'Report auth env loading without printing secrets.'
  },
  {
    name: 'code-blocks inspect',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['feishuDoc'],
    writeRequires: [],
    artifacts: [],
    description: 'Inspect Feishu code block inventory.'
  },
  {
    name: 'code-blocks audit',
    mode: 'readback-audit',
    writesFeishu: false,
    writesLocalFiles: false,
    writesExternalRepos: false,
    requires: ['feishuDoc', '--expect'],
    writeRequires: [],
    artifacts: [],
    description: 'Audit expected code-block languages, order, and placeholders.'
  },
  {
    name: 'pull',
    mode: 'read',
    writesFeishu: false,
    writesLocalFiles: true,
    writesExternalRepos: false,
    requires: ['feishuDoc'],
    writeRequires: [],
    artifacts: ['output markdown when --output is provided'],
    description: 'Export current Feishu content as best-effort Markdown.'
  }
];

export function parseHarnessWorkflow(value: string): HarnessWorkflow {
  if (value === 'multisdk') return value;
  throw new Error(`Unsupported harness workflow ${value || '(empty)'}. Expected multisdk.`);
}

export function getHarnessTools(workflow: HarnessWorkflow): HarnessToolsRegistry {
  return {
    kind: 'feishu-harness-tools',
    version: 1,
    workflow,
    tools: workflow === 'multisdk' ? MULTISDK_TOOLS : []
  };
}
```

- [ ] **Step 4: Run the tools tests and verify they pass**

Run:

```bash
npm test -- harness-tools
```

Expected: `packages/cli/test/harness-tools.test.ts` passes.

- [ ] **Step 5: Commit the tools registry**

Run:

```bash
git add packages/cli/src/harness/tools.ts packages/cli/test/harness-tools.test.ts
git commit -m "Add harness tools registry"
```

Expected: commit succeeds.

---

### Task 3: Harness Trace Writer

**Files:**
- Create: `packages/cli/src/harness/trace.ts`
- Test: `packages/cli/test/harness-trace.test.ts`

- [ ] **Step 1: Write failing trace tests**

Create `packages/cli/test/harness-trace.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendHarnessTraceEvent,
  readHarnessTraceEvents,
  redactTraceArguments
} from '../src/harness/trace.js';

const tempDirs: string[] = [];

describe('harness trace', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('appends trace events with relative artifact paths and hashes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trace-'));
    tempDirs.push(dir);
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'evidence/java.log'), 'PASS\n', 'utf8');

    const event = await appendHarnessTraceEvent({
      workflow: 'multisdk',
      taskDir: dir,
      tool: 'multisdk.verify',
      mode: 'record-evidence',
      status: 'passed',
      startedAt: '2026-05-26T00:00:00.000Z',
      endedAt: '2026-05-26T00:00:02.000Z',
      arguments: {
        language: 'java',
        appSecret: 'secret-value'
      },
      artifactPaths: [join(dir, 'evidence/java.log')],
      summary: 'Recorded java validation evidence.',
      eventId: 'event-1'
    });

    expect(event).toEqual(expect.objectContaining({
      kind: 'feishu-harness-trace-event',
      version: 1,
      eventId: 'event-1',
      workflow: 'multisdk',
      taskDir: dir,
      tool: 'multisdk.verify',
      mode: 'record-evidence',
      status: 'passed',
      durationMs: 2000,
      summary: 'Recorded java validation evidence.'
    }));
    expect(event.arguments).toEqual({
      language: 'java',
      appSecret: '[REDACTED]'
    });
    expect(event.artifacts).toEqual([
      {
        path: 'evidence/java.log',
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    ]);

    const events = await readHarnessTraceEvents(dir);
    expect(events).toEqual([event]);
  });

  it('redacts secret-like nested arguments', () => {
    expect(redactTraceArguments({
      plain: 'value',
      nested: {
        password: 'pw',
        accessToken: 'token',
        documentId: 'doc-id'
      }
    })).toEqual({
      plain: 'value',
      nested: {
        password: '[REDACTED]',
        accessToken: '[REDACTED]',
        documentId: 'doc-id'
      }
    });
  });

  it('returns an empty trace for legacy tasks with no trace file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-trace-empty-'));
    tempDirs.push(dir);

    await expect(readHarnessTraceEvents(dir)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run the trace tests and verify they fail**

Run:

```bash
npm test -- harness-trace
```

Expected: Vitest fails because `packages/cli/src/harness/trace.ts` does not exist.

- [ ] **Step 3: Implement the trace module**

Create `packages/cli/src/harness/trace.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { HarnessWorkflow } from './tools.js';

export type HarnessTraceStatus = 'passed' | 'failed';

export type HarnessTraceArtifact = {
  path: string;
  sha256?: string;
};

export type HarnessTraceEvent = {
  kind: 'feishu-harness-trace-event';
  version: 1;
  eventId: string;
  workflow: HarnessWorkflow;
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: HarnessTraceStatus;
  arguments: unknown;
  artifacts: HarnessTraceArtifact[];
  summary: string;
};

export type AppendHarnessTraceEventInput = {
  workflow: HarnessWorkflow;
  taskDir: string;
  tool: string;
  mode: string;
  startedAt: string;
  endedAt?: string;
  status: HarnessTraceStatus;
  arguments?: unknown;
  artifactPaths?: string[];
  summary: string;
  eventId?: string;
};

export async function appendHarnessTraceEvent(
  input: AppendHarnessTraceEventInput
): Promise<HarnessTraceEvent> {
  const event = await buildHarnessTraceEvent(input);
  const path = harnessTracePath(input.taskDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

export async function readHarnessTraceEvents(taskDir: string): Promise<HarnessTraceEvent[]> {
  try {
    const content = await readFile(harnessTracePath(taskDir), 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HarnessTraceEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function harnessTracePath(taskDir: string): string {
  return join(taskDir, 'trace/events.jsonl');
}

export function redactTraceArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTraceArguments);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSecretLikeKey(key) ? '[REDACTED]' : redactTraceArguments(child);
  }
  return output;
}

async function buildHarnessTraceEvent(input: AppendHarnessTraceEventInput): Promise<HarnessTraceEvent> {
  const endedAt = input.endedAt ?? new Date().toISOString();
  return {
    kind: 'feishu-harness-trace-event',
    version: 1,
    eventId: input.eventId ?? randomUUID(),
    workflow: input.workflow,
    taskDir: input.taskDir,
    tool: input.tool,
    mode: input.mode,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(input.startedAt)),
    status: input.status,
    arguments: redactTraceArguments(input.arguments ?? {}),
    artifacts: await Promise.all((input.artifactPaths ?? []).map((path) => traceArtifact(input.taskDir, path))),
    summary: input.summary
  };
}

async function traceArtifact(taskDir: string, path: string): Promise<HarnessTraceArtifact> {
  const absolutePath = isAbsolute(path) ? path : join(taskDir, path);
  return {
    path: relative(taskDir, absolutePath),
    sha256: await sha256File(absolutePath)
  };
}

async function sha256File(path: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(path);
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'password' ||
    normalized === 'appsecret' ||
    normalized === 'app_secret' ||
    normalized === 'secret' ||
    normalized === 'accesstoken' ||
    normalized === 'access_token' ||
    normalized === 'refreshtoken' ||
    normalized === 'refresh_token';
}
```

- [ ] **Step 4: Run the trace tests and verify they pass**

Run:

```bash
npm test -- harness-trace
```

Expected: `packages/cli/test/harness-trace.test.ts` passes.

- [ ] **Step 5: Commit the trace module**

Run:

```bash
git add packages/cli/src/harness/trace.ts packages/cli/test/harness-trace.test.ts
git commit -m "Add harness trace writer"
```

Expected: commit succeeds.

---

### Task 4: Multi-SDK Harness Grader

**Files:**
- Create: `packages/cli/src/harness/multisdk-grade.ts`
- Test: `packages/cli/test/harness-multisdk-grade.test.ts`

- [ ] **Step 1: Write failing grader tests**

Create `packages/cli/test/harness-multisdk-grade.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gradeMultisdkTask,
  renderHarnessGradeMarkdown,
  writeHarnessGradeArtifacts
} from '../src/harness/multisdk-grade.js';
import { appendHarnessTraceEvent } from '../src/harness/trace.js';
import { MULTISDK_LANGUAGES } from '../src/multisdk/language.js';
import { createInitialMultisdkTask, saveMultisdkTask, type MultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk harness grader', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('grades a fresh task as incomplete and suggests the next export command', async () => {
    const dir = await tempDir();
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('incomplete');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-status',
      passed: false,
      severity: 'incomplete'
    }));
    expect(grade.nextCommands[0]).toBe(`md2feishu multisdk export ${dir} --language java`);
  });

  it('blocks a written language that has no validation evidence', async () => {
    const dir = await tempDir();
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: {
          ...task.languages.java,
          status: 'written',
          snippetsReady: true,
          validated: false,
          dryRunPassed: true,
          writePassed: true,
          evidence: []
        }
      }
    });

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('blocked');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'java-evidence',
      passed: false,
      severity: 'blocked'
    }));
  });

  it('blocks a final-passed task when trace is missing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'handoff.md'), '# handoff\n', 'utf8');
    await saveMultisdkTask(completedTask(dir, true));

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });

    expect(grade.result).toBe('blocked');
    expect(grade.checks).toContainEqual(expect.objectContaining({
      id: 'trace-exists',
      passed: false,
      severity: 'blocked'
    }));
  });

  it('passes a completed task with final audit, handoff, evidence, and trace', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'evidence'), { recursive: true });
    await writeFile(join(dir, 'handoff.md'), '# handoff\n', 'utf8');
    await writeFile(join(dir, 'evidence/evidence.json'), JSON.stringify({
      kind: 'feishu-multisdk-evidence',
      version: 1,
      items: MULTISDK_LANGUAGES.map((language) => ({
        language,
        path: `evidence/${language}.log`,
        command: `${language} smoke`,
        recordedAt: '2026-05-26T00:00:00.000Z'
      }))
    }, null, 2), 'utf8');
    await saveMultisdkTask(completedTask(dir, true));
    for (const language of MULTISDK_LANGUAGES) {
      await appendHarnessTraceEvent({
        workflow: 'multisdk',
        taskDir: dir,
        tool: 'multisdk.audit',
        mode: 'readback-audit',
        status: 'passed',
        startedAt: '2026-05-26T00:00:00.000Z',
        endedAt: '2026-05-26T00:00:01.000Z',
        arguments: { language },
        summary: `${language} audit passed.`,
        eventId: `audit-${language}`
      });
    }

    const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-26T00:00:00.000Z' });
    await writeHarnessGradeArtifacts(dir, grade);

    expect(grade.result).toBe('passed');
    expect(grade.nextCommands).toEqual([]);
    expect(renderHarnessGradeMarkdown(grade)).toContain('Result: passed');
    expect(JSON.parse(await readFile(join(dir, 'grade.json'), 'utf8')).result).toBe('passed');
    await expect(readFile(join(dir, 'grade.md'), 'utf8')).resolves.toContain('Result: passed');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-grade-'));
  tempDirs.push(dir);
  return dir;
}

function completedTask(taskDir: string, finalAuditPassed: boolean): MultisdkTask {
  const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir });
  for (const language of MULTISDK_LANGUAGES) {
    task.languages[language] = {
      status: 'audited',
      sourceVerified: true,
      snippetsReady: true,
      validated: true,
      dryRunPassed: true,
      dryRunHashes: [{ file: `snippets/${language}.txt`, contentHash: `sha256:${language}` }],
      writePassed: true,
      auditPassed: true,
      evidence: [{
        path: `evidence/${language}.log`,
        command: `${language} smoke`,
        recordedAt: '2026-05-26T00:00:00.000Z'
      }]
    };
  }
  return {
    ...task,
    finalAuditPassed
  };
}
```

- [ ] **Step 2: Run the grader tests and verify they fail**

Run:

```bash
npm test -- harness-multisdk-grade
```

Expected: Vitest fails because `packages/cli/src/harness/multisdk-grade.ts` does not exist.

- [ ] **Step 3: Implement the multi-SDK grader**

Create `packages/cli/src/harness/multisdk-grade.ts`:

```ts
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MULTISDK_LANGUAGES, type MultisdkLanguage } from '../multisdk/language.js';
import { loadMultisdkTask, type MultisdkTask } from '../multisdk/task.js';
import { readHarnessTraceEvents } from './trace.js';

export type HarnessGradeResult = 'passed' | 'blocked' | 'incomplete';
export type HarnessGradeSeverity = 'passed' | 'blocked' | 'incomplete';

export type HarnessGradeCheck = {
  id: string;
  passed: boolean;
  severity: HarnessGradeSeverity;
  message: string;
};

export type HarnessGrade = {
  kind: 'feishu-harness-grade';
  version: 1;
  workflow: 'multisdk';
  taskDir: string;
  generatedAt: string;
  result: HarnessGradeResult;
  checks: HarnessGradeCheck[];
  nextCommands: string[];
};

export type GradeMultisdkTaskOptions = {
  taskDir: string;
  now?: () => string;
};

export async function gradeMultisdkTask(options: GradeMultisdkTaskOptions): Promise<HarnessGrade> {
  const checks: HarnessGradeCheck[] = [];
  const nextCommands: string[] = [];
  let task: MultisdkTask;

  try {
    task = await loadMultisdkTask(options.taskDir);
    checks.push(pass('task-valid', 'task.json is a valid feishu-multisdk-task.'));
  } catch (error) {
    checks.push(fail('task-valid', 'blocked', `Cannot read a valid multisdk task: ${(error as Error).message}`));
    return grade(options, checks, nextCommands);
  }

  for (const language of MULTISDK_LANGUAGES) {
    gradeLanguage(task, language, checks, nextCommands);
  }

  const traceEvents = await readHarnessTraceEvents(options.taskDir);
  if (traceEvents.length > 0) {
    checks.push(pass('trace-exists', `Trace contains ${traceEvents.length} event(s).`));
  } else if (task.finalAuditPassed) {
    checks.push(fail('trace-exists', 'blocked', 'Trace is missing even though finalAuditPassed is true.'));
  } else {
    checks.push(fail('trace-exists', 'incomplete', 'Trace is missing for this in-progress or legacy task.'));
  }

  if (task.finalAuditPassed) {
    const handoffExists = await exists(join(options.taskDir, 'handoff.md'));
    checks.push(handoffExists
      ? pass('handoff-exists', 'handoff.md exists.')
      : fail('handoff-exists', 'blocked', 'handoff.md is required when finalAuditPassed is true.'));
  } else {
    checks.push(fail('final-audit', 'incomplete', 'Final multi-SDK audit has not passed.'));
    if (!nextCommands.includes(`md2feishu multisdk finalize ${options.taskDir}`)) {
      nextCommands.push(`md2feishu multisdk finalize ${options.taskDir}`);
    }
  }

  return grade(options, checks, nextCommands);
}

export async function writeHarnessGradeArtifacts(taskDir: string, gradeResult: HarnessGrade): Promise<void> {
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'grade.json'), `${JSON.stringify(gradeResult, null, 2)}\n`, 'utf8');
  await writeFile(join(taskDir, 'grade.md'), renderHarnessGradeMarkdown(gradeResult), 'utf8');
}

export function renderHarnessGradeMarkdown(gradeResult: HarnessGrade): string {
  const lines = [
    '# Harness Grade',
    '',
    `Workflow: ${gradeResult.workflow}`,
    `Task: ${gradeResult.taskDir}`,
    `Generated: ${gradeResult.generatedAt}`,
    `Result: ${gradeResult.result}`,
    '',
    '## Checks',
    ''
  ];
  for (const check of gradeResult.checks) {
    lines.push(`- ${check.passed ? 'PASS' : check.severity.toUpperCase()}: ${check.id} - ${check.message}`);
  }
  if (gradeResult.nextCommands.length > 0) {
    lines.push('', '## Next Commands', '');
    for (const command of gradeResult.nextCommands) lines.push(`- \`${command}\``);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function gradeLanguage(
  task: MultisdkTask,
  language: MultisdkLanguage,
  checks: HarnessGradeCheck[],
  nextCommands: string[]
): void {
  const state = task.languages[language];
  if (state.status === 'blocked') {
    checks.push(fail(`${language}-status`, 'blocked', state.reason ?? `${language} is blocked.`));
    return;
  }

  if (state.status === 'pending') {
    checks.push(fail(`${language}-status`, 'incomplete', `${language} has not been exported.`));
    nextCommands.push(`md2feishu multisdk export ${task.taskDir} --language ${language}`);
    return;
  }

  checks.push(pass(`${language}-status`, `${language} status is ${state.status}.`));

  if (!state.snippetsReady) {
    checks.push(fail(`${language}-snippets`, 'blocked', `${language} is beyond pending but snippetsReady is false.`));
    nextCommands.push(`md2feishu multisdk export ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-snippets`, `${language} snippets are ready.`));

  if (!state.validated || state.evidence.length === 0) {
    const severity: HarnessGradeSeverity = state.writePassed || state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-evidence`, severity, `${language} validation evidence is missing.`));
    nextCommands.push(`md2feishu multisdk verify ${task.taskDir} --language ${language} --evidence <file> --command "<command>"`);
    return;
  }
  checks.push(pass(`${language}-evidence`, `${language} has validation evidence.`));

  if (!state.dryRunPassed) {
    const severity: HarnessGradeSeverity = state.writePassed || state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-dry-run`, severity, `${language} dry-run has not passed.`));
    nextCommands.push(`md2feishu multisdk apply ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-dry-run`, `${language} dry-run passed.`));

  if (!state.writePassed) {
    const severity: HarnessGradeSeverity = state.auditPassed ? 'blocked' : 'incomplete';
    checks.push(fail(`${language}-write`, severity, `${language} write has not passed.`));
    nextCommands.push(`md2feishu multisdk apply ${task.taskDir} --language ${language} --write -y`);
    return;
  }
  checks.push(pass(`${language}-write`, `${language} write passed.`));

  if (!state.auditPassed || state.status !== 'audited') {
    checks.push(fail(`${language}-audit`, 'incomplete', `${language} readback audit has not passed.`));
    nextCommands.push(`md2feishu multisdk audit ${task.taskDir} --language ${language}`);
    return;
  }
  checks.push(pass(`${language}-audit`, `${language} readback audit passed.`));
}

function grade(
  options: GradeMultisdkTaskOptions,
  checks: HarnessGradeCheck[],
  nextCommands: string[]
): HarnessGrade {
  const result = checks.some((check) => !check.passed && check.severity === 'blocked')
    ? 'blocked'
    : checks.some((check) => !check.passed && check.severity === 'incomplete')
      ? 'incomplete'
      : 'passed';
  return {
    kind: 'feishu-harness-grade',
    version: 1,
    workflow: 'multisdk',
    taskDir: options.taskDir,
    generatedAt: options.now?.() ?? new Date().toISOString(),
    result,
    checks,
    nextCommands: Array.from(new Set(nextCommands))
  };
}

function pass(id: string, message: string): HarnessGradeCheck {
  return { id, passed: true, severity: 'passed', message };
}

function fail(id: string, severity: Exclude<HarnessGradeSeverity, 'passed'>, message: string): HarnessGradeCheck {
  return { id, passed: false, severity, message };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
```

- [ ] **Step 4: Run the grader tests and verify they pass**

Run:

```bash
npm test -- harness-multisdk-grade
```

Expected: `packages/cli/test/harness-multisdk-grade.test.ts` passes.

- [ ] **Step 5: Commit the grader**

Run:

```bash
git add packages/cli/src/harness/multisdk-grade.ts packages/cli/test/harness-multisdk-grade.test.ts
git commit -m "Add multisdk harness grader"
```

Expected: commit succeeds.

---

### Task 5: Multi-SDK Trace Instrumentation

**Files:**
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Test: `packages/cli/test/multisdk-harness-trace.test.ts`

- [ ] **Step 1: Write failing multi-SDK trace tests**

Create `packages/cli/test/multisdk-harness-trace.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import { readHarnessTraceEvents } from '../src/harness/trace.js';
import {
  applyMultisdkLanguage,
  initMultisdkTask,
  recordMultisdkVerification
} from '../src/multisdk/workflow.js';
import { createInitialMultisdkTask, saveMultisdkTask } from '../src/multisdk/task.js';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';

const tempDirs: string[] = [];

describe('multisdk harness trace integration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes trace events for init and verify', async () => {
    const dir = await tempDir();
    await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      inventory: inventory()
    });
    const evidencePath = join(dir, 'java.log');
    await writeFile(evidencePath, 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath,
      command: 'mvn test'
    });

    const events = await readHarnessTraceEvents(dir);
    expect(events.map((event) => event.tool)).toEqual(['multisdk.init', 'multisdk.verify']);
    expect(events[0]).toEqual(expect.objectContaining({
      workflow: 'multisdk',
      status: 'passed',
      mode: 'initialize'
    }));
    expect(events[1].arguments).toEqual(expect.objectContaining({ language: 'java' }));
    expect(events[1].artifacts.map((artifact) => artifact.path)).toContain('evidence/evidence.json');
  });

  it('writes a failed trace event when apply is blocked by missing evidence', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    const task = createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir });
    await saveMultisdkTask({
      ...task,
      languages: {
        ...task.languages,
        java: { ...task.languages.java, status: 'exported', snippetsReady: true }
      }
    });

    await expect(applyMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      write: true,
      client: {
        batchUpdateBlocks: async () => []
      }
    })).rejects.toThrow(/requires verification evidence/);

    const events = await readHarnessTraceEvents(dir);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      tool: 'multisdk.apply',
      status: 'failed'
    }));
    expect(events.at(-1)?.summary).toContain('requires verification evidence');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-trace-'));
  tempDirs.push(dir);
  return dir;
}

function inventory(): CodeBlockInventory {
  return {
    documentId: 'doc',
    groups: [
      {
        groupId: 'group-1',
        anchorBlockId: 'python-1',
        parentBlockId: 'doc',
        items: [
          {
            blockId: 'python-1',
            language: 'python',
            text: 'print("ok")',
            index: 0,
            parentBlockId: 'doc'
          }
        ]
      }
    ]
  };
}

function manifest(): CodeBlockManifest {
  return {
    kind: 'feishu-code-block-manifest',
    version: 1,
    document: 'doc-url',
    documentId: 'doc',
    generatedAt: '2026-05-26T00:00:00.000Z',
    items: [
      {
        action: 'insert',
        groupId: 'group-1',
        anchorBlockId: 'python-1',
        insertAfterBlockId: 'python-1',
        parentBlockId: 'doc',
        language: 'java',
        file: 'snippets/java.java'
      }
    ]
  };
}
```

- [ ] **Step 2: Run the trace integration tests and verify they fail**

Run:

```bash
npm test -- multisdk-harness-trace
```

Expected: tests fail because `multisdk` workflow functions do not append harness trace events.

- [ ] **Step 3: Add trace helpers to `packages/cli/src/multisdk/workflow.ts`**

Modify imports at the top of `packages/cli/src/multisdk/workflow.ts`:

```ts
import { appendHarnessTraceEvent } from '../harness/trace.js';
```

Add these helpers near the bottom of `packages/cli/src/multisdk/workflow.ts`:

```ts
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
    console.warn(`Failed to write harness trace: ${(error as Error).message}`);
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
      summary: (input.error as Error).message
    });
  } catch (traceError) {
    console.warn(`Failed to write harness trace after workflow error: ${(traceError as Error).message}`);
  }
}
```

- [ ] **Step 4: Instrument `initMultisdkTask`**

Wrap the body of `initMultisdkTask` with a started timestamp, success trace, and failure trace. The final function should use this structure:

```ts
export async function initMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }> {
  const startedAt = new Date().toISOString();
  try {
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
    await traceMultisdkSuccess({
      taskDir: input.taskDir,
      tool: 'multisdk.init',
      mode: 'initialize',
      startedAt,
      arguments: {
        document: input.document,
        documentId: input.documentId
      },
      artifactPaths: ['task.json', 'manifest.json', ...result.files],
      summary: 'Initialized multi-SDK task.'
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
        documentId: input.documentId
      },
      error
    });
    throw error;
  }
}
```

- [ ] **Step 5: Instrument the remaining `multisdk` workflow functions**

Apply the same started/success/failure pattern to the remaining exported functions in `packages/cli/src/multisdk/workflow.ts` with these exact trace values:

| Function | Tool | Mode | Arguments | Success artifacts | Success summary |
| --- | --- | --- | --- | --- | --- |
| `exportMultisdkLanguage` | `multisdk.export` | `export-language` | `{ language: input.language }` | `['task.json', 'manifest.json', ...refreshed.files]` | `Exported <language> snippets.` |
| `recordMultisdkVerification` | `multisdk.verify` | `record-evidence` | `{ language: input.language, profile: input.profile, sdkVersion: input.sdkVersion, sourceCommit: input.sourceCommit, endpoint: input.endpoint }` | `['task.json', 'evidence/evidence.json', 'evidence/evidence.md']` | `Recorded <language> validation evidence.` |
| `applyMultisdkLanguage` | `multisdk.apply` | `input.write ? 'write' : 'dry-run'` | `{ language: input.language, write: input.write }` | `['task.json']` | `Applied <language> in write mode.` or `Dry-ran <language> apply.` |
| `diffMultisdkLanguage` | `multisdk.diff` | `diff` | `{ language: input.language }` | `[]` | `Built <language> code block diff.` |
| `auditMultisdkLanguage` | `multisdk.audit` | `readback-audit` | `{ language: input.language }` | `['task.json']` | `Audited <language> readback.` |
| `finalizeMultisdkTask` | `multisdk.finalize` | `finalize` | `{}` | `['task.json', 'handoff.md']` | `Finalized multi-SDK task.` |

For `applyMultisdkLanguage`, trace failures from precondition errors as well as manifest apply failures. Keep the existing thrown error messages unchanged.

- [ ] **Step 6: Run the multi-SDK trace integration tests**

Run:

```bash
npm test -- multisdk-harness-trace
```

Expected: `packages/cli/test/multisdk-harness-trace.test.ts` passes.

- [ ] **Step 7: Run the existing multi-SDK workflow tests**

Run:

```bash
npm test -- multisdk-workflow
```

Expected: existing multi-SDK workflow tests still pass with the additional trace files.

- [ ] **Step 8: Commit the trace instrumentation**

Run:

```bash
git add packages/cli/src/multisdk/workflow.ts packages/cli/test/multisdk-harness-trace.test.ts
git commit -m "Trace multisdk workflow steps"
```

Expected: commit succeeds.

---

### Task 6: Harness CLI Commands

**Files:**
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/harness-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `packages/cli/test/harness-cli.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('harness CLI commands', () => {
  it('prints the multisdk tools registry as JSON', async () => {
    const result = await runCli(['harness', 'tools', '--workflow', 'multisdk', '--format', 'json']);
    const parsed = JSON.parse(result.stdout);

    expect(parsed.kind).toBe('feishu-harness-tools');
    expect(parsed.workflow).toBe('multisdk');
    expect(parsed.tools.map((tool: { name: string }) => tool.name)).toContain('multisdk apply');
  });

  it('prints the environment report without secrets', async () => {
    const result = await runCli(['harness', 'env', '--format', 'json'], {
      APP_ID: 'cli_test_app',
      APP_SECRET: 'cli_test_secret'
    });
    const parsed = JSON.parse(result.stdout);

    expect(parsed.kind).toBe('feishu-harness-environment');
    expect(parsed.feishu.appIdPresent).toBe(true);
    expect(parsed.feishu.appSecretPresent).toBe(true);
    expect(result.stdout).not.toContain('cli_test_secret');
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env
    },
    maxBuffer: 10 * 1024 * 1024
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
```

- [ ] **Step 2: Run the CLI tests and verify they fail**

Run:

```bash
npm test -- harness-cli
```

Expected: tests fail because the `harness` command group does not exist.

- [ ] **Step 3: Add harness imports and option types**

Modify `packages/cli/src/cli/index.ts` imports:

```ts
import { buildHarnessEnvironmentReport, writeHarnessEnvironment, type HarnessPathCheckInput } from '../harness/environment.js';
import { gradeMultisdkTask, writeHarnessGradeArtifacts } from '../harness/multisdk-grade.js';
import { getHarnessTools, parseHarnessWorkflow } from '../harness/tools.js';
```

Add these option types near the other CLI option types:

```ts
type HarnessEnvCommandOptions = FormatCommandOptions & {
  milvusDocs?: string;
  webContentRepo?: string;
  sdkRepo?: string[];
};

type HarnessToolsCommandOptions = FormatCommandOptions & {
  workflow: string;
};

type HarnessGradeCommandOptions = FormatCommandOptions & {
  workflow: string;
};
```

- [ ] **Step 4: Add the `harness` command group**

Add this command group after `doctor auth` and before `diff` in `packages/cli/src/cli/index.ts`:

```ts
const harness = program
  .command('harness')
  .description('inspect harness environment, tools, trace, and grading artifacts');

harness
  .command('env')
  .description('print the local harness environment report')
  .option('--milvus-docs <path>', 'optional local Milvus docs repository path')
  .option('--web-content-repo <path>', 'optional local web-content repository path')
  .option('--sdk-repo <path>', 'repeatable local SDK repository path', collectOption, [])
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: HarnessEnvCommandOptions) => {
    const report = await buildHarnessEnvironmentReport({
      envLoadReport,
      pathChecks: harnessPathChecks(opts)
    });
    printFormatted(report, opts.format);
  });

harness
  .command('tools')
  .description('print the allowed harness tool registry for a workflow')
  .requiredOption('--workflow <workflow>', 'workflow name; currently multisdk')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (opts: HarnessToolsCommandOptions) => {
    printFormatted(getHarnessTools(parseHarnessWorkflow(opts.workflow)), opts.format);
  });

harness
  .command('grade')
  .description('grade a task directory using workflow-specific harness rules')
  .argument('<task-dir>', 'task directory')
  .requiredOption('--workflow <workflow>', 'workflow name; currently multisdk')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (taskDir: string, opts: HarnessGradeCommandOptions) => {
    const workflow = parseHarnessWorkflow(opts.workflow);
    if (workflow !== 'multisdk') {
      throw new Error(`Unsupported harness workflow ${workflow}. Expected multisdk.`);
    }
    const environment = await buildHarnessEnvironmentReport({ envLoadReport });
    await writeHarnessEnvironment(taskDir, environment);
    const grade = await gradeMultisdkTask({ taskDir });
    await writeHarnessGradeArtifacts(taskDir, grade);
    printFormatted(grade, opts.format);
    if (grade.result === 'blocked') process.exitCode = 1;
  });
```

Add this helper near `parseCsv`:

```ts
function harnessPathChecks(opts: HarnessEnvCommandOptions): HarnessPathCheckInput[] {
  return [
    opts.milvusDocs ? { name: 'milvusDocs', path: opts.milvusDocs } : undefined,
    opts.webContentRepo ? { name: 'webContentRepo', path: opts.webContentRepo } : undefined,
    ...(opts.sdkRepo ?? []).map((path, index) => ({ name: `sdkRepo${index + 1}`, path }))
  ].filter((item): item is HarnessPathCheckInput => Boolean(item));
}
```

- [ ] **Step 5: Run the CLI tests and verify they pass**

Run:

```bash
npm test -- harness-cli
```

Expected: `packages/cli/test/harness-cli.test.ts` passes.

- [ ] **Step 6: Run a CLI help smoke check**

Run:

```bash
npm run build
node packages/cli/dist/cli/index.js harness --help
node packages/cli/dist/cli/index.js harness tools --workflow multisdk --format json
```

Expected: build passes, `harness --help` lists `env`, `tools`, and `grade`, and the tools command prints JSON with `kind: "feishu-harness-tools"`.

- [ ] **Step 7: Commit the CLI command group**

Run:

```bash
git add packages/cli/src/cli/index.ts packages/cli/test/harness-cli.test.ts
git commit -m "Add harness CLI commands"
```

Expected: commit succeeds.

---

### Task 7: Documentation And Agent Skill Updates

**Files:**
- Create: `apps/docs/guide/agent-harness.md`
- Modify: `apps/docs/.vitepress/config.ts`
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/guide/multisdk-workflow.md`
- Modify: `apps/docs/agent/skills/milvus-multisdk-example-sync.md`

- [ ] **Step 1: Create the harness guide**

Create `apps/docs/guide/agent-harness.md`:

```md
# Agent Harness

The harness layer makes agent work inspectable. It does not replace the existing workflow commands. It adds a shared contract for task input, environment, tools, trace, and grading.

## Model

- Task: durable workflow state, such as `runs/<doc-token>/task.json`.
- Environment: local runtime and credential presence, written as `environment.json`.
- Tools: the workflow command menu agents should use.
- Trace: append-only command events under `trace/events.jsonl`.
- Grader: deterministic pass, blocked, or incomplete output in `grade.json` and `grade.md`.

## Commands

Inspect the local environment:

```bash
md2feishu harness env --format json
```

Inspect the allowed multi-SDK tool surface:

```bash
md2feishu harness tools --workflow multisdk --format json
```

Grade a multi-SDK task:

```bash
md2feishu harness grade runs/<doc-token> --workflow multisdk --format json
```

`harness grade` exits non-zero only when the task is blocked. An incomplete task is a valid in-progress state and includes suggested next commands.

## Multi-SDK Artifacts

A harnessed multi-SDK task contains:

```text
runs/<doc-token>/
  task.json
  manifest.json
  snippets/
  evidence/
    evidence.json
    evidence.md
  trace/
    events.jsonl
  environment.json
  grade.json
  grade.md
  handoff.md
```

Keep `runs/` local unless a maintainer intentionally shares a run artifact.
```

- [ ] **Step 2: Add the guide to VitePress navigation**

Modify `apps/docs/.vitepress/config.ts` in the Guide sidebar. Insert this item after `Configuration`:

```ts
{ text: 'Agent Harness', link: '/guide/agent-harness' },
```

- [ ] **Step 3: Document harness commands in command reference**

Append this section after `doctor auth` in `apps/docs/reference/commands.md`:

```md
## `harness`

Inspect and grade workflow harness artifacts.

```bash
md2feishu harness env --format json
md2feishu harness tools --workflow multisdk --format json
md2feishu harness grade runs/<doc-token> --workflow multisdk --format json
```

`harness env` reports runtime, CLI package version, Feishu host, credential presence, dotenv loading, validation profiles, and optional path checks without printing secrets.

`harness tools` prints the allowed command surface for a workflow. V1 supports `multisdk`.

`harness grade` writes `environment.json`, `grade.json`, and `grade.md` under the task directory. It exits non-zero only for `blocked`; `incomplete` means the task is valid but still in progress.
```

- [ ] **Step 4: Update the multi-SDK workflow guide**

Modify `apps/docs/guide/multisdk-workflow.md` after the initialize command:

```md
Inspect the harness tool menu before starting agentic work:

```bash
md2feishu harness tools --workflow multisdk --format json
```
```

Modify the final section after `md2feishu multisdk finalize runs/<doc-token>`:

```md
Grade the task before handoff:

```bash
md2feishu harness grade runs/<doc-token> --workflow multisdk --format json
```

Review `grade.md`, `handoff.md`, and `trace/events.jsonl` together. `grade` returning `incomplete` is acceptable while a task is still in progress; `blocked` requires fixing the reported safety or audit failure.
```

- [ ] **Step 5: Update the multi-SDK agent skill page**

Modify `apps/docs/agent/skills/milvus-multisdk-example-sync.md`:

In the workflow list, insert this as the new step 2 and renumber the following steps:

```md
2. Inspect the harness tool menu with `md2feishu harness tools --workflow multisdk --format json`.
```

At the end of the workflow list, add:

```md
8. Run `md2feishu harness grade <task-dir> --workflow multisdk --format json` and review `grade.md` before handoff.
```

In the boundaries list, add:

```md
- Treat `trace/events.jsonl`, `grade.json`, and `grade.md` as the durable record of what the agent did and why the task passed, blocked, or remains incomplete.
```

- [ ] **Step 6: Build the docs**

Run:

```bash
npm run docs:build
```

Expected: VitePress build succeeds.

- [ ] **Step 7: Commit the docs**

Run:

```bash
git add apps/docs/guide/agent-harness.md apps/docs/.vitepress/config.ts apps/docs/reference/commands.md apps/docs/guide/multisdk-workflow.md apps/docs/agent/skills/milvus-multisdk-example-sync.md
git commit -m "Document agent harness workflow"
```

Expected: commit succeeds.

---

### Task 8: Final Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused harness tests**

Run:

```bash
npm test -- harness
```

Expected: all harness-related Vitest files pass.

- [ ] **Step 2: Run multi-SDK regression tests**

Run:

```bash
npm test -- multisdk
```

Expected: all multi-SDK Vitest files pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript passes without errors.

- [ ] **Step 4: Run full tests**

Run:

```bash
npm test
```

Expected: full Vitest suite passes.

- [ ] **Step 5: Run build**

Run:

```bash
npm run build
```

Expected: CLI package builds into `packages/cli/dist`.

- [ ] **Step 6: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: VitePress docs build succeeds.

- [ ] **Step 7: Smoke the built harness commands**

Run:

```bash
node packages/cli/dist/cli/index.js harness env --format json
node packages/cli/dist/cli/index.js harness tools --workflow multisdk --format json
node packages/cli/dist/cli/index.js harness --help
```

Expected: each command exits zero, `env` prints `kind: "feishu-harness-environment"`, `tools` prints `kind: "feishu-harness-tools"`, and help lists `env`, `tools`, and `grade`.

- [ ] **Step 8: Review git status**

Run:

```bash
git status --short
```

Expected: only intentional source, test, and docs files are modified after the final commits; generated `dist/` output is not committed.
