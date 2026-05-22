# Multi-SDK Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `md2feishu multisdk` as a resumable, language-scoped harness for Milvus multi-SDK Feishu code-block completion.

**Architecture:** Keep `code-blocks` as the low-level Feishu block engine. Add a focused `src/multisdk/` layer that owns task state, language aliases, language-scoped manifests, verification evidence, state transitions, and handoff generation. Wire that layer into Commander under `md2feishu multisdk`.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, existing Feishu client and code-block sync modules.

---

## File Structure

- Create `src/multisdk/language.ts`: normalize `java`, `javascript`, `node`, `nodejs`, `js`, `go`, and `restful`.
- Create `src/multisdk/task.ts`: define task schema, language state, task load/save helpers, transition helpers, and status summaries.
- Create `src/multisdk/manifest.ts`: filter a full code-block manifest to one language and merge refreshed language items back into the full manifest.
- Create `src/multisdk/handoff.ts`: render `handoff.md` from `task.json`.
- Create `src/multisdk/workflow.ts`: implement init, export, verify, apply, audit, finalize as reusable functions.
- Modify `src/cli/index.ts`: add `multisdk` command group and command option types.
- Modify `.gitignore`: ignore `runs/` as the default operator workspace.
- Add tests:
  - `test/multisdk-language.test.ts`
  - `test/multisdk-task.test.ts`
  - `test/multisdk-manifest.test.ts`
  - `test/multisdk-workflow.test.ts`
- Modify docs:
  - `docs-site/reference/commands.md`
  - `docs-site/guide/multisdk-workflow.md`
  - `docs-site/.vitepress/config.ts`
  - `docs-site/agent/skills/milvus-multisdk-example-sync.md`
  - `docs-site/agent/skills/feishu-codeblock-writer.md`
  - local skill files under `/Users/liyun/.codex/skills/` only if explicitly approved for non-repo writes.

## Task 1: Multi-SDK Language and Task Model

**Files:**
- Create: `src/multisdk/language.ts`
- Create: `src/multisdk/task.ts`
- Test: `test/multisdk-language.test.ts`
- Test: `test/multisdk-task.test.ts`

- [ ] **Step 1: Write language normalization tests**

Create `test/multisdk-language.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeMultisdkLanguage, parseMultisdkLanguage } from '../src/multisdk/language.js';

describe('multisdk language normalization', () => {
  it('normalizes supported languages and javascript aliases', () => {
    expect(normalizeMultisdkLanguage('java')).toBe('java');
    expect(normalizeMultisdkLanguage('javascript')).toBe('javascript');
    expect(normalizeMultisdkLanguage('node')).toBe('javascript');
    expect(normalizeMultisdkLanguage('nodejs')).toBe('javascript');
    expect(normalizeMultisdkLanguage('js')).toBe('javascript');
    expect(normalizeMultisdkLanguage('go')).toBe('go');
    expect(normalizeMultisdkLanguage('restful')).toBe('restful');
  });

  it('rejects python and unknown languages for multisdk lanes', () => {
    expect(normalizeMultisdkLanguage('python')).toBeNull();
    expect(normalizeMultisdkLanguage('cpp')).toBeNull();
    expect(() => parseMultisdkLanguage('cpp')).toThrow(/Invalid --language cpp/);
  });
});
```

- [ ] **Step 2: Run language test to verify it fails**

Run:

```bash
npm test -- multisdk-language
```

Expected: fails because `src/multisdk/language.ts` does not exist.

- [ ] **Step 3: Implement `src/multisdk/language.ts`**

Create `src/multisdk/language.ts`:

```ts
import type { CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';

export type MultisdkLanguage = Exclude<CanonicalCodeBlockLanguage, 'python'>;

export const MULTISDK_LANGUAGES: MultisdkLanguage[] = [
  'java',
  'javascript',
  'go',
  'restful'
];

export function normalizeMultisdkLanguage(value: string): MultisdkLanguage | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'java') return 'java';
  if (normalized === 'javascript' || normalized === 'node' || normalized === 'nodejs' || normalized === 'js') {
    return 'javascript';
  }
  if (normalized === 'go') return 'go';
  if (normalized === 'restful') return 'restful';
  return null;
}

export function parseMultisdkLanguage(value: string): MultisdkLanguage {
  const language = normalizeMultisdkLanguage(value);
  if (!language) {
    throw new Error(`Invalid --language ${value}. Expected java, javascript/node/nodejs/js, go, or restful.`);
  }
  return language;
}
```

