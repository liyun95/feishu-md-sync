# Multi-SDK Local-First Workflow Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the multi-SDK examples workflow around one user-selected language, real Milvus validation, local Markdown review, and explicit user approval before any Feishu push.

**Architecture:** Replace the current Feishu-direct code-block apply path with a local-first lane workflow. The CLI owns deterministic artifact generation, task state, Manta/local validation execution, local Markdown patching, and grading; Feishu writes happen through the existing `push` workflow only after the reviewed Markdown is produced and the user approves the push dry-run.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, existing Feishu pull/push/Markdown helpers, `manta-client` CLI for default live validation, local task artifacts under paths like `runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/`.

---

## Why This Replaces The Previous Plan

The previous plan optimized the current code-block workflow, but the intended product workflow is different:

1. The user chooses one target language, not all SDK lanes.
2. The agent prepares target-language examples and executable tests from the document's Python examples.
3. The workflow asks the user to confirm the Milvus validation target, because docs often target unreleased Milvus builds.
4. Validation defaults to `manta-client` and must run against a real Milvus instance.
5. Passing validation produces a local reviewed Markdown file.
6. The user reviews that Markdown and then explicitly confirms whether to push it to Feishu.

The existing implementation is Feishu-direct:

`init -> export snippets -> record evidence -> apply code blocks to Feishu -> audit Feishu`

This plan changes it to:

`init single language -> prepare local verifier -> configure Milvus target -> run Manta validation -> write local review Markdown -> push dry-run -> user-approved push write -> audit`

## Files

- Modify: `packages/cli/src/multisdk/task.ts`
  - Store one selected language, Milvus target, runner state, local review file, and push state.
- Modify: `packages/cli/src/multisdk/workflow.ts`
  - Change initialization to a single-language lane and add workflow functions for environment config, preparation, validation, local apply, push recording, and final audit.
- Create: `packages/cli/src/multisdk/environment.ts`
  - Parse and validate Milvus version/source target choices.
- Create: `packages/cli/src/multisdk/prepare.ts`
  - Build deterministic local verifier scaffolds from Python source blocks and selected language.
- Create: `packages/cli/src/multisdk/manta.ts`
  - Wrap `manta-client` job create/wait/log/artifact operations through injectable executors.
- Create: `packages/cli/src/multisdk/review-markdown.ts`
  - Patch selected-language snippets into pulled Markdown and write `outputs/review.md`.
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
  - Require `--language` at init and add `environment`, `prepare`, `validate`, `apply-local`, and `record-push` commands.
- Modify: `packages/cli/src/workflows/registry.ts`
  - Update the multi-SDK recipe so the first remote write is a reviewed `md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write`.
- Modify: `packages/cli/src/harness/tools.ts`
  - Replace Feishu-direct multisdk apply metadata with local-first commands.
- Modify: `packages/cli/src/harness/multisdk-grade.ts`
  - Grade one selected language and require local review plus push/audit state only for that language.
- Modify: `skills/feishu-multisdk-examples/SKILL.md`
  - Instruct the agent to ask for language and Milvus target before validation.
- Modify: `apps/docs/guide/multisdk-workflow.md`
  - Document the new local-first workflow.
- Test: `packages/cli/test/multisdk-task.test.ts`
- Test: `packages/cli/test/multisdk-workflow.test.ts`
- Test: `packages/cli/test/multisdk-environment.test.ts`
- Test: `packages/cli/test/multisdk-prepare.test.ts`
- Test: `packages/cli/test/multisdk-manta.test.ts`
- Test: `packages/cli/test/multisdk-review-markdown.test.ts`
- Test: `packages/cli/test/harness-multisdk-grade.test.ts`
- Test: `packages/cli/test/harness-tools.test.ts`

## Task 1: Make Multi-SDK Task State Single-Language

**Files:**
- Modify: `packages/cli/src/multisdk/task.ts`
- Modify: `packages/cli/test/multisdk-task.test.ts`

- [ ] **Step 1: Write the failing task model test**

In `packages/cli/test/multisdk-task.test.ts`, add this test:

```ts
it('creates a single-language local-first task', () => {
  const task = createInitialMultisdkTask({
    document: 'https://zilliverse.feishu.cn/wiki/doc',
    documentId: 'doc',
    taskDir: 'runs/doc-java',
    language: 'java'
  });

  expect(task.language).toBe('java');
  expect(task.languages).toEqual(['java']);
  expect(task.status).toBe('initialized');
  expect(task.milvusTarget).toBeNull();
  expect(task.localReview).toBeNull();
  expect(task.remotePush).toBeNull();
  expect(task.lane).toEqual(expect.objectContaining({
    language: 'java',
    prepared: false,
    validated: false,
    localApplied: false,
    remoteWritten: false,
    audited: false
  }));
});
```

- [ ] **Step 2: Run the targeted test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-task.test.ts
```

Expected: FAIL because `createInitialMultisdkTask` does not accept `language` and still creates four lane states.

- [ ] **Step 3: Replace the task types**

In `packages/cli/src/multisdk/task.ts`, replace the old multi-language task state with these exported types:

```ts
export type MultisdkTaskStatus =
  | 'initialized'
  | 'environment-ready'
  | 'prepared'
  | 'validated'
  | 'local-applied'
  | 'remote-dry-run'
  | 'remote-written'
  | 'audited'
  | 'blocked';

export type MultisdkMilvusTarget =
  | {
    kind: 'released-version';
    version: string;
    sourceRepo?: undefined;
    sourceRef?: undefined;
  }
  | {
    kind: 'source-build';
    version: string;
    sourceRepo: string;
    sourceRef: string;
  };

export type MultisdkValidationRunner = 'manta' | 'local';

export type MultisdkValidation = {
  runner: MultisdkValidationRunner;
  command: string;
  evidencePath: string;
  recordedAt: string;
  milvusTarget: MultisdkMilvusTarget;
  jobId?: string;
};

export type MultisdkLaneState = {
  language: MultisdkLanguage;
  prepared: boolean;
  validated: boolean;
  localApplied: boolean;
  remoteWritten: boolean;
  audited: boolean;
  evidence: MultisdkValidation[];
  reason?: string;
};

export type MultisdkLocalReview = {
  markdownPath: string;
  diffPath: string;
  generatedAt: string;
};

export type MultisdkRemotePush = {
  dryRunAt?: string;
  writeAt?: string;
  command?: string;
  resultPath?: string;
};

export type MultisdkTask = {
  kind: 'feishu-multisdk-task';
  version: 2;
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  languages: MultisdkLanguage[];
  status: MultisdkTaskStatus;
  milvusTarget: MultisdkMilvusTarget | null;
  runner: MultisdkValidationRunner;
  lane: MultisdkLaneState;
  localReview: MultisdkLocalReview | null;
  remotePush: MultisdkRemotePush | null;
  finalAuditPassed: boolean;
  cleanup: string[];
};
```

Update `createInitialMultisdkTask` to accept `language`:

```ts
export function createInitialMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
}): MultisdkTask {
  return {
    kind: 'feishu-multisdk-task',
    version: 2,
    document: input.document,
    documentId: input.documentId,
    taskDir: input.taskDir,
    language: input.language,
    languages: [input.language],
    status: 'initialized',
    milvusTarget: null,
    runner: 'manta',
    lane: {
      language: input.language,
      prepared: false,
      validated: false,
      localApplied: false,
      remoteWritten: false,
      audited: false,
      evidence: []
    },
    localReview: null,
    remotePush: null,
    finalAuditPassed: false,
    cleanup: []
  };
}
```

Update `summarizeMultisdkTask` so it returns:

```ts
export type MultisdkTaskSummary = {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  status: MultisdkTaskStatus;
  milvusTarget: MultisdkMilvusTarget | null;
  localReview: MultisdkLocalReview | null;
  finalAuditPassed: boolean;
};
```

- [ ] **Step 4: Run the task test**

Run:

```bash
npm test -- --run test/multisdk-task.test.ts
```

Expected: PASS after updating existing test fixtures to pass `language: 'java'`.

## Task 2: Require One Language At Initialization

**Files:**
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Modify: `packages/cli/test/multisdk-workflow.test.ts`

- [ ] **Step 1: Write the failing workflow test**

In `packages/cli/test/multisdk-workflow.test.ts`, replace the init test with:

```ts
it('initializes only the requested language lane', async () => {
  const dir = await tempDir();

  const result = await initMultisdkTask({
    document: 'doc-url',
    documentId: 'doc',
    taskDir: dir,
    language: 'java',
    inventory: inventory()
  });

  expect(result.task.language).toBe('java');
  expect(result.task.languages).toEqual(['java']);
  expect(result.task.status).toBe('initialized');
  expect(result.files.every((file) => file.includes('/java-'))).toBe(true);
  await expect(readFile(join(dir, 'snippets/java-01-create-a-collection.java'), 'utf8')).resolves.toBe('');
  await expect(readFile(join(dir, 'snippets/javascript-01-create-a-collection.js'), 'utf8')).rejects.toThrow(/ENOENT/);
});
```

- [ ] **Step 2: Run the targeted test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-workflow.test.ts
```

Expected: FAIL because `initMultisdkTask` does not accept `language` and exports all languages.

- [ ] **Step 3: Update init workflow**

In `packages/cli/src/multisdk/workflow.ts`, change `initMultisdkTask` input to:

```ts
export async function initMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }> {
```

Inside it, change export to one language:

```ts
const result = await exportCodeBlockSnippets({
  document: input.document,
  inventory: input.inventory,
  expectLanguages: [input.language],
  outDir: input.taskDir,
  manifestPath: join(input.taskDir, 'manifest.json')
});
const task = createInitialMultisdkTask(input);
```

Remove the loop that marks every `MULTISDK_LANGUAGES` lane as exported.

- [ ] **Step 4: Update CLI init**

In `packages/cli/src/cli/commands/multisdk.ts`, extend `MultisdkInitCommandOptions`:

```ts
type MultisdkInitCommandOptions = BaseCommandOptions & FormatCommandOptions & {
  out: string;
  language: string;
};
```

Add a required option to `multisdk init`:

```ts
.requiredOption('--language <language>', 'target language: java | javascript | node | nodejs | js | go | restful')
```

In the action, parse and pass the language:

```ts
const language = parseMultisdkLanguage(opts.language);
const result = await initMultisdkTask({
  document: feishuDoc,
  documentId,
  taskDir: opts.out,
  language,
  inventory: buildCodeBlockInventory(documentId, blocks)
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --run test/multisdk-workflow.test.ts test/multisdk-task.test.ts
```

Expected: PASS after updating all `createInitialMultisdkTask` calls in the test file to include `language: 'java'`.

## Task 3: Add Milvus Target Configuration

**Files:**
- Create: `packages/cli/src/multisdk/environment.ts`
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Create: `packages/cli/test/multisdk-environment.test.ts`
- Modify: `packages/cli/test/multisdk-workflow.test.ts`

- [ ] **Step 1: Write environment parser tests**

Create `packages/cli/test/multisdk-environment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseMilvusTarget } from '../src/multisdk/environment.js';

describe('multisdk environment target', () => {
  it('parses a released Milvus version target', () => {
    expect(parseMilvusTarget({ milvusVersion: '2.6.0' })).toEqual({
      kind: 'released-version',
      version: '2.6.0'
    });
  });

  it('parses an unreleased source build target', () => {
    expect(parseMilvusTarget({
      milvusVersion: '2.7.0-dev',
      milvusSourceRepo: 'https://github.com/milvus-io/milvus.git',
      milvusSourceRef: 'feature/json-index'
    })).toEqual({
      kind: 'source-build',
      version: '2.7.0-dev',
      sourceRepo: 'https://github.com/milvus-io/milvus.git',
      sourceRef: 'feature/json-index'
    });
  });

  it('rejects source repo without a source ref', () => {
    expect(() => parseMilvusTarget({
      milvusVersion: '2.7.0-dev',
      milvusSourceRepo: 'https://github.com/milvus-io/milvus.git'
    })).toThrow(/--milvus-source-ref/);
  });
});
```