- [ ] **Step 4: Run language test to verify it passes**

Run:

```bash
npm test -- multisdk-language
```

Expected: pass.

- [ ] **Step 5: Write task model tests**

Create `test/multisdk-task.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createInitialMultisdkTask,
  loadMultisdkTask,
  markLanguageStatus,
  saveMultisdkTask,
  summarizeMultisdkTask
} from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk task model', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('creates initial per-language state', () => {
    const task = createInitialMultisdkTask({
      document: 'https://zilliverse.feishu.cn/wiki/doc-token',
      documentId: 'doc-id',
      taskDir: 'runs/doc-token'
    });

    expect(task.kind).toBe('feishu-multisdk-task');
    expect(task.languageOrder).toEqual(['python', 'java', 'javascript', 'go', 'restful']);
    expect(task.languages.java.status).toBe('pending');
    expect(task.languages.javascript.status).toBe('pending');
    expect(task.languages.go.status).toBe('pending');
    expect(task.languages.restful.status).toBe('pending');
    expect(task.finalAuditPassed).toBe(false);
  });

  it('saves and loads task.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multisdk-task-'));
    tempDirs.push(dir);
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: dir
    });

    await saveMultisdkTask(task);

    expect(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'))).toEqual(task);
    await expect(loadMultisdkTask(dir)).resolves.toEqual(task);
  });

  it('updates language status without mutating other lanes', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id'
    });

    const updated = markLanguageStatus(task, 'java', 'exported');

    expect(updated.languages.java.status).toBe('exported');
    expect(updated.languages.javascript.status).toBe('pending');
    expect(task.languages.java.status).toBe('pending');
  });

  it('summarizes the task for status output', () => {
    const task = createInitialMultisdkTask({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id'
    });
    const updated = markLanguageStatus(task, 'java', 'audited');

    expect(summarizeMultisdkTask(updated)).toEqual({
      document: 'doc-url',
      documentId: 'doc-id',
      taskDir: 'runs/doc-id',
      languages: {
        java: 'audited',
        javascript: 'pending',
        go: 'pending',
        restful: 'pending'
      },
      finalAuditPassed: false
    });
  });
});
```

- [ ] **Step 6: Run task model test to verify it fails**

Run:

```bash
npm test -- multisdk-task
```

Expected: fails because `src/multisdk/task.ts` does not exist.

- [ ] **Step 7: Implement `src/multisdk/task.ts`**

Create `src/multisdk/task.ts` with these exports:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonicalCodeBlockLanguage } from '../feishu/code-blocks.js';
import type { MultisdkLanguage } from './language.js';
import { MULTISDK_LANGUAGES } from './language.js';

export type MultisdkLanguageStatus =
  | 'pending'
  | 'exported'
  | 'ready'
  | 'dry-run-passed'
  | 'written'
  | 'audited'
  | 'blocked';

export type MultisdkEvidence = {
  path: string;
  command: string;
  recordedAt: string;
};

export type MultisdkLanguageState = {
  status: MultisdkLanguageStatus;
  sourceVerified: boolean;
  snippetsReady: boolean;
  validated: boolean;
  dryRunPassed: boolean;
  writePassed: boolean;
  auditPassed: boolean;
  evidence: MultisdkEvidence[];
  reason?: string;
};

export type MultisdkTask = {
  kind: 'feishu-multisdk-task';
  version: 1;
  document: string;
  documentId: string;
  taskDir: string;
  languageOrder: CanonicalCodeBlockLanguage[];
  languages: Record<MultisdkLanguage, MultisdkLanguageState>;
  finalAuditPassed: boolean;
  cleanup: string[];
};

export type MultisdkTaskSummary = {
  document: string;
  documentId: string;
  taskDir: string;
  languages: Record<MultisdkLanguage, MultisdkLanguageStatus>;
  finalAuditPassed: boolean;
};

export function createInitialMultisdkTask(input: {
  document: string;
  documentId: string;
  taskDir: string;
}): MultisdkTask {
  return {
    kind: 'feishu-multisdk-task',
    version: 1,
    document: input.document,
    documentId: input.documentId,
    taskDir: input.taskDir,
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    languages: {
      java: initialLanguageState(),
      javascript: initialLanguageState(),
      go: initialLanguageState(),
      restful: initialLanguageState()
    },
    finalAuditPassed: false,
    cleanup: []
  };
}

export function markLanguageStatus(
  task: MultisdkTask,
  language: MultisdkLanguage,
  status: MultisdkLanguageStatus,
  reason?: string
): MultisdkTask {
  return {
    ...task,
    languages: {
      ...task.languages,
      [language]: {
        ...task.languages[language],
        status,
        reason
      }
    }
  };
}

export function summarizeMultisdkTask(task: MultisdkTask): MultisdkTaskSummary {
  return {
    document: task.document,
    documentId: task.documentId,
    taskDir: task.taskDir,
    languages: {
      java: task.languages.java.status,
      javascript: task.languages.javascript.status,
      go: task.languages.go.status,
      restful: task.languages.restful.status
    },
    finalAuditPassed: task.finalAuditPassed
  };
}

export async function loadMultisdkTask(taskDir: string): Promise<MultisdkTask> {
  const task = JSON.parse(await readFile(taskPath(taskDir), 'utf8')) as MultisdkTask;
  if (task.kind !== 'feishu-multisdk-task' || task.version !== 1) {
    throw new Error(`Invalid multisdk task at ${taskPath(taskDir)}.`);
  }
  return task;
}

export async function saveMultisdkTask(task: MultisdkTask): Promise<void> {
  await mkdir(task.taskDir, { recursive: true });
  await writeFile(taskPath(task.taskDir), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
}

export function taskPath(taskDir: string): string {
  return join(taskDir, 'task.json');
}

function initialLanguageState(): MultisdkLanguageState {
  return {
    status: 'pending',
    sourceVerified: false,
    snippetsReady: false,
    validated: false,
    dryRunPassed: false,
    writePassed: false,
    auditPassed: false,
    evidence: []
  };
}
```

- [ ] **Step 8: Run task model tests**

Run:

```bash
npm test -- multisdk-language multisdk-task
```

Expected: pass.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add src/multisdk/language.ts src/multisdk/task.ts test/multisdk-language.test.ts test/multisdk-task.test.ts
git commit -m "Add multisdk task model"
```

## Task 2: Language-Scoped Manifest Helpers

**Files:**
- Create: `src/multisdk/manifest.ts`
- Test: `test/multisdk-manifest.test.ts`

- [ ] **Step 1: Write manifest helper tests**

Create `test/multisdk-manifest.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import {
  filterManifestByLanguage,
  mergeLanguageManifestItems,
  writeLanguageScopedManifest
} from '../src/multisdk/manifest.js';

const tempDirs: string[] = [];

describe('multisdk manifest helpers', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('filters a full manifest to one language', () => {
    const scoped = filterManifestByLanguage(fullManifest(), 'javascript');

    expect(scoped.items).toEqual([
      expect.objectContaining({ language: 'javascript', file: 'snippets/javascript-01.js' })
    ]);
    expect(scoped.languageOrder).toEqual(['python', 'java', 'javascript', 'go', 'restful']);
  });

  it('merges refreshed language items without changing other languages', () => {
    const merged = mergeLanguageManifestItems(fullManifest(), {
      ...fullManifest(),
      items: [
        {
          action: 'insert',
          groupId: 'group-002',
          anchorBlockId: 'python-2',
          insertAfterBlockId: 'python-2',
          parentBlockId: 'doc',
          language: 'go',
          file: 'snippets/go-02.go'
        }
      ]
    }, 'go');

    expect(merged.items.map((item) => `${item.language}:${item.file}`)).toEqual([
      'java:snippets/java-01.java',
      'javascript:snippets/javascript-01.js',
      'restful:snippets/restful-01.sh',
      'go:snippets/go-02.go'
    ]);
  });

  it('writes a scoped manifest next to the full manifest so snippet paths resolve from task dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multisdk-manifest-'));
    tempDirs.push(dir);

    const path = await writeLanguageScopedManifest(dir, fullManifest(), 'java');

    expect(path).toBe(join(dir, '.multisdk-java-manifest.json'));
    const written = JSON.parse(await readFile(path, 'utf8')) as CodeBlockManifest;
    expect(written.items).toHaveLength(1);
    expect(written.items[0]?.file).toBe('snippets/java-01.java');
  });
});

function fullManifest(): CodeBlockManifest {
  return {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items: [
      { action: 'update', groupId: 'group-001', blockId: 'java-1', language: 'java', file: 'snippets/java-01.java' },
      { action: 'update', groupId: 'group-001', blockId: 'js-1', language: 'javascript', file: 'snippets/javascript-01.js' },
      { action: 'update', groupId: 'group-001', blockId: 'go-1', language: 'go', file: 'snippets/go-01.go' },
      { action: 'update', groupId: 'group-001', blockId: 'rest-1', language: 'restful', file: 'snippets/restful-01.sh' }
    ]
  };
}
```

- [ ] **Step 2: Run manifest test to verify it fails**

Run:

```bash
npm test -- multisdk-manifest
```

Expected: fails because `src/multisdk/manifest.ts` does not exist.

- [ ] **Step 3: Implement manifest helpers**

Create `src/multisdk/manifest.ts`:

```ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CodeBlockManifest } from '../sync/code-block-plan.js';
import type { MultisdkLanguage } from './language.js';

export function filterManifestByLanguage(
  manifest: CodeBlockManifest,
  language: MultisdkLanguage
): CodeBlockManifest {
  return {
    ...manifest,
    items: manifest.items.filter((item) => item.language === language)
  };
}

export function mergeLanguageManifestItems(
  current: CodeBlockManifest,
  refreshed: CodeBlockManifest,
  language: MultisdkLanguage
): CodeBlockManifest {
  return {
    ...current,
    document: refreshed.document,
    documentId: refreshed.documentId,
    languageOrder: refreshed.languageOrder,
    items: [
      ...current.items.filter((item) => item.language !== language),
      ...refreshed.items.filter((item) => item.language === language)
    ]
  };
}

export async function writeLanguageScopedManifest(
  taskDir: string,
  manifest: CodeBlockManifest,
  language: MultisdkLanguage
): Promise<string> {
  const scopedPath = join(taskDir, `.multisdk-${language}-manifest.json`);
  await writeFile(scopedPath, `${JSON.stringify(filterManifestByLanguage(manifest, language), null, 2)}\n`, 'utf8');
  return scopedPath;
}
```

- [ ] **Step 4: Run manifest tests**

Run:

```bash
npm test -- multisdk-manifest
```

Expected: pass.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add src/multisdk/manifest.ts test/multisdk-manifest.test.ts
git commit -m "Add multisdk manifest helpers"
```

## Task 3: Multi-SDK Workflow Operations

**Files:**
- Create: `src/multisdk/handoff.ts`
- Create: `src/multisdk/workflow.ts`
- Test: `test/multisdk-workflow.test.ts`

- [ ] **Step 1: Write workflow tests**

Create `test/multisdk-workflow.test.ts` with four focused cases:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeBlockInventory } from '../src/feishu/code-blocks.js';
import type { CodeBlockManifest } from '../src/sync/code-block-plan.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../src/multisdk/workflow.js';
import { saveMultisdkTask, createInitialMultisdkTask } from '../src/multisdk/task.js';

const tempDirs: string[] = [];

describe('multisdk workflow', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('initializes a task directory with manifest, snippets, and task state', async () => {
    const dir = await tempDir();

    const result = await initMultisdkTask({
      document: 'doc-url',
      documentId: 'doc',
      taskDir: dir,
      inventory: inventory()
    });

    expect(result.task.languages.java.status).toBe('exported');
    expect(result.task.languages.javascript.status).toBe('exported');
    expect(result.task.languages.go.status).toBe('exported');
    expect(result.task.languages.restful.status).toBe('exported');
    await expect(readFile(join(dir, 'manifest.json'), 'utf8')).resolves.toContain('"documentId": "doc"');
    await expect(readFile(join(dir, 'snippets/java-01-create-a-collection.java'), 'utf8')).resolves.toBe('');
  });

  it('records verification evidence and marks the language ready', async () => {
    const dir = await tempDir();
    const evidencePath = join(dir, 'java-smoke.log');
    await writeFile(evidencePath, 'PASS java smoke\n', 'utf8');
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));

    const task = await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath,
      command: 'mvn test -Dtest=Smoke'
    });

    expect(task.languages.java.status).toBe('ready');
    expect(task.languages.java.validated).toBe(true);
    expect(task.languages.java.evidence[0]).toEqual(expect.objectContaining({
      path: expect.stringMatching(/^evidence\/java-/),
      command: 'mvn test -Dtest=Smoke'
    }));
  });

  it('requires verification and dry-run before write apply', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'snippets'), { recursive: true });
    await writeFile(join(dir, 'snippets/java-01.java'), 'System.out.println("ok");', 'utf8');
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`, 'utf8');
    await saveMultisdkTask(createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }));
    const client = fakeApplyClient();

    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client }))
      .rejects.toThrow(/requires verification evidence/);

    await writeFile(join(dir, 'java-smoke.log'), 'PASS\n', 'utf8');
    await recordMultisdkVerification({
      taskDir: dir,
      language: 'java',
      evidencePath: join(dir, 'java-smoke.log'),
      command: 'java Smoke'
    });
    await expect(applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client }))
      .rejects.toThrow(/requires a successful dry-run/);

    const dryRun = await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: false, client });
    expect(dryRun.task.languages.java.status).toBe('dry-run-passed');

    const write = await applyMultisdkLanguage({ taskDir: dir, language: 'java', write: true, client });
    expect(write.task.languages.java.status).toBe('written');
    expect(client.batchUpdateBlocks).toHaveBeenCalledTimes(1);
  });

  it('audits one language and finalizes only after all languages are audited', async () => {
    const dir = await tempDir();
    await saveMultisdkTask({
      ...createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }),
      languages: {
        java: { ...createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }).languages.java, status: 'written', auditPassed: false },
        javascript: { ...createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }).languages.javascript, status: 'audited', auditPassed: true },
        go: { ...createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }).languages.go, status: 'audited', auditPassed: true },
        restful: { ...createInitialMultisdkTask({ document: 'doc-url', documentId: 'doc', taskDir: dir }).languages.restful, status: 'audited', auditPassed: true }
      }
    });

    const audited = await auditMultisdkLanguage({
      taskDir: dir,
      language: 'java',
      inventory: inventoryWithLanguages(['python', 'java', 'javascript', 'go', 'restful'])
    });
    expect(audited.task.languages.java.status).toBe('audited');

    const final = await finalizeMultisdkTask({
      taskDir: dir,
      inventory: inventoryWithLanguages(['python', 'java', 'javascript', 'go', 'restful'])
    });
    expect(final.task.finalAuditPassed).toBe(true);
    await expect(readFile(join(dir, 'handoff.md'), 'utf8')).resolves.toContain('Final audit: passed');
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'multisdk-workflow-'));
  tempDirs.push(dir);
  return dir;
}