- [ ] **Step 2: Run the parser test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-environment.test.ts
```

Expected: FAIL because `environment.ts` does not exist.

- [ ] **Step 3: Implement target parser**

Create `packages/cli/src/multisdk/environment.ts`:

```ts
import type { MultisdkMilvusTarget } from './task.js';

export type ParseMilvusTargetInput = {
  milvusVersion?: string;
  milvusSourceRepo?: string;
  milvusSourceRef?: string;
};

export function parseMilvusTarget(input: ParseMilvusTargetInput): MultisdkMilvusTarget {
  const version = input.milvusVersion?.trim();
  if (!version) {
    throw new Error('Milvus target requires --milvus-version. Ask the user which released or source-built Milvus version this document targets.');
  }

  const sourceRepo = input.milvusSourceRepo?.trim();
  const sourceRef = input.milvusSourceRef?.trim();
  if (sourceRepo || sourceRef) {
    if (!sourceRepo) throw new Error('Milvus source build target requires --milvus-source-repo.');
    if (!sourceRef) throw new Error('Milvus source build target requires --milvus-source-ref.');
    return {
      kind: 'source-build',
      version,
      sourceRepo,
      sourceRef
    };
  }

  return {
    kind: 'released-version',
    version
  };
}
```

- [ ] **Step 4: Add workflow state update**

In `packages/cli/src/multisdk/workflow.ts`, add:

```ts
export async function configureMultisdkEnvironment(input: {
  taskDir: string;
  milvusTarget: MultisdkMilvusTarget;
  runner?: MultisdkValidationRunner;
}): Promise<MultisdkTask> {
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
    startedAt: new Date().toISOString(),
    arguments: {
      language: task.language,
      runner: updated.runner,
      milvusTarget: updated.milvusTarget
    },
    artifactPaths: ['task.json'],
    summary: `Configured ${task.language} Milvus validation target.`
  });
  return updated;
}
```

- [ ] **Step 5: Add CLI command**

In `packages/cli/src/cli/commands/multisdk.ts`, import `parseMilvusTarget` and `configureMultisdkEnvironment`.

Add options type:

```ts
type MultisdkEnvironmentCommandOptions = FormatCommandOptions & {
  milvusVersion?: string;
  milvusSourceRepo?: string;
  milvusSourceRef?: string;
  runner?: string;
};
```

Add command:

```ts
multisdk
  .command('environment')
  .description('record the Milvus target and validation runner for a multi-SDK task')
  .argument('<task-dir>', 'multi-SDK task directory')
  .requiredOption('--milvus-version <version>', 'Milvus version the examples must validate against')
  .option('--milvus-source-repo <repo>', 'Milvus source repository for unreleased validation builds')
  .option('--milvus-source-ref <ref>', 'Milvus source branch, tag, or commit for unreleased validation builds')
  .option('--runner <runner>', 'validation runner: manta | local', 'manta')
  .option('--format <format>', 'output format: pretty | json', 'pretty')
  .action(async (taskDir: string, opts: MultisdkEnvironmentCommandOptions) => {
    const runner = parseValidationRunner(opts.runner);
    const task = await configureMultisdkEnvironment({
      taskDir,
      runner,
      milvusTarget: parseMilvusTarget(opts)
    });
    printFormatted(summarizeMultisdkTask(task), opts.format);
  });
```

Add helper:

```ts
function parseValidationRunner(value: string | undefined): 'manta' | 'local' {
  if (value === undefined || value === 'manta') return 'manta';
  if (value === 'local') return 'local';
  throw new Error(`Invalid --runner ${value}. Expected manta or local.`);
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- --run test/multisdk-environment.test.ts test/multisdk-workflow.test.ts
```

Expected: PASS after adding a workflow test that calls `configureMultisdkEnvironment` and asserts `status: 'environment-ready'`.

## Task 4: Prepare Language Verifier Artifacts From Python Blocks

**Files:**
- Create: `packages/cli/src/multisdk/prepare.ts`
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Create: `packages/cli/test/multisdk-prepare.test.ts`

- [ ] **Step 1: Write prepare tests**

Create `packages/cli/test/multisdk-prepare.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareMultisdkVerifier } from '../src/multisdk/prepare.js';

const tempDirs: string[] = [];

describe('multisdk prepare', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('writes python context, selected snippets, and a Java verifier scaffold', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'remote.md'), [
      '# Index docs',
      '',
      '```python',
      'client.create_index(collection_name="books", index_params=index_params)',
      '```',
      ''
    ].join('\n'), 'utf8');
    await writeFile(join(dir, 'java-01-create-index.java'), 'client.createIndex(request);', 'utf8');

    const result = await prepareMultisdkVerifier({
      taskDir: dir,
      language: 'java',
      remoteMarkdownPath: join(dir, 'remote.md'),
      snippetPaths: [join(dir, 'java-01-create-index.java')],
      milvusVersion: '2.6.0'
    });

    expect(result.files.map((file) => file.replace(`${dir}/`, ''))).toEqual([
      'work/java/python-context.md',
      'work/java/snippets/java-01-create-index.java',
      'work/java/verify/README.md',
      'work/java/verify/pom.xml',
      'work/java/verify/src/test/java/io/milvus/docs/MultisdkExamplesTest.java'
    ]);
    await expect(readFile(join(dir, 'work/java/python-context.md'), 'utf8')).resolves.toContain('client.create_index');
    await expect(readFile(join(dir, 'work/java/verify/README.md'), 'utf8')).resolves.toContain('Milvus target: 2.6.0');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-prepare-'));
  tempDirs.push(dir);
  return dir;
}
```

- [ ] **Step 2: Run prepare test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-prepare.test.ts
```