function manifest(): CodeBlockManifest {
  return {
    document: 'doc-url',
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    items: [
      { action: 'update', groupId: 'group-001', blockId: 'java-1', language: 'java', file: 'snippets/java-01.java' }
    ]
  };
}

function fakeApplyClient() {
  return {
    batchUpdateBlocks: vi.fn(async () => [{ block_id: 'java-1', block_type: 14 }]),
    createChildren: vi.fn(async () => [{ block_id: 'created-1', block_type: 14 }]),
    getDocumentBlocks: vi.fn(async () => [
      { block_id: 'doc', block_type: 1, children: ['python-1', 'java-1'] },
      { block_id: 'python-1', block_type: 14 },
      { block_id: 'java-1', block_type: 14 }
    ])
  };
}

function inventory(): CodeBlockInventory {
  return inventoryWithLanguages(['python']);
}

function inventoryWithLanguages(languages: Array<'python' | 'java' | 'javascript' | 'go' | 'restful'>): CodeBlockInventory {
  const blocks = languages.map((language, index) => block(language, index + 1));
  return {
    documentId: 'doc',
    languageOrder: ['python', 'java', 'javascript', 'go', 'restful'],
    groups: [{
      groupId: 'group-001',
      heading: 'Create a collection',
      pythonAnchorBlockId: 'python-1',
      parentBlockId: 'doc',
      startIndex: 1,
      endIndex: blocks[blocks.length - 1]?.childIndex ?? 1,
      languages,
      missingLanguages: ['java', 'javascript', 'go', 'restful'].filter((language) => !languages.includes(language)) as CodeBlockInventory['languageOrder'],
      blocks
    }],
    blocks
  };
}

function block(
  language: 'python' | 'java' | 'javascript' | 'go' | 'restful',
  childIndex: number
): CodeBlockInventory['blocks'][number] {
  const blockId = `${language === 'javascript' ? 'js' : language}-1`;
  return {
    blockId,
    parentBlockId: 'doc',
    childIndex,
    documentIndex: childIndex,
    language,
    canonicalLanguage: language,
    text: language === 'python' ? 'from pymilvus import MilvusClient' : `${language} snippet`,
    isPlaceholder: false,
    heading: 'Create a collection',
    groupId: 'group-001',
    pythonAnchorBlockId: 'python-1'
  };
}
```

- [ ] **Step 2: Run workflow test to verify it fails**

Run:

```bash
npm test -- multisdk-workflow
```

Expected: fails because `src/multisdk/workflow.ts` and `src/multisdk/handoff.ts` do not exist.

- [ ] **Step 3: Implement `src/multisdk/handoff.ts`**

Create `src/multisdk/handoff.ts`:

```ts
import type { MultisdkTask } from './task.js';
import { MULTISDK_LANGUAGES } from './language.js';

export function renderMultisdkHandoff(task: MultisdkTask): string {
  const lines = [
    `# Multi-SDK Handoff`,
    ``,
    `Document: ${task.document}`,
    `Document ID: ${task.documentId}`,
    `Task dir: ${task.taskDir}`,
    `Final audit: ${task.finalAuditPassed ? 'passed' : 'not passed'}`,
    ``,
    `## Languages`,
    ``
  ];

  for (const language of MULTISDK_LANGUAGES) {
    const state = task.languages[language];
    lines.push(`- ${language}: ${state.status}`);
    for (const evidence of state.evidence) {
      lines.push(`  - evidence: ${evidence.path}`);
      lines.push(`  - command: ${evidence.command}`);
    }
    if (state.reason) lines.push(`  - reason: ${state.reason}`);
  }

  if (task.cleanup.length > 0) {
    lines.push(``, `## Cleanup`, ``);
    for (const item of task.cleanup) lines.push(`- ${item}`);
  }

  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Implement `src/multisdk/workflow.ts`**

Create workflow functions with these signatures:

```ts
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { CodeBlockInventory } from '../feishu/code-blocks.js';
import type { CodeBlockApplyClient } from '../sync/code-block-apply.js';
import { applyCodeBlockManifest } from '../sync/code-block-apply.js';
import { auditCodeBlockInventory } from '../sync/code-block-audit.js';
import { exportCodeBlockSnippets } from '../sync/code-block-export.js';
import type { CodeBlockManifest } from '../sync/code-block-plan.js';
import { filterManifestByLanguage, mergeLanguageManifestItems, writeLanguageScopedManifest } from './manifest.js';
import type { MultisdkLanguage } from './language.js';
import { MULTISDK_LANGUAGES } from './language.js';
import { createInitialMultisdkTask, loadMultisdkTask, saveMultisdkTask, type MultisdkTask } from './task.js';
import { renderMultisdkHandoff } from './handoff.js';

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
```

Also implement:

```ts
export async function recordMultisdkVerification(input: {
  taskDir: string;
  language: MultisdkLanguage;
  evidencePath: string;
  command: string;
}): Promise<MultisdkTask>
```

This function loads the task, copies `evidencePath` into `taskDir/evidence/<language>-<Date.now()>-<basename>`, records the copied relative path, sets `validated`, `sourceVerified`, and `snippetsReady` to `true`, sets status to `ready`, saves, and returns the task.

```ts
export async function applyMultisdkLanguage(input: {
  taskDir: string;
  language: MultisdkLanguage;
  write: boolean;
  client: CodeBlockApplyClient;
}): Promise<{ task: MultisdkTask; report: Awaited<ReturnType<typeof applyCodeBlockManifest>> }>
```

This function loads task and manifest, gates `write` on `validated === true` and `dryRunPassed === true`, writes a language-scoped manifest in the task root, delegates to `applyCodeBlockManifest`, fails if `report.failed.length > 0`, then updates status to `dry-run-passed` or `written`.

```ts
export async function exportMultisdkLanguage(input: {
  document: string;
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; manifest: CodeBlockManifest; files: string[] }>
```

This function refreshes only one language by calling `exportCodeBlockSnippets` with `expectLanguages: [language]`, merges that language into the full manifest, writes `manifest.json`, marks that language `exported`, and saves the task.

```ts
export async function auditMultisdkLanguage(input: {
  taskDir: string;
  language: MultisdkLanguage;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: ReturnType<typeof auditCodeBlockInventory> }>
```

This function delegates to `auditCodeBlockInventory(inventory, { expectLanguages: [language] })`, fails if `report.passed` is false, marks the language `audited`, and saves.

```ts
export async function finalizeMultisdkTask(input: {
  taskDir: string;
  inventory: CodeBlockInventory;
}): Promise<{ task: MultisdkTask; report: ReturnType<typeof auditCodeBlockInventory>; handoffPath: string }>
```

This function checks every language state is `audited`, runs full audit with `MULTISDK_LANGUAGES`, sets `finalAuditPassed`, writes `handoff.md`, saves the task, and returns the report.

- [ ] **Step 5: Run workflow tests**

Run:

```bash
npm test -- multisdk-workflow
```

Expected: pass.

- [ ] **Step 6: Run all multisdk tests**

Run:

```bash
npm test -- multisdk
```

Expected: all multisdk tests pass.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add src/multisdk/handoff.ts src/multisdk/workflow.ts test/multisdk-workflow.test.ts
git commit -m "Add multisdk workflow operations"
```

## Task 4: CLI Command Group

**Files:**
- Modify: `src/cli/index.ts`
- Test manually with build and CLI dry commands.

- [ ] **Step 1: Add imports to `src/cli/index.ts`**

Add imports near the existing code-block imports:

```ts
import { parseMultisdkLanguage } from '../multisdk/language.js';
import {
  applyMultisdkLanguage,
  auditMultisdkLanguage,
  exportMultisdkLanguage,
  finalizeMultisdkTask,
  initMultisdkTask,
  recordMultisdkVerification
} from '../multisdk/workflow.js';
import { loadMultisdkTask, summarizeMultisdkTask } from '../multisdk/task.js';
```

- [ ] **Step 2: Add CLI option types**

Add these types near existing command option types:

```ts
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
```

- [ ] **Step 3: Add `multisdk` command group**

Add the command group after `code-blocks` or before `reference`:

```ts
const multisdk = program
  .command('multisdk')
  .description('run a resumable multi-SDK code-block completion workflow');
```

- [ ] **Step 4: Add `multisdk init`**

Implement:

```ts
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
```

- [ ] **Step 5: Add `status`, `export`, and `verify`**

Implement:

```ts
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
```

- [ ] **Step 6: Add `apply`, `audit`, and `finalize`**

Implement:

```ts
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
```

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass. If it fails on Commander option typing, adjust only the new option types and callback signatures.

- [ ] **Step 8: Build CLI**

Run:

```bash
npm run build
```

Expected: pass.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git add src/cli/index.ts
git commit -m "Add multisdk CLI commands"
```

## Task 5: Docs, Skills, and Ignore Rules

**Files:**
- Modify: `.gitignore`
- Modify: `docs-site/reference/commands.md`
- Create: `docs-site/guide/multisdk-workflow.md`
- Modify: `docs-site/.vitepress/config.ts`
- Modify: `docs-site/agent/skills/milvus-multisdk-example-sync.md`
- Modify: `docs-site/agent/skills/feishu-codeblock-writer.md`

- [ ] **Step 1: Ignore default run workspace**

Add this line to `.gitignore`:

```text
runs/
```

- [ ] **Step 2: Add command reference docs**

In `docs-site/reference/commands.md`, add a `## multisdk` section after `code-blocks`:

````md
## `multisdk`

Run a resumable, language-scoped multi-SDK code-block workflow for one Feishu document.

```bash
md2feishu multisdk init <feishu-doc> --out runs/<doc-token>
md2feishu multisdk status <task-dir>
md2feishu multisdk export <task-dir> --language java
md2feishu multisdk verify <task-dir> --language java --evidence evidence/java.log --command "mvn test"
md2feishu multisdk apply <task-dir> --language java
md2feishu multisdk apply <task-dir> --language java --write -y
md2feishu multisdk audit <task-dir> --language java
md2feishu multisdk finalize <task-dir>
```

`multisdk apply` defaults to dry-run. Writes require `--write` and either `-y` or interactive confirmation. Each language must have verification evidence and a successful dry-run before write. Supported lanes are `java`, `javascript`, `go`, and `restful`; `node`, `nodejs`, and `js` normalize to `javascript`.
````

- [ ] **Step 3: Add workflow guide**

Create `docs-site/guide/multisdk-workflow.md`:

````md
# Multi-SDK Workflow

Use `multisdk` when a Feishu document already has Python examples and needs verified Java, JavaScript, Go, or RESTful code blocks.

Initialize once:

```bash
md2feishu multisdk init "$DOC" --out runs/<doc-token>
```

Complete one SDK lane at a time:

```bash
md2feishu multisdk export runs/<doc-token> --language java
md2feishu multisdk verify runs/<doc-token> --language java --evidence runs/<doc-token>/evidence/java.log --command "mvn test"
md2feishu multisdk apply runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java --write -y
md2feishu multisdk audit runs/<doc-token> --language java
```

Repeat the lane workflow for `javascript`, `go`, and `restful`, then finalize:

```bash
md2feishu multisdk finalize runs/<doc-token>
```

The final command runs a full readback audit and writes `handoff.md` in the task directory.

## Safety

- Verify SDK support from SDK source repositories, not published Milvus docs.
- Run validation before recording evidence.
- Run dry-run before every real write.
- Audit after every write.
- Keep `runs/` local unless a run artifact is intentionally shared.
````

- [ ] **Step 4: Add guide to VitePress sidebar**

In `docs-site/.vitepress/config.ts`, add this Guide sidebar item after `Configuration`:

```ts
{ text: 'Multi-SDK Workflow', link: '/guide/multisdk-workflow' },
```

- [ ] **Step 5: Update agent skill docs**

In `docs-site/agent/skills/milvus-multisdk-example-sync.md`, update the workflow to prefer `md2feishu multisdk` for execution. Keep the rule that `sdk-source-verifier` owns source truth.

In `docs-site/agent/skills/feishu-codeblock-writer.md`, add one sentence:

```md
For Milvus multi-SDK document tasks that need resumable per-language state, use `milvus-multisdk-example-sync` and the `md2feishu multisdk` CLI; this skill remains the low-level code-block engine.
```

- [ ] **Step 6: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: pass.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add .gitignore docs-site/reference/commands.md docs-site/guide/multisdk-workflow.md docs-site/.vitepress/config.ts docs-site/agent/skills/milvus-multisdk-example-sync.md docs-site/agent/skills/feishu-codeblock-writer.md
git commit -m "Document multisdk harness workflow"
```

## Task 6: Final Verification and Local Smoke

**Files:**
- No planned source changes unless verification finds a bug.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- multisdk code-block
```

Expected: pass.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Run typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both pass.

- [ ] **Step 4: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: pass.

- [ ] **Step 5: Run non-live CLI help smoke**

Run:

```bash
node dist/cli/index.js multisdk --help
node dist/cli/index.js multisdk init --help
node dist/cli/index.js multisdk apply --help
```

Expected: each command prints help and exits successfully.

- [ ] **Step 6: Run fake task status smoke**

Create a temporary task with a minimal `task.json`, then run:

```bash
node dist/cli/index.js multisdk status /private/tmp/feishu-md-sync-multisdk-smoke --format json
```

Expected: JSON summary with four language statuses.

- [ ] **Step 7: Commit verification fixes if needed**

If any verification step required code changes, commit those changes with a focused message:

```bash
git add <changed-files>
git commit -m "Fix multisdk verification issues"
```

If no changes were needed, do not create a verification-only commit.

## Self-Review

- Spec coverage: the plan implements `md2feishu multisdk init/status/export/verify/apply/audit/finalize`, per-language execution, dry-run/write/audit gates, evidence tracking, final handoff, docs, and tests.
- Scope: the plan does not add C++, Manta cluster orchestration, automatic SDK example generation, or SDK source verification logic.
- Type consistency: the plan uses `MultisdkLanguage`, `MultisdkTask`, `CodeBlockManifest`, and existing `CodeBlockApplyClient` consistently across tasks.
- Risk: `src/cli/index.ts` is already large. This plan keeps new behavior in `src/multisdk/` and only wires commands in the CLI file.