Expected: FAIL because `prepare.ts` does not exist.

- [ ] **Step 3: Implement deterministic prepare scaffolding**

Create `packages/cli/src/multisdk/prepare.ts` with:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MultisdkLanguage } from './language.js';

export type PrepareMultisdkVerifierInput = {
  taskDir: string;
  language: MultisdkLanguage;
  remoteMarkdownPath: string;
  snippetPaths: string[];
  milvusVersion: string;
};

export type PrepareMultisdkVerifierResult = {
  files: string[];
  command: string;
};

export async function prepareMultisdkVerifier(
  input: PrepareMultisdkVerifierInput
): Promise<PrepareMultisdkVerifierResult> {
  const workDir = join(input.taskDir, 'work', input.language);
  const snippetDir = join(workDir, 'snippets');
  const verifyDir = join(workDir, 'verify');
  await mkdir(snippetDir, { recursive: true });
  await mkdir(verifyDir, { recursive: true });

  const remoteMarkdown = await readFile(input.remoteMarkdownPath, 'utf8');
  const pythonContextPath = join(workDir, 'python-context.md');
  const snippetFiles: string[] = [];

  await writeFile(pythonContextPath, renderPythonContext(remoteMarkdown), 'utf8');
  for (const snippetPath of input.snippetPaths) {
    const target = join(snippetDir, basename(snippetPath));
    await writeFile(target, await readFile(snippetPath, 'utf8'), 'utf8');
    snippetFiles.push(target);
  }

  const scaffold = verifierScaffold(input.language, input.milvusVersion);
  const files = [pythonContextPath, ...snippetFiles];
  for (const file of scaffold.files) {
    const target = join(verifyDir, file.path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    files.push(target);
  }

  return {
    files,
    command: scaffold.command
  };
}

function renderPythonContext(markdown: string): string {
  const blocks = Array.from(markdown.matchAll(/```python\n([\s\S]*?)```/g)).map((match, index) => {
    return `## Python block ${index + 1}\n\n\`\`\`python\n${match[1]?.trim() ?? ''}\n\`\`\``;
  });
  return `${blocks.join('\n\n')}\n`;
}

function verifierScaffold(language: MultisdkLanguage, milvusVersion: string): {
  command: string;
  files: Array<{ path: string; content: string }>;
} {
  if (language === 'java') {
    return {
      command: 'mvn test',
      files: [
        {
          path: 'README.md',
          content: `# Java multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n\nCopy reviewed Java snippets into the test and assert every SDK response succeeds.\n`
        },
        {
          path: 'pom.xml',
          content: '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>io.milvus.docs</groupId><artifactId>multisdk-verify</artifactId><version>1.0.0</version></project>\n'
        },
        {
          path: 'src/test/java/io/milvus/docs/MultisdkExamplesTest.java',
          content: 'package io.milvus.docs;\n\nclass MultisdkExamplesTest {\n}\n'
        }
      ]
    };
  }
  if (language === 'javascript') {
    return {
      command: 'npm test',
      files: [
        { path: 'README.md', content: `# JavaScript multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
        { path: 'package.json', content: '{ "type": "module", "scripts": { "test": "node test.mjs" } }\n' },
        { path: 'test.mjs', content: 'console.log("replace with live Milvus assertions");\n' }
      ]
    };
  }
  if (language === 'go') {
    return {
      command: 'go test ./...',
      files: [
        { path: 'README.md', content: `# Go multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
        { path: 'go.mod', content: 'module multisdkverify\n\ngo 1.22\n' },
        { path: 'multisdk_examples_test.go', content: 'package multisdkverify\n\nimport "testing"\n\nfunc TestMultisdkExamples(t *testing.T) {}\n' }
      ]
    };
  }
  return {
    command: 'bash test-rest.sh',
    files: [
      { path: 'README.md', content: `# REST multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
      { path: 'test-rest.sh', content: '#!/usr/bin/env bash\nset -euo pipefail\n: "${MILVUS_ENDPOINT:?MILVUS_ENDPOINT is required}"\n' }
    ]
  };
}
```

- [ ] **Step 4: Add workflow and CLI prepare command**

In `packages/cli/src/multisdk/workflow.ts`, add `prepareMultisdkTask` that:

```ts
export async function prepareMultisdkTask(input: {
  taskDir: string;
  remoteMarkdownPath: string;
  snippetPaths: string[];
}): Promise<{ task: MultisdkTask; files: string[]; command: string }> {
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
  const updated = {
    ...task,
    status: 'prepared' as const,
    lane: { ...task.lane, prepared: true }
  };
  await saveMultisdkTask(updated);
  return { task: updated, files: prepared.files, command: prepared.command };
}
```

In the CLI, add `multisdk prepare runs/doc-java --remote-markdown runs/doc-java/inputs/remote.md --snippet snippets/java-01-create-index.java`. Allow repeated snippet files by using Commander `.option('--snippet <file...>', 'snippet files to include in the verifier')`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --run test/multisdk-prepare.test.ts test/multisdk-workflow.test.ts
```

Expected: PASS.

## Task 5: Add Manta Validation Runner

**Files:**
- Create: `packages/cli/src/multisdk/manta.ts`
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Create: `packages/cli/test/multisdk-manta.test.ts`
- Modify: `packages/cli/test/multisdk-workflow.test.ts`

- [ ] **Step 1: Write Manta wrapper tests**

Create `packages/cli/test/multisdk-manta.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { runMantaValidation } from '../src/multisdk/manta.js';

describe('multisdk manta validation', () => {
  it('creates a job, waits for completion, and records logs', async () => {
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args.includes('create')) return { stdout: 'job-123\n', stderr: '' };
      if (args.includes('wait')) return { stdout: '', stderr: '' };
      if (args.includes('logs')) return { stdout: 'PASS live Milvus validation\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runMantaValidation({
      taskDir: 'runs/doc-java',
      language: 'java',
      command: 'mvn test',
      milvusTarget: { kind: 'released-version', version: '2.6.0' },
      exec
    });

    expect(result.jobId).toBe('job-123');
    expect(result.logs).toContain('PASS live Milvus validation');
    expect(exec.mock.calls.map((call) => call[1].slice(0, 3))).toEqual([
      ['-q', 'job', 'create'],
      ['-q', 'job', 'wait'],
      ['job', 'logs', 'job-123']
    ]);
  });
});
```

- [ ] **Step 2: Run the Manta test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-manta.test.ts
```

Expected: FAIL because `manta.ts` does not exist.

- [ ] **Step 3: Implement Manta wrapper**

Create `packages/cli/src/multisdk/manta.ts`:

```ts
import type { MultisdkLanguage } from './language.js';
import type { MultisdkMilvusTarget } from './task.js';

export type MantaExec = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

export type RunMantaValidationInput = {
  taskDir: string;
  language: MultisdkLanguage;
  command: string;
  milvusTarget: MultisdkMilvusTarget;
  exec: MantaExec;
};

export type RunMantaValidationResult = {
  jobId: string;
  logs: string;
};

export async function runMantaValidation(input: RunMantaValidationInput): Promise<RunMantaValidationResult> {
  const prompt = [
    `Run multi-SDK ${input.language} validation.`,
    `Task directory: ${input.taskDir}`,
    `Milvus target: ${renderMilvusTarget(input.milvusTarget)}`,
    `Validation command: ${input.command}`,
    'Start a real Milvus instance, run the verifier command, and make the logs show every example passed.'
  ].join('\n');

  const created = await input.exec('manta-client', ['-q', 'job', 'create', '-p', prompt, '-T', '1800']);
  const jobId = created.stdout.trim();
  if (!jobId) throw new Error('manta-client did not return a job id.');

  await input.exec('manta-client', ['-q', 'job', 'wait', jobId, '--timeout', '1800']);
  const logs = await input.exec('manta-client', ['job', 'logs', jobId]);
  return { jobId, logs: logs.stdout };
}

function renderMilvusTarget(target: MultisdkMilvusTarget): string {
  if (target.kind === 'released-version') return target.version;
  return `${target.version} from ${target.sourceRepo}@${target.sourceRef}`;
}
```

- [ ] **Step 4: Add validate workflow function**

In `packages/cli/src/multisdk/workflow.ts`, add `validateMultisdkTask`:

```ts
export async function validateMultisdkTask(input: {
  taskDir: string;
  command: string;
  evidencePath: string;
  runner?: MultisdkValidationRunner;
  jobId?: string;
}): Promise<MultisdkTask> {
  const task = await loadMultisdkTask(input.taskDir);
  if (!task.milvusTarget) throw new Error('multisdk validate requires a configured Milvus target.');
  if (!task.lane.prepared) throw new Error('multisdk validate requires prepared verifier artifacts.');
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
  return updated;
}
```

- [ ] **Step 5: Add CLI validate command**

In `packages/cli/src/cli/commands/multisdk.ts`, add a `validate` command that supports:

```bash
md2feishu multisdk validate runs/doc-java --command "mvn test" --evidence runs/doc-java/evidence/java-live.log --job-id job-123
```

Use the local evidence-recording path first. In the same command, when `--runner manta` is passed without `--evidence`, call `runMantaValidation`, write logs to paths like `runs/doc-java/evidence/manta-job-123.log`, and then call `validateMultisdkTask`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm test -- --run test/multisdk-manta.test.ts test/multisdk-workflow.test.ts
```

Expected: PASS.

## Task 6: Generate Local Review Markdown Before Remote Push

**Files:**
- Create: `packages/cli/src/multisdk/review-markdown.ts`
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Create: `packages/cli/test/multisdk-review-markdown.test.ts`

- [ ] **Step 1: Write review Markdown test**

Create `packages/cli/test/multisdk-review-markdown.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeMultisdkReviewMarkdown } from '../src/multisdk/review-markdown.js';

const tempDirs: string[] = [];

describe('multisdk review markdown', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('inserts selected language code after each Python block in local markdown', async () => {
    const dir = await tempDir();
    const remote = join(dir, 'inputs/remote.md');
    const snippet = join(dir, 'snippets/java-01-create-index.java');
    await writeFile(remote, '# Docs\n\n```python\nclient.create_index()\n```\n', 'utf8');
    await writeFile(snippet, 'client.createIndex(request);', 'utf8');

    const result = await writeMultisdkReviewMarkdown({
      taskDir: dir,
      language: 'java',
      remoteMarkdownPath: remote,
      snippetPaths: [snippet]
    });

    await expect(readFile(result.markdownPath, 'utf8')).resolves.toBe('# Docs\n\n```python\nclient.create_index()\n```\n\n```java\nclient.createIndex(request);\n```\n');
    await expect(readFile(result.diffPath, 'utf8')).resolves.toContain('```java');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-review-'));
  tempDirs.push(dir);
  return dir;
}
```

- [ ] **Step 2: Run the review test and confirm failure**

Run:

```bash
npm test -- --run test/multisdk-review-markdown.test.ts
```

Expected: FAIL because `review-markdown.ts` does not exist.

- [ ] **Step 3: Implement local review writer**

Create `packages/cli/src/multisdk/review-markdown.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unifiedDiff } from '../sync/diff.js';
import type { MultisdkLanguage } from './language.js';

export type WriteMultisdkReviewMarkdownInput = {
  taskDir: string;
  language: MultisdkLanguage;
  remoteMarkdownPath: string;
  snippetPaths: string[];
};

export type WriteMultisdkReviewMarkdownResult = {
  markdownPath: string;
  diffPath: string;
};

export async function writeMultisdkReviewMarkdown(
  input: WriteMultisdkReviewMarkdownInput
): Promise<WriteMultisdkReviewMarkdownResult> {
  const remoteMarkdown = await readFile(input.remoteMarkdownPath, 'utf8');
  const snippets = await Promise.all(input.snippetPaths.map((path) => readFile(path, 'utf8')));
  const desired = insertLanguageBlocks(remoteMarkdown, input.language, snippets);
  const markdownPath = join(input.taskDir, 'outputs', 'review.md');
  const diffPath = join(input.taskDir, 'outputs', 'review.diff');
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, desired, 'utf8');
  await writeFile(diffPath, unifiedDiff('remote.md', 'review.md', remoteMarkdown, desired), 'utf8');
  return { markdownPath, diffPath };
}

function insertLanguageBlocks(markdown: string, language: MultisdkLanguage, snippets: string[]): string {
  let index = 0;
  return markdown.replace(/(```python\n[\s\S]*?```\n?)/g, (match) => {
    const snippet = snippets[index++];
    if (snippet === undefined) return match;
    return `${match.replace(/\n?$/, '\n')}\n\`\`\`${fenceLanguage(language)}\n${snippet.trim()}\n\`\`\`\n`;
  });
}

function fenceLanguage(language: MultisdkLanguage): string {
  return language === 'restful' ? 'bash' : language;
}
```

- [ ] **Step 4: Add workflow and CLI command**

In `packages/cli/src/multisdk/workflow.ts`, add `applyMultisdkLocalReview` that refuses unless `task.lane.validated` is true, calls `writeMultisdkReviewMarkdown`, stores `task.localReview`, sets `status: 'local-applied'`, and sets `lane.localApplied: true`.

In `packages/cli/src/cli/commands/multisdk.ts`, add:

```bash
md2feishu multisdk apply-local runs/doc-java --remote-markdown runs/doc-java/inputs/remote.md --snippet runs/doc-java/snippets/java-01-create-index.java
```

Use repeated `--snippet <file...>`.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --run test/multisdk-review-markdown.test.ts test/multisdk-workflow.test.ts
```

Expected: PASS.

## Task 7: Replace Remote Write With Existing Push Workflow

**Files:**
- Modify: `packages/cli/src/multisdk/workflow.ts`
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Modify: `packages/cli/src/harness/multisdk-grade.ts`
- Modify: `packages/cli/test/harness-multisdk-grade.test.ts`

- [ ] **Step 1: Write grade tests for local-first completion**

In `packages/cli/test/harness-multisdk-grade.test.ts`, replace the completed fixture with a single-language task:

```ts
it('passes a single-language task after local review, remote push, and audit', async () => {
  const dir = await tempDir();
  const task = createInitialMultisdkTask({
    document: 'doc-url',
    documentId: 'doc',
    taskDir: dir,
    language: 'java'
  });
  await saveMultisdkTask({
    ...task,
    status: 'audited',
    milvusTarget: { kind: 'released-version', version: '2.6.0' },
    lane: {
      ...task.lane,
      prepared: true,
      validated: true,
      localApplied: true,
      remoteWritten: true,
      audited: true,
      evidence: [{
        runner: 'manta',
        command: 'mvn test',
        evidencePath: 'evidence/manta-job-123.log',
        recordedAt: '2026-05-31T00:00:00.000Z',
        milvusTarget: { kind: 'released-version', version: '2.6.0' },
        jobId: 'job-123'
      }]
    },
    localReview: {
      markdownPath: 'outputs/review.md',
      diffPath: 'outputs/review.diff',
      generatedAt: '2026-05-31T00:00:00.000Z'
    },
    remotePush: {
      dryRunAt: '2026-05-31T00:01:00.000Z',
      writeAt: '2026-05-31T00:02:00.000Z',
      command: 'md2feishu push outputs/review.md doc-url --write -y',
      resultPath: 'outputs/push-result.json'
    },
    finalAuditPassed: true
  });

  const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:03:00.000Z' });

  expect(grade.result).toBe('passed');
  expect(grade.nextCommands).toEqual([]);
});
```

Add a second test:

```ts
it('suggests push dry-run after local review is generated', async () => {
  const dir = await tempDir();
  const task = createInitialMultisdkTask({
    document: 'doc-url',
    documentId: 'doc',
    taskDir: dir,
    language: 'java'
  });
  await saveMultisdkTask({
    ...task,
    status: 'local-applied',
    milvusTarget: { kind: 'released-version', version: '2.6.0' },
    lane: {
      ...task.lane,
      prepared: true,
      validated: true,
      localApplied: true,
      evidence: [{
        runner: 'manta',
        command: 'mvn test',
        evidencePath: 'evidence/manta-job-123.log',
        recordedAt: '2026-05-31T00:00:00.000Z',
        milvusTarget: { kind: 'released-version', version: '2.6.0' },
        jobId: 'job-123'
      }]
    },
    localReview: {
      markdownPath: 'outputs/review.md',
      diffPath: 'outputs/review.diff',
      generatedAt: '2026-05-31T00:00:00.000Z'
    }
  });

  const grade = await gradeMultisdkTask({ taskDir: dir, now: () => '2026-05-31T00:03:00.000Z' });

  expect(grade.result).toBe('incomplete');
  expect(grade.nextCommands).toContain('md2feishu push outputs/review.md doc-url');
});
```

- [ ] **Step 2: Run grade tests and confirm failure**

Run:

```bash
npm test -- --run test/harness-multisdk-grade.test.ts
```

Expected: FAIL because grader still loops over all languages and expects `multisdk apply --write`.

- [ ] **Step 3: Rewrite grade logic**

In `packages/cli/src/harness/multisdk-grade.ts`, make `gradeLanguage` inspect `task.lane` only. The checks must be:

```ts
if (!task.milvusTarget) nextCommands.push(`Ask the user to confirm the Milvus target, then run: md2feishu multisdk environment ${task.taskDir} --milvus-version 2.6.0`);
if (!task.lane.prepared) nextCommands.push(`md2feishu multisdk prepare ${task.taskDir} --remote-markdown ${task.taskDir}/inputs/remote.md --snippet ${task.taskDir}/snippets/${task.language}-01.java`);
if (!task.lane.validated) nextCommands.push(`md2feishu multisdk validate ${task.taskDir} --runner manta --command "mvn test"`);
if (!task.localReview) nextCommands.push(`md2feishu multisdk apply-local ${task.taskDir} --remote-markdown ${task.taskDir}/inputs/remote.md --snippet ${task.taskDir}/snippets/java-01-create-index.java`);
if (!task.remotePush?.dryRunAt) nextCommands.push(`md2feishu push ${task.localReview.markdownPath} ${task.document}`);
if (!task.remotePush?.writeAt) nextCommands.push(`md2feishu push ${task.localReview.markdownPath} ${task.document} --write -y`);
if (!task.lane.audited) nextCommands.push(`md2feishu multisdk audit ${task.taskDir}`);
```

Use concrete strings where available from `task.localReview.markdownPath`.

- [ ] **Step 4: Add push recording command**

In `packages/cli/src/multisdk/workflow.ts`, add:

```ts
export async function recordMultisdkPush(input: {
  taskDir: string;
  mode: 'dry-run' | 'write';
  command: string;
  resultPath?: string;
}): Promise<MultisdkTask> {
  const task = await loadMultisdkTask(input.taskDir);
  const remotePush = {
    ...(task.remotePush ?? {}),
    command: input.command,
    resultPath: input.resultPath,
    ...(input.mode === 'dry-run'
      ? { dryRunAt: new Date().toISOString() }
      : { writeAt: new Date().toISOString() })
  };
  const updated = {
    ...task,
    status: input.mode === 'write' ? 'remote-written' as const : 'remote-dry-run' as const,
    lane: {
      ...task.lane,
      remoteWritten: input.mode === 'write' ? true : task.lane.remoteWritten
    },
    remotePush
  };
  await saveMultisdkTask(updated);
  return updated;
}
```

In the CLI, add:

```bash
md2feishu multisdk record-push runs/doc-java --mode dry-run --command "md2feishu push runs/doc-java/outputs/review.md doc-url"
md2feishu multisdk record-push runs/doc-java --mode write --command "md2feishu push runs/doc-java/outputs/review.md doc-url --write -y" --result outputs/push-result.json
```

- [ ] **Step 5: Run grade tests**

Run:

```bash
npm test -- --run test/harness-multisdk-grade.test.ts
```

Expected: PASS.

## Task 8: Update Workflow Registry, Harness Tools, Skill, And Docs

**Files:**
- Modify: `packages/cli/src/workflows/registry.ts`
- Modify: `packages/cli/src/harness/tools.ts`
- Modify: `packages/cli/test/harness-tools.test.ts`
- Modify: `skills/feishu-multisdk-examples/SKILL.md`
- Modify: `apps/docs/guide/multisdk-workflow.md`

- [ ] **Step 1: Update harness tools test**

In `packages/cli/test/harness-tools.test.ts`, update expected multisdk tools to:

```ts
expect(registry.tools.map((tool) => tool.name)).toEqual([
  'multisdk init',
  'multisdk status',
  'multisdk environment',
  'multisdk prepare',
  'multisdk validate',
  'multisdk apply-local',
  'multisdk record-push',
  'multisdk audit',
  'multisdk finalize',
  'doctor auth',
  'pull',
  'push'
]);
expect(registry.tools.find((tool) => tool.name === 'multisdk init')).toEqual(expect.objectContaining({
  requires: ['feishuDoc', '--out', '--language']
}));
expect(registry.tools.find((tool) => tool.name === 'multisdk validate')).toEqual(expect.objectContaining({
  writesFeishu: false,
  writeRequires: ['confirmed Milvus target', 'prepared verifier', 'real Milvus execution']
}));
expect(registry.tools.find((tool) => tool.name === 'push')).toEqual(expect.objectContaining({
  writesFeishu: true,
  writeRequires: ['local review markdown', 'user approval', '--write']
}));
```

- [ ] **Step 2: Run harness tools test and confirm failure**

Run:

```bash
npm test -- --run test/harness-tools.test.ts
```

Expected: FAIL because tool metadata still lists `multisdk export`, `diff`, `apply`, and `land-docs` as the main path.

- [ ] **Step 3: Update registry and tools**

In `packages/cli/src/workflows/registry.ts`, replace the `multisdk-examples` recipe steps with:

```ts
steps: [
  { id: 'init', purpose: 'Create a single-language task from the Feishu document.', command: 'md2feishu multisdk init https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --out runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --language java', writes: 'local', verifies: 'task.json, manifest.json, snippets, and environment.json exist for one language.' },
  { id: 'confirm-environment', purpose: 'Record the Milvus version or source ref confirmed by the user.', command: 'md2feishu multisdk environment runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --milvus-version 2.6.0', writes: 'local', verifies: 'task.json contains a Milvus target.' },
  { id: 'prepare', purpose: 'Create verifier artifacts from Python context and selected-language snippets.', command: 'md2feishu multisdk prepare runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java', writes: 'local', verifies: 'work/java/ contains python context, snippets, and verifier scaffold.' },
  { id: 'validate', purpose: 'Run examples against real Milvus, defaulting to Manta.', command: 'md2feishu multisdk validate runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --runner manta --command "mvn test"', writes: 'local', verifies: 'evidence contains a completed Manta or local live validation log.' },
  { id: 'apply-local', purpose: 'Write reviewed examples into local Markdown only.', command: 'md2feishu multisdk apply-local runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java', writes: 'local', verifies: 'outputs/review.md and outputs/review.diff exist.' },
  { id: 'push-dry-run', purpose: 'Show the Feishu push plan for the reviewed Markdown.', command: 'md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf', writes: 'none', verifies: 'The user reviews the push dry-run plan.' },
  { id: 'push-write', purpose: 'Push reviewed Markdown to Feishu after user approval.', command: 'md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y', writes: 'feishu', verifies: 'Push readback verification passes.' },
  { id: 'record-push', purpose: 'Record the push result in the multi-SDK task.', command: 'md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode write --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y"', writes: 'local', verifies: 'task.json records remote write state.' },
  { id: 'audit', purpose: 'Audit the selected language after push.', command: 'md2feishu multisdk audit runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java', writes: 'local', verifies: 'Selected language is audited.' },
  { id: 'grade', purpose: 'Summarize the single-language task.', command: 'md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk', writes: 'local', verifies: 'Result is passed or nextCommands explains remaining work.' }
]
```

In `packages/cli/src/harness/tools.ts`, align `MULTISDK_TOOLS` with the same command surface.

- [ ] **Step 4: Update skill**

Replace the Safety Rules in `skills/feishu-multisdk-examples/SKILL.md` with:

```md
- Ask the user for exactly one target language before initializing. Do not default to all languages.
- Ask the user which Milvus target to validate against before preparing validation. If the docs target an unreleased build, ask for the source repo and branch/tag/commit.
- Default validation runner is `manta-client`. Use local validation only when the user explicitly asks or Manta is unavailable.
- Do not push to Feishu from the multi-SDK apply step. First write `outputs/review.md` locally and show the user the diff.
- Push to Feishu only through a reviewed command such as `md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf` after user approval.
- Finish with `md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk`.
```

- [ ] **Step 5: Update docs**

In `apps/docs/guide/multisdk-workflow.md`, replace the current workflow section with:

```md
## Local-first workflow

Multi-SDK examples are completed one language at a time.

1. Choose one target language.
2. Confirm the Milvus validation target with the user.
3. Prepare verifier artifacts from the Python examples.
4. Run the verifier against real Milvus, defaulting to `manta-client`.
5. Write the reviewed examples to local Markdown.
6. Review the local diff.
7. Push the reviewed Markdown to Feishu only after approval.

```bash
md2feishu multisdk init 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf' --out runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --language java
md2feishu multisdk environment runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --milvus-version 2.6.0
md2feishu multisdk prepare runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java
md2feishu multisdk validate runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --runner manta --command "mvn test"
md2feishu multisdk apply-local runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --remote-markdown runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/inputs/remote.md --snippet runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/snippets/java-01-create-index.java
md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf'
md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf' --write -y
md2feishu multisdk record-push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --mode write --command "md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y"
md2feishu multisdk audit runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java
md2feishu harness grade runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java --workflow multisdk
```
```

- [ ] **Step 6: Run docs and harness tests**

Run:

```bash
npm test -- --run test/harness-tools.test.ts
npm run docs:build
```

Expected: PASS.

## Task 9: Remove Feishu-Direct Multi-SDK Apply From The Happy Path

**Files:**
- Modify: `packages/cli/src/cli/commands/multisdk.ts`
- Modify: `packages/cli/src/harness/tools.ts`
- Modify: `packages/cli/src/workflows/registry.ts`
- Modify: `packages/cli/test/multisdk-workflow.test.ts`

- [ ] **Step 1: Decide command compatibility**

Keep the old `multisdk apply`, `diff`, and `land-docs` commands for one release as hidden compatibility commands, but remove them from workflow and harness tools. In Commander, mark them hidden:

```ts
.hideHelp()
```

Add this text to their descriptions:

```ts
.description('legacy Feishu-direct code-block operation; prefer multisdk apply-local plus md2feishu push')
```

- [ ] **Step 2: Add regression test**

In `packages/cli/test/harness-tools.test.ts`, assert:

```ts
expect(registry.tools.map((tool) => tool.name)).not.toContain('multisdk apply');
expect(registry.tools.map((tool) => tool.name)).not.toContain('multisdk land-docs');
```

- [ ] **Step 3: Run tests**

Run:

```bash
npm test -- --run test/harness-tools.test.ts test/multisdk-workflow.test.ts
```

Expected: PASS.

## Task 10: Full Verification

**Files:**
- No additional edits.

- [ ] **Step 1: Run focused multi-SDK tests**

Run:

```bash
npm test -- --run test/multisdk-task.test.ts test/multisdk-workflow.test.ts test/multisdk-environment.test.ts test/multisdk-prepare.test.ts test/multisdk-manta.test.ts test/multisdk-review-markdown.test.ts test/harness-multisdk-grade.test.ts test/harness-tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: PASS.

## Acceptance Criteria

- `md2feishu workflow show multisdk-examples --format json` shows a one-language local-first workflow.
- `md2feishu multisdk init` requires `--language`.
- A task tracks only one language lane.
- The workflow blocks preparation until a Milvus target is recorded.
- The default validation runner is `manta`.
- Validation evidence records the Milvus target and Manta job id when Manta is used.
- `multisdk apply-local` writes `outputs/review.md` and `outputs/review.diff`; it does not write Feishu.
- Remote writes are done through `md2feishu push runs/ZxQkwC3r6iy3s5kSdgwc2J2nnTf-java/outputs/review.md https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf --write -y`.
- `harness grade` passes for one audited language and no longer requires Java, JavaScript, Go, and REST all to finish.
- The skill and docs instruct agents to ask the user for target language and Milvus target before running validation.

## Commit Plan

- Commit 1: `refactor: make multisdk tasks single-language`
- Commit 2: `feat: add multisdk Milvus environment configuration`
- Commit 3: `feat: prepare multisdk verifier artifacts`
- Commit 4: `feat: add Manta validation recording for multisdk`
- Commit 5: `feat: write multisdk reviewed markdown locally`
- Commit 6: `refactor: grade multisdk local-first workflow`
- Commit 7: `docs: document local-first multisdk workflow`
