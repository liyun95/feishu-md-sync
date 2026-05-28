# CLI UX and Stability Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `md2feishu` from an organically grown CLI into a stable, task-oriented document operations harness that is easy for the docs team and AI agents to operate without memorizing command details.

**Architecture:** Preserve the current working capability surface, but reorganize it around explicit workflows, typed command modules, a shared run context, consistent task artifacts, and a safer document patch planner. The target shape is a thin Commander entrypoint, workflow-specific command modules, shared Feishu/Markdown/safety services, and harness-grade artifacts for every long-running workflow.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, Feishu docx/Drive/Bitable APIs, VitePress docs, existing receipt/task/manifest/harness modules.

---

## Current Capability Inventory

Evidence comes from the current command surface in `packages/cli/src/cli/index.ts`, existing docs under `apps/docs/`, and tests under `packages/cli/test/`.

| User story | Implemented today | Evidence |
| --- | --- | --- |
| Pull a remote Feishu doc into local Markdown as a baseline | `pull <feishu-doc> --output <file>` exports current Feishu blocks to best-effort Markdown. `status`, receipts, and `merge` can compare against later local/remote state. | `pull` command at `packages/cli/src/cli/index.ts:131`; receipt model in `packages/cli/src/receipts/receipt.ts`; command docs in `apps/docs/reference/commands.md`. |
| Diff local Markdown against remote Feishu and write small changes | `diff`, `status`, `merge`, dry-run-first `sync`, receipt conflict detection, initial-overwrite guard, `--strategy merge`, and a new `--section <heading>` path exist. However the general planner is still replace-all except for section replacement. | `sync/status/diff/merge` commands at `packages/cli/src/cli/index.ts:96`; patch planner in `packages/cli/src/sync/patch.ts`; section planner in `packages/cli/src/sync/section.ts`; section docs in `apps/docs/guide/section-sync.md`. |
| Draft, test, validate, and write multi-language examples back only to Feishu code blocks | Low-level `code-blocks` inspect/plan/export/apply/audit/update exists. `multisdk` adds task directories, per-language export, validation evidence, diff, dry-run, write gate, audit, docs landing, finalize, and harness grade. | `code-blocks` commands at `packages/cli/src/cli/index.ts:263`; `multisdk` commands at `packages/cli/src/cli/index.ts:401`; workflow modules under `packages/cli/src/multisdk/`; harness modules under `packages/cli/src/harness/`. |
| Maintain SDK references from source scan through Feishu authoring, then optionally release to web-content | `reference preflight/plan/apply/audit/export/web-content/release run` and `release init/pull/scan-sdk-tags/audit/approve/apply/status` exist. The implementation currently exposes both Feishu authoring and web-content handoff commands, but the UX should split them so web-content release is human-triggered after Feishu authoring is done. | `reference` commands at `packages/cli/src/cli/index.ts:697`; `release` commands at `packages/cli/src/cli/index.ts:927`; modules under `packages/cli/src/reference/` and `packages/cli/src/release/`. |
| AI agent can operate without memorizing commands | Partial. `harness tools --workflow multisdk`, docs skill pages, and command docs exist. There is no unified `next` command, command registry, or workflow recipe API for `sync`, `reference`, and `release`. | `harness` command at `packages/cli/src/cli/index.ts:163`; `packages/cli/src/harness/tools.ts`; docs under `apps/docs/agent/`. |

## Problems To Fix

1. `packages/cli/src/cli/index.ts` is a 1,805-line command/router/orchestration file. This makes UX changes risky because command parsing, Feishu calls, workflow state, formatting, and error handling are interleaved.
2. The CLI has grown multiple workflow models: `.sync/feishu/*.json` receipts, `runs/<doc>/task.json`, release task directories, reference manifests, web-content handoff reports, and harness artifacts. They are useful but inconsistent.
3. General Markdown-to-Feishu sync still plans `replace-all` unless `--section` is used. That is too coarse for reviewed docs where the desired operation is a small, explainable remote patch.
4. Feishu reliability behavior is scattered. The client handles API access, pagination, nested block creation, Bitable, Drive, timeout, and some error enrichment in one file.
5. User-facing commands are powerful but not self-guiding. A teammate or agent can inspect docs, but the CLI itself does not reliably answer “what should I run next?”.
6. Harness engineering is strongest for `multisdk` only. `sync`, `release`, and `reference` need the same Task, Environment, Tools, Execution Trace, and Verification shape.
7. Markdown support is intentionally best-effort, but unsupported constructs are not always surfaced as structured preflight warnings. The new link preflight is a good pattern to expand.
8. Feishu now has official Markdown APIs that overlap with our custom conversion layer. The refactor should evaluate those APIs before investing more in homegrown Markdown import/export.

## Official Feishu Markdown API Assessment

Feishu currently exposes two official APIs that can reduce custom conversion risk:

- `GET /open-apis/docs/v1/content` returns Markdown content for new cloud docs. This is a strong candidate to replace the CLI's custom Feishu-block-to-Markdown export path for `pull`, `diff`, `merge`, remote snapshots, and receipt baselines.
- `POST /open-apis/docx/v1/documents/blocks/convert` converts Markdown or HTML into docx blocks. This is a strong candidate to replace or validate the CLI's custom Markdown-to-Feishu-block renderer before writes.

The official APIs should not delete the local conversion layer immediately. Keep custom conversion as a fallback and for deterministic unit tests until live smoke tests prove the official output is stable enough for docs-team workflows.

Decision policy:

- Prefer official Markdown export for baseline pull when the doc is a supported new docx document and the API returns valid Markdown.
- Prefer official Markdown-to-block conversion for full-document and section write planning if returned block shapes are compatible with the existing create/delete APIs and code-block language mapping.
- Keep block-level APIs for partial writes, code-block updates, readback audits, and section replacement. Official Markdown export is a representation source, not a complete replacement for patch planning.
- Keep raw block inventory for multi-SDK workflows because code-block IDs, parent IDs, and insertion positions are still required.
- Add `--markdown-engine official | local | auto`.
- Target default: `auto`, meaning official Feishu Markdown APIs first and local conversion fallback only when the official API is unavailable or fails validation.
- During implementation, keep `local` available for compatibility and deterministic tests. Do not make `local` the long-term default unless smoke tests prove the official API is unsafe for Milvus/Zilliz docs.

## Target Architecture

```text
packages/cli/src/
  cli/
    index.ts                  thin program bootstrap only
    context.ts                builds Feishu client, env report, output format helpers
    output.ts                 pretty/json rendering and exit-code policy
    commands/
      sync.ts                 sync/status/diff/merge/pull command registration
      code-blocks.ts          low-level code-block command registration
      multisdk.ts             multi-SDK command registration
      reference.ts            SDK reference command registration
      release.ts              release-note command registration
      harness.ts              harness command registration
      workflow.ts             user/agent workflow discovery commands
  workflows/
    sync/
      task.ts                 baseline, receipt, and sync task summary
      planner.ts              document/section/block patch planning
      runner.ts               dry-run/write orchestration
      grader.ts               sync done-definition checks
    multisdk/                 existing modules moved or re-exported after boundary cleanup
    reference/                existing modules plus Feishu authoring harness adapters
    reference-release/        explicit human-triggered web-content release/handoff adapters
    release/                  existing modules plus harness adapters
  services/
    feishu/
      docx-client.ts          docx-only gateway
      docs-content-client.ts  official docs/v1 Markdown content gateway
      drive-client.ts         Drive gateway
      bitable-client.ts       Bitable gateway
      block-convert-client.ts official Markdown/HTML to docx blocks gateway
      retry.ts                timeout/rate-limit/retry policy
      errors.ts               typed API errors and user-safe messages
    markdown/
      parse.ts                Markdown -> internal document AST
      render-feishu.ts        AST -> Feishu blocks
      render-markdown.ts      Feishu blocks -> Markdown
      preflight.ts            structured unsupported-feature checks
  harness/
    task.ts                   shared task summary contract
    tools.ts                  all workflow tool registries
    trace.ts                  append-only execution trace
    grade.ts                  dispatcher for workflow graders
```

Boundary rule: `cli/commands/*` parses flags and prints results only. Workflow modules own decisions. Service modules own I/O adapters. Harness modules own task/environment/tool/trace/grade contracts.

## Deliverables

- A current-state capability report in docs, generated from source-backed command inventory.
- A split command architecture with `cli/index.ts` reduced to bootstrap and command registration.
- A shared `CliContext` and output/error policy.
- A workflow registry that can power `md2feishu workflow list`, `md2feishu workflow show <name>`, and `md2feishu workflow next <task-dir>`.
- A unified task summary and harness grade adapter for `sync`, `multisdk`, `reference`, and `release`.
- A deliberate split between SDK reference authoring and SDK reference release. Feishu reference writing/auditing must be completable without touching `web-content`; `web-content` export happens only after a human explicitly starts the release workflow.
- A workflow-to-skill package where each workflow has a corresponding agent skill that loads the workflow recipe, enforces safety gates, and tells the agent which CLI command to run next.
- A safer sync planner that supports whole-document, section-level, and block-level explainable patch plans.
- An official Markdown adapter that can use Feishu's native Markdown export/import APIs where they are safer and more complete than local conversion.
- A Feishu gateway split into docx, Drive, Bitable, retry, and typed error modules.
- A docs restructure that removes duplicated human-vs-agent workflow content. Human docs and agent docs may have different entry pages, but workflow facts, safety gates, and command sequences must come from one shared workflow source.
- Agent skill updates that describe workflows rather than command memorization.

## Documentation Refactor Contract

The current docs split too much workflow substance between human pages under `apps/docs/guide/` and agent pages under `apps/docs/agent/`. After this refactor, there should not be two independent runbooks for the same workflow.

Documentation ownership rules:

- `packages/cli/src/workflows/registry.ts` owns workflow IDs, ordered command steps, write targets, artifacts, and completion checks.
- `apps/docs/guide/workflows.md` owns the human-readable workflow index and links users to `md2feishu workflow show <workflow-id>`.
- `apps/docs/reference/safety-gates.md` owns shared safety gates. Safety policy should not be repeated in every guide and skill.
- `apps/docs/reference/commands.md` owns command syntax and flag details only. It should not teach full workflow strategy.
- `apps/docs/agent/skills/*.md` owns agent selection rules, workflow boundaries, and pressure scenarios only. New workflow skills must load the CLI recipe instead of duplicating command sequences.
- Legacy skill pages stay as compatibility aliases, not as another place to grow workflow logic.

Compatibility rule: keep existing guide and skill URLs when possible, but make old pages thin entry points that link to the shared workflow guide, safety gates, command reference, or replacement workflow skill.

---

### Task 1: Lock Current Behavior With a Capability Inventory

**Files:**
- Create: `apps/docs/internals/capability-inventory.md`
- Create: `packages/cli/test/cli-help-surface.test.ts`
- Modify: `apps/docs/.vitepress/config.ts`

- [ ] **Step 1: Add a source-backed capability inventory doc**

Create `apps/docs/internals/capability-inventory.md` with the inventory table from this plan and a “Known gaps” section listing:

```md
# Capability Inventory

This inventory reflects the current `md2feishu` command surface and should be updated when commands are added, renamed, or removed.

## Implemented Workflows

| Workflow | Commands | Primary artifacts | Write targets |
| --- | --- | --- | --- |
| Baseline sync | `pull`, `status`, `diff`, `merge`, `sync` | `.sync/feishu/*.json`, `.merged.md` | Feishu docx |
| Section sync | `sync --section <heading>` | dry-run/write receipt output; whole-document receipt intentionally unchanged | Feishu docx section blocks |
| Code blocks | `code-blocks inspect/plan/export/apply/audit/update` | manifest JSON, snippet files | Feishu code blocks |
| Multi-SDK examples | `multisdk init/status/export/profile/verify/diff/apply/audit/land-docs/finalize` | `task.json`, `manifest.json`, snippets, evidence, trace, handoff | Feishu code blocks, optional local docs repo |
| SDK reference authoring | `reference preflight/plan/apply/audit` | impact matrix, publish manifest, Feishu apply report, Feishu audit report | Feishu Drive, Bitable |
| SDK reference web-content release | `reference export`, `reference web-content`, `reference release run` | audited manifest, web-content export report, PR handoff report | external web-content checkout |
| Release notes | `release init/pull/scan-sdk-tags/audit/approve/apply/status` | release task dir, SDK tag matrix, audit report, approval hash | local Milvus docs checkout |
| Harness | `harness env/tools/grade` | `environment.json`, `trace/events.jsonl`, `grade.json`, `grade.md` | local task dirs |

## Known Gaps

- General sync still uses replace-all planning unless `--section` is specified.
- Only `multisdk` has a mature harness tools/trace/grade contract.
- CLI guidance is documentation-heavy; the binary does not yet provide workflow recipes or next-step commands.
- Feishu API responsibilities are concentrated in one client class.
- Command registration and orchestration are concentrated in `packages/cli/src/cli/index.ts`.
```

- [ ] **Step 2: Add a help-surface test**

Create `packages/cli/test/cli-help-surface.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('CLI help surface', () => {
  it('keeps top-level workflow commands discoverable', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', '--help'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    });

    for (const command of ['sync', 'status', 'pull', 'diff', 'merge', 'code-blocks', 'multisdk', 'reference', 'release', 'harness']) {
      expect(stdout).toContain(command);
    }
  });
});
```

- [ ] **Step 3: Run the behavior-lock test**

Run:

```bash
npm test -- cli-help-surface
```

Expected: PASS. If it fails because the test `cwd` resolves incorrectly, fix only the `cwd` expression, not command behavior.

- [ ] **Step 4: Link the inventory doc from VitePress internals nav**

Modify `apps/docs/.vitepress/config.ts` to add `Capability Inventory` under the internals/sidebar section near architecture and testing.

- [ ] **Step 5: Verify docs build after the new page**

Run:

```bash
npm run docs:build
```

Expected: VitePress build passes.

### Task 2: Split The CLI Entrypoint Into Command Modules

**Files:**
- Create: `packages/cli/src/cli/context.ts`
- Create: `packages/cli/src/cli/output.ts`
- Create: `packages/cli/src/cli/commands/sync.ts`
- Create: `packages/cli/src/cli/commands/code-blocks.ts`
- Create: `packages/cli/src/cli/commands/multisdk.ts`
- Create: `packages/cli/src/cli/commands/reference.ts`
- Create: `packages/cli/src/cli/commands/release.ts`
- Create: `packages/cli/src/cli/commands/harness.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/cli-help-surface.test.ts`

- [ ] **Step 1: Add `CliContext`**

Create `packages/cli/src/cli/context.ts`:

```ts
import type { CliEnvLoadReport } from './env.js';
import { FeishuClient } from '../feishu/client.js';

export type CliContext = {
  envLoadReport: CliEnvLoadReport;
  createFeishuClient(input?: { host?: string; timeoutMs?: number }): FeishuClient;
};

export function createCliContext(envLoadReport: CliEnvLoadReport): CliContext {
  return {
    envLoadReport,
    createFeishuClient: (input = {}) => new FeishuClient({
      host: input.host,
      timeoutMs: input.timeoutMs
    })
  };
}
```

- [ ] **Step 2: Add output helpers**

Create `packages/cli/src/cli/output.ts`:

```ts
export type OutputFormat = 'pretty' | 'json';

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printFormatted(value: unknown, format: string | undefined): void {
  if (format === 'json') {
    printJson(value);
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  printJson(value);
}

export function setFailedExitCode(condition: boolean): void {
  if (condition) process.exitCode = 1;
}
```

- [ ] **Step 3: Move one command group at a time**

Move code in this order: `harness`, `sync`, `code-blocks`, `multisdk`, `reference`, `release`. Each module exports one registration function:

```ts
import type { Command } from 'commander';
import type { CliContext } from '../context.js';

export function registerHarnessCommands(program: Command, context: CliContext): void {
  const harness = program
    .command('harness')
    .description('inspect harness environment, tools, trace, and grading artifacts');

  void context;
  void harness;
}
```

After each group moves, keep `packages/cli/src/cli/index.ts` compiling and run:

```bash
npm test -- cli-help-surface
```

Expected: PASS after every group migration.

- [ ] **Step 4: Reduce `index.ts` to bootstrap**

The final `packages/cli/src/cli/index.ts` should follow this shape:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { loadCliEnv } from './env.js';
import { createCliContext } from './context.js';
import { registerSyncCommands } from './commands/sync.js';
import { registerCodeBlockCommands } from './commands/code-blocks.js';
import { registerMultisdkCommands } from './commands/multisdk.js';
import { registerReferenceCommands } from './commands/reference.js';
import { registerReleaseCommands } from './commands/release.js';
import { registerHarnessCommands } from './commands/harness.js';

const program = new Command();
const envLoadReport = loadCliEnv({ moduleUrl: import.meta.url });
const context = createCliContext(envLoadReport);

program
  .name('md2feishu')
  .description('Sync Markdown, Feishu docs, SDK examples, and SDK reference workflows.')
  .showHelpAfterError();

registerSyncCommands(program, context);
registerCodeBlockCommands(program, context);
registerMultisdkCommands(program, context);
registerReferenceCommands(program, context);
registerReleaseCommands(program, context);
registerHarnessCommands(program, context);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run full static checks**

Run:

```bash
npm run typecheck
npm test -- cli-help-surface
```

Expected: both pass.

### Task 3: Add A Workflow Registry For Humans And Agents

**Files:**
- Create: `packages/cli/src/workflows/registry.ts`
- Create: `packages/cli/src/cli/commands/workflow.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Modify: `apps/docs/agent/non-interactive.md`
- Test: `packages/cli/test/workflow-registry.test.ts`
- Test: `packages/cli/test/workflow-cli.test.ts`

- [ ] **Step 1: Add workflow registry tests**

Create `packages/cli/test/workflow-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getWorkflowRecipe, listWorkflowRecipes } from '../src/workflows/registry.js';

describe('workflow registry', () => {
  it('lists user-story oriented workflows', () => {
    expect(listWorkflowRecipes().map((recipe) => recipe.id)).toEqual([
      'baseline-sync',
      'reviewed-section-sync',
      'multisdk-examples',
      'sdk-reference-authoring',
      'sdk-reference-web-content-release',
      'release-notes'
    ]);
  });

  it('gives concrete next commands for a baseline sync', () => {
    const recipe = getWorkflowRecipe('baseline-sync');
    expect(recipe.title).toBe('Pull Feishu to local Markdown baseline');
    expect(recipe.steps[0].command).toBe('md2feishu doctor auth');
    expect(recipe.steps.some((step) => step.command.includes('md2feishu pull'))).toBe(true);
  });
});
```

- [ ] **Step 2: Implement workflow recipes**

Create `packages/cli/src/workflows/registry.ts`:

```ts
export type WorkflowId =
  | 'baseline-sync'
  | 'reviewed-section-sync'
  | 'multisdk-examples'
  | 'sdk-reference-authoring'
  | 'sdk-reference-web-content-release'
  | 'release-notes';

export type WorkflowStep = {
  id: string;
  purpose: string;
  command: string;
  writes: 'none' | 'local' | 'feishu' | 'external-repo';
  verifies: string;
};

export type WorkflowRecipe = {
  id: WorkflowId;
  title: string;
  whenToUse: string;
  primaryArtifacts: string[];
  steps: WorkflowStep[];
};

const RECIPES: WorkflowRecipe[] = [
  {
    id: 'baseline-sync',
    title: 'Pull Feishu to local Markdown baseline',
    whenToUse: 'Start local iteration from current Feishu content.',
    primaryArtifacts: ['local Markdown file', '.sync/feishu receipt after first successful write'],
    steps: [
      { id: 'auth', purpose: 'Check credentials without printing secrets.', command: 'md2feishu doctor auth', writes: 'none', verifies: 'APP_ID and APP_SECRET are present.' },
      { id: 'pull', purpose: 'Export current Feishu content.', command: 'md2feishu pull <feishu-doc> --output <doc>.remote.md', writes: 'local', verifies: 'The output file exists and is reviewable.' },
      { id: 'status', purpose: 'Compare local Markdown with Feishu.', command: 'md2feishu status <doc>.remote.md <feishu-doc>', writes: 'none', verifies: 'Status is clean or clearly reports no receipt.' }
    ]
  },
  {
    id: 'reviewed-section-sync',
    title: 'Publish one reviewed document section',
    whenToUse: 'Local Markdown changed one heading section and remote Feishu review edits elsewhere must be preserved.',
    primaryArtifacts: ['dry-run patch plan', 'Feishu readback verification'],
    steps: [
      { id: 'diff', purpose: 'Inspect local versus remote changes.', command: 'md2feishu diff <doc.md> <feishu-doc>', writes: 'none', verifies: 'The change scope is small enough for section sync.' },
      { id: 'dry-run', purpose: 'Plan the selected section replacement.', command: 'md2feishu sync <doc.md> <feishu-doc> --section "<heading>"', writes: 'none', verifies: 'Operation is replace-section and block counts look correct.' },
      { id: 'write', purpose: 'Write only the selected section.', command: 'md2feishu sync <doc.md> <feishu-doc> --section "<heading>" --write -y', writes: 'feishu', verifies: 'Readback verification passes.' }
    ]
  },
  {
    id: 'multisdk-examples',
    title: 'Complete and validate multi-language examples',
    whenToUse: 'A Feishu user doc has Python examples and missing Java/Node/Go/REST examples.',
    primaryArtifacts: ['runs/<doc>/task.json', 'manifest.json', 'evidence/', 'trace/events.jsonl', 'grade.md'],
    steps: [
      { id: 'init', purpose: 'Create a task directory and code-block manifest.', command: 'md2feishu multisdk init <feishu-doc> --out runs/<doc-token>', writes: 'local', verifies: 'task.json, manifest.json, snippets, and environment.json exist.' },
      { id: 'tools', purpose: 'Show the allowed operation menu.', command: 'md2feishu harness tools --workflow multisdk', writes: 'none', verifies: 'The agent uses only listed tools.' },
      { id: 'export', purpose: 'Refresh one target language snippet lane.', command: 'md2feishu multisdk export runs/<doc-token> --language <language>', writes: 'local', verifies: 'Language snippets are ready.' },
      { id: 'verify', purpose: 'Record execution evidence.', command: 'md2feishu multisdk verify runs/<doc-token> --language <language> --evidence <log> --command "<command>"', writes: 'local', verifies: 'Evidence is copied and summarized.' },
      { id: 'dry-run', purpose: 'Plan Feishu code-block writes.', command: 'md2feishu multisdk apply runs/<doc-token> --language <language>', writes: 'local', verifies: 'Dry-run report passes.' },
      { id: 'write', purpose: 'Write verified snippets to Feishu.', command: 'md2feishu multisdk apply runs/<doc-token> --language <language> --write -y', writes: 'feishu', verifies: 'Write report passes.' },
      { id: 'audit', purpose: 'Read back and compare Feishu code blocks.', command: 'md2feishu multisdk audit runs/<doc-token> --language <language>', writes: 'local', verifies: 'Audit passes for the language.' },
      { id: 'grade', purpose: 'Summarize task completion and next commands.', command: 'md2feishu harness grade runs/<doc-token> --workflow multisdk', writes: 'local', verifies: 'Result is passed or nextCommands explains remaining work.' }
    ]
  },
  {
    id: 'sdk-reference-authoring',
    title: 'Author and publish SDK reference changes on Feishu',
    whenToUse: 'SDK source tags or scan output indicate Feishu SDK reference docs need updates.',
    primaryArtifacts: ['source freshness report', 'impact matrix', 'reference manifest', 'Feishu apply report', 'Feishu audit report'],
    steps: [
      { id: 'preflight', purpose: 'Check SDK source freshness.', command: 'md2feishu reference preflight --sdk <sdk> --repo <sdk-repo> --version-line <line> --scan-state <scan-state> --format json', writes: 'none', verifies: 'Latest tag and changed paths are explicit.' },
      { id: 'plan', purpose: 'Convert approved impact matrix into a publish manifest.', command: 'md2feishu reference plan --impact impact.json --out reference-manifest.json', writes: 'local', verifies: 'Manifest action count matches planned changes.' },
      { id: 'apply-dry-run', purpose: 'Dry-run Feishu writes.', command: 'md2feishu reference apply --manifest reference-manifest.json', writes: 'none', verifies: 'No failed actions.' },
      { id: 'apply-write', purpose: 'Write approved reference changes.', command: 'md2feishu reference apply --manifest reference-manifest.json --write -y', writes: 'feishu', verifies: 'No failed actions.' },
      { id: 'audit', purpose: 'Read back Feishu and Bitable targets.', command: 'md2feishu reference audit --manifest reference-manifest.json', writes: 'none', verifies: 'Audit passed.' }
    ]
  },
  {
    id: 'sdk-reference-web-content-release',
    title: 'Release audited SDK reference docs to web-content',
    whenToUse: 'A human has decided the Feishu SDK reference draft is ready to publish to the docs website.',
    primaryArtifacts: ['reference manifest', 'Feishu audit report', 'web-content export report', 'PR handoff report'],
    steps: [
      { id: 'audit', purpose: 'Re-check Feishu state before release.', command: 'md2feishu reference audit --manifest reference-manifest.json', writes: 'none', verifies: 'Audit passed for the exact manifest being released.' },
      { id: 'export', purpose: 'Pull audited Feishu output into web-content.', command: 'md2feishu reference export --manifest reference-manifest.json --web-content-repo <repo> --manual <manual>', writes: 'external-repo', verifies: 'diffCheck passed and changed paths are reported.' }
    ]
  },
  {
    id: 'release-notes',
    title: 'Audit and apply Milvus release-note updates',
    whenToUse: 'A Milvus release note Feishu doc must be reconciled with local docs and SDK version variables.',
    primaryArtifacts: ['release task dir', 'sdk/tags.json', 'audit/report.md', 'approval hash'],
    steps: [
      { id: 'init', purpose: 'Create release task state.', command: 'md2feishu release init --release-line <line> --version <version> --release-doc <doc> --milvus-docs <repo> --out runs/releases/<version>', writes: 'local', verifies: 'task.json exists.' },
      { id: 'pull', purpose: 'Snapshot Feishu release notes.', command: 'md2feishu release pull runs/releases/<version>', writes: 'local', verifies: 'feishu/release-notes.remote.md exists.' },
      { id: 'scan', purpose: 'Collect SDK tag matrix.', command: 'md2feishu release scan-sdk-tags runs/releases/<version>', writes: 'local', verifies: 'sdk/tags.json exists.' },
      { id: 'audit', purpose: 'Audit variables, release notes, and user-doc links.', command: 'md2feishu release audit runs/releases/<version>', writes: 'local', verifies: 'audit/report.md shows passed or blockers.' },
      { id: 'approve', purpose: 'Approve exact audit hash.', command: 'md2feishu release approve runs/releases/<version> --by <name>', writes: 'local', verifies: 'approval is recorded for current report hash.' },
      { id: 'apply', purpose: 'Apply approved local docs changes.', command: 'md2feishu release apply runs/releases/<version> --write', writes: 'external-repo', verifies: 'Only planned local docs files changed.' }
    ]
  }
];

export function listWorkflowRecipes(): WorkflowRecipe[] {
  return RECIPES;
}

export function getWorkflowRecipe(id: WorkflowId | string): WorkflowRecipe {
  const recipe = RECIPES.find((item) => item.id === id);
  if (!recipe) throw new Error(`Unknown workflow ${id}. Run md2feishu workflow list.`);
  return recipe;
}
```

- [ ] **Step 3: Add CLI commands**

Create `packages/cli/src/cli/commands/workflow.ts`:

```ts
import type { Command } from 'commander';
import { getWorkflowRecipe, listWorkflowRecipes } from '../../workflows/registry.js';
import { printFormatted } from '../output.js';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('show user-story oriented workflow recipes');

  workflow
    .command('list')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action((opts: { format?: string }) => {
      printFormatted(listWorkflowRecipes().map(({ id, title, whenToUse }) => ({ id, title, whenToUse })), opts.format);
    });

  workflow
    .command('show')
    .argument('<workflow>', 'workflow id')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action((id: string, opts: { format?: string }) => {
      printFormatted(getWorkflowRecipe(id), opts.format);
    });
}
```

Register it from `cli/index.ts`.

- [ ] **Step 4: Add CLI tests**

Create `packages/cli/test/workflow-cli.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('workflow CLI', () => {
  it('prints workflow recipes as JSON', async () => {
    const { stdout } = await execFileAsync('npx', ['tsx', 'src/cli/index.ts', 'workflow', 'list', '--format', 'json'], {
      cwd: new URL('..', import.meta.url)
    });
    const recipes = JSON.parse(stdout) as Array<{ id: string }>;
    expect(recipes.map((recipe) => recipe.id)).toContain('multisdk-examples');
  });
});
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- workflow
npm run typecheck
```

Expected: both pass.

### Task 4: Normalize Task, Trace, And Grade Across Workflows

**Files:**
- Create: `packages/cli/src/harness/task.ts`
- Create: `packages/cli/src/workflows/sync/grader.ts`
- Create: `packages/cli/src/workflows/reference/grader.ts`
- Create: `packages/cli/src/workflows/reference-release/grader.ts`
- Create: `packages/cli/src/workflows/release-notes/grader.ts`
- Modify: `packages/cli/src/harness/tools.ts`
- Modify: `packages/cli/src/harness/multisdk-grade.ts`
- Modify: `packages/cli/src/cli/commands/harness.ts`
- Test: `packages/cli/test/harness-task.test.ts`
- Test: `packages/cli/test/harness-grade-dispatch.test.ts`

- [ ] **Step 1: Define the shared task summary contract**

Create `packages/cli/src/harness/task.ts`:

```ts
export type HarnessWorkflow =
  | 'baseline-sync'
  | 'reviewed-section-sync'
  | 'multisdk-examples'
  | 'multisdk'
  | 'sdk-reference-authoring'
  | 'sdk-reference-web-content-release'
  | 'release-notes';

export type HarnessTaskSummary = {
  kind: 'feishu-harness-task-summary';
  version: 1;
  workflow: HarnessWorkflow;
  taskDir: string | null;
  status: 'not-started' | 'in-progress' | 'dry-run-passed' | 'written' | 'audited' | 'passed' | 'blocked';
  subject: {
    document?: string;
    documentId?: string;
    localPath?: string;
    releaseVersion?: string;
    sdk?: string;
  };
  artifacts: Array<{
    path: string;
    required: boolean;
    exists?: boolean;
  }>;
  nextCommands: string[];
};
```

- [ ] **Step 2: Extend tools registry workflow IDs**

Update `packages/cli/src/harness/tools.ts` so `HarnessWorkflow` comes from `./task.js` and `getHarnessTools()` supports `baseline-sync`, `reviewed-section-sync`, `multisdk-examples`, `sdk-reference-authoring`, `sdk-reference-web-content-release`, and `release-notes`. Keep `multisdk` as a compatibility alias for `multisdk-examples` because existing docs and tests already use `md2feishu harness grade <task-dir> --workflow multisdk`. For non-`multisdk` workflows, start with the command lists already documented in `apps/docs/reference/commands.md`.

- [ ] **Step 3: Add grade dispatcher**

Create a dispatcher in `packages/cli/src/harness/grade.ts`:

```ts
import type { HarnessWorkflow } from './task.js';
import { gradeMultisdkTask } from './multisdk-grade.js';
import { gradeSyncTask } from '../workflows/sync/grader.js';
import { gradeReferenceAuthoringTask } from '../workflows/reference/grader.js';
import { gradeReferenceReleaseTask } from '../workflows/reference-release/grader.js';
import { gradeReleaseNotesTask } from '../workflows/release-notes/grader.js';

export async function gradeHarnessTask(input: { workflow: HarnessWorkflow; taskDir: string }) {
  if (input.workflow === 'multisdk' || input.workflow === 'multisdk-examples') {
    return gradeMultisdkTask({ taskDir: input.taskDir });
  }
  if (input.workflow === 'baseline-sync' || input.workflow === 'reviewed-section-sync') {
    return gradeSyncTask({ taskDir: input.taskDir, workflow: input.workflow });
  }
  if (input.workflow === 'sdk-reference-authoring') return gradeReferenceAuthoringTask({ taskDir: input.taskDir });
  if (input.workflow === 'sdk-reference-web-content-release') return gradeReferenceReleaseTask({ taskDir: input.taskDir });
  return gradeReleaseNotesTask({ taskDir: input.taskDir });
}
```

- [ ] **Step 4: Add minimal graders for sync/reference/release**

Each new grader should return the same grade shape as `multisdk` and start conservative:

```ts
export async function gradeSyncTask(input: { taskDir: string; workflow: 'baseline-sync' | 'reviewed-section-sync' }) {
  return {
    kind: 'feishu-harness-grade' as const,
    version: 1 as const,
    workflow: input.workflow,
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete' as const,
    checks: [
      {
        id: 'sync-harness-v1',
        passed: false,
        severity: 'incomplete' as const,
        message: 'Sync harness grading requires receipt and patch-plan adapters before this workflow can be graded as passed.'
      }
    ],
    nextCommands: [`md2feishu workflow show ${input.workflow}`]
  };
}
```

Create `packages/cli/src/workflows/reference/grader.ts`:

```ts
export async function gradeReferenceAuthoringTask(input: { taskDir: string }) {
  return {
    kind: 'feishu-harness-grade' as const,
    version: 1 as const,
    workflow: 'sdk-reference-authoring' as const,
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete' as const,
    checks: [
      {
        id: 'reference-authoring-harness-v1',
        passed: false,
        severity: 'incomplete' as const,
        message: 'Reference authoring grading requires manifest, Feishu apply, and Feishu audit adapters before this workflow can be graded as passed.'
      }
    ],
    nextCommands: ['md2feishu workflow show sdk-reference-authoring']
  };
}
```

Create `packages/cli/src/workflows/reference-release/grader.ts`:

```ts
export async function gradeReferenceReleaseTask(input: { taskDir: string }) {
  return {
    kind: 'feishu-harness-grade' as const,
    version: 1 as const,
    workflow: 'sdk-reference-web-content-release' as const,
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete' as const,
    checks: [
      {
        id: 'reference-release-harness-v1',
        passed: false,
        severity: 'incomplete' as const,
        message: 'Reference release grading requires explicit human release intent plus Feishu audit and web-content export adapters.'
      }
    ],
    nextCommands: ['md2feishu workflow show sdk-reference-web-content-release']
  };
}
```

Create `packages/cli/src/workflows/release-notes/grader.ts`:

```ts
export async function gradeReleaseNotesTask(input: { taskDir: string }) {
  return {
    kind: 'feishu-harness-grade' as const,
    version: 1 as const,
    workflow: 'release-notes' as const,
    taskDir: input.taskDir,
    generatedAt: new Date().toISOString(),
    result: 'incomplete' as const,
    checks: [
      {
        id: 'release-notes-harness-v1',
        passed: false,
        severity: 'incomplete' as const,
        message: 'Release notes grading requires release task, audit report, approval hash, and apply-state adapters.'
      }
    ],
    nextCommands: ['md2feishu workflow show release-notes']
  };
}
```

- [ ] **Step 5: Wire `harness grade` through the dispatcher**

Modify the harness command so `--workflow` accepts all workflow IDs and calls `gradeHarnessTask`.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- harness
npm run typecheck
```

Expected: existing `multisdk` harness tests still pass; new dispatcher tests pass.

### Task 5: Add Official Feishu Markdown Adapter

**Files:**
- Create: `packages/cli/src/services/feishu/docs-content-client.ts`
- Create: `packages/cli/src/services/feishu/block-convert-client.ts`
- Create: `packages/cli/src/markdown/engine.ts`
- Modify: `packages/cli/src/sync/pull.ts`
- Modify: `packages/cli/src/sync/run-sync.ts`
- Modify: `packages/cli/src/sync/status.ts`
- Modify: `packages/cli/src/cli/commands/sync.ts` after Task 2, or `packages/cli/src/cli/index.ts` if Task 2 has not landed yet
- Test: `packages/cli/test/official-markdown-engine.test.ts`
- Test: `packages/cli/test/pull.test.ts`
- Test: `packages/cli/test/sync.test.ts`

- [ ] **Step 1: Add Markdown engine types**

Create `packages/cli/src/markdown/engine.ts`:

```ts
import type { FeishuBlock } from '../feishu/types.js';

export type MarkdownEngineName = 'local' | 'official' | 'auto';

export type MarkdownExportInput = {
  documentId: string;
  fallbackBlocks: FeishuBlock[];
};

export type MarkdownImportInput = {
  markdown: string;
};

export type MarkdownEngine = {
  name: MarkdownEngineName;
  exportMarkdown(input: MarkdownExportInput): Promise<{
    markdown: string;
    engine: 'local' | 'official';
    warnings: string[];
  }>;
  importMarkdown(input: MarkdownImportInput): Promise<{
    blocks: FeishuBlock[];
    engine: 'local' | 'official';
    warnings: string[];
  }>;
};
```

- [ ] **Step 2: Add official docs content client**

Create `packages/cli/src/services/feishu/docs-content-client.ts`:

```ts
export type DocsContentClient = {
  getMarkdownContent(documentId: string): Promise<string>;
};

export class FeishuDocsContentClient implements DocsContentClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async getMarkdownContent(documentId: string): Promise<string> {
    const params = new URLSearchParams({
      doc_token: documentId,
      doc_type: 'docx',
      content_type: 'markdown'
    });
    const data = await this.request<{ content?: string }>('GET', `/open-apis/docs/v1/content?${params.toString()}`);
    if (typeof data.content !== 'string') {
      throw new Error(`Feishu Markdown export returned no content for ${documentId}.`);
    }
    return data.content;
  }
}
```

- [ ] **Step 3: Add official block convert client**

Create `packages/cli/src/services/feishu/block-convert-client.ts`:

```ts
import type { FeishuBlock } from '../../feishu/types.js';

export type BlockConvertClient = {
  markdownToBlocks(markdown: string): Promise<FeishuBlock[]>;
};

export class FeishuBlockConvertClient implements BlockConvertClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async markdownToBlocks(markdown: string): Promise<FeishuBlock[]> {
    const data = await this.request<{ blocks?: FeishuBlock[] }>(
      'POST',
      '/open-apis/docx/v1/documents/blocks/convert',
      {
        content_type: 'markdown',
        content: markdown
      }
    );
    return data.blocks ?? [];
  }
}
```

- [ ] **Step 4: Add engine tests with fake official clients**

Create `packages/cli/test/official-markdown-engine.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { createMarkdownEngine } from '../src/markdown/engine.js';

describe('official Markdown engine', () => {
  it('uses official export in auto mode when it succeeds', async () => {
    const engine = createMarkdownEngine({
      mode: 'auto',
      official: {
        getMarkdownContent: vi.fn().mockResolvedValue('# Official\n'),
        markdownToBlocks: vi.fn()
      }
    });

    await expect(engine.exportMarkdown({ documentId: 'doc', fallbackBlocks: [] })).resolves.toMatchObject({
      markdown: '# Official\n',
      engine: 'official',
      warnings: []
    });
  });

  it('falls back to local export in auto mode when official export fails', async () => {
    const blocks = markdownToFeishuBlocks('# Local\n');
    const engine = createMarkdownEngine({
      mode: 'auto',
      official: {
        getMarkdownContent: vi.fn().mockRejectedValue(new Error('unsupported')),
        markdownToBlocks: vi.fn()
      }
    });

    const result = await engine.exportMarkdown({ documentId: 'doc', fallbackBlocks: blocks });
    expect(result.engine).toBe('local');
    expect(result.markdown).toContain('# Local');
    expect(result.warnings[0]).toContain('official Markdown export failed');
  });
});
```

- [ ] **Step 5: Implement `createMarkdownEngine()`**

Update `packages/cli/src/markdown/engine.ts` to export `createMarkdownEngine()` that composes:

- `feishuBlocksToMarkdown()` for local export fallback.
- `markdownToFeishuBlocks()` for local import fallback.
- `DocsContentClient.getMarkdownContent()` for official export.
- `BlockConvertClient.markdownToBlocks()` for official import.

In `auto` mode, official failure should warn and fall back. In `official` mode, official failure should throw.

- [ ] **Step 6: Wire pull/status/diff/merge/sync through the engine**

Add `--markdown-engine <engine>` to `pull`, `status`, `diff`, `merge`, root shorthand, and `sync`.

Rollout behavior:

- Add `--markdown-engine official` for strict official-only dogfooding.
- Add `--markdown-engine local` for compatibility and deterministic debugging.
- Add `--markdown-engine auto` as the intended default behavior: official first, local fallback.
- Keep the repo's initial implementation default configurable if needed, but the release target is `auto` after the smoke checklist passes.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test -- official-markdown-engine
npm test -- pull
npm test -- sync
npm run typecheck
```

Expected: all pass.

- [ ] **Step 8: Add a live smoke checklist, not a normal unit test**

Add a docs checklist under `apps/docs/internals/feishu-api-notes.md`:

```md
## Official Markdown API Smoke Checklist

- Export a reviewed doc with `--markdown-engine official`.
- Compare against local block export with `md2feishu diff`.
- Confirm code fences retain language labels for Python, Java, JavaScript, Go, and REST.
- Confirm tables are usable for docs authoring.
- Confirm images either round-trip or produce an explicit warning.
- Convert the same Markdown through official block convert and local convert.
- Dry-run section sync with official import blocks.
- Write only to a disposable Feishu doc before enabling `auto` as the default.
```

### Task 6: Refactor Sync Around A Safer Patch Planner

**Files:**
- Create: `packages/cli/src/workflows/sync/task.ts`
- Create: `packages/cli/src/workflows/sync/planner.ts`
- Create: `packages/cli/src/workflows/sync/runner.ts`
- Move or re-export: `packages/cli/src/sync/section.ts`
- Move or re-export: `packages/cli/src/sync/preflight.ts`
- Modify: `packages/cli/src/sync/run-sync.ts`
- Modify: `packages/cli/src/sync/patch.ts`
- Test: `packages/cli/test/sync-planner.test.ts`
- Test: `packages/cli/test/sync.test.ts`
- Test: `packages/cli/test/section.test.ts`
- Test: `packages/cli/test/preflight.test.ts`

- [ ] **Step 1: Define explicit sync patch operations**

Create `packages/cli/src/workflows/sync/planner.ts` with this public type:

```ts
import type { FeishuBlock } from '../../feishu/types.js';

export type SyncPatchOperation =
  | {
    kind: 'noop';
    reason: string;
  }
  | {
    kind: 'replace-document';
    deleteCount: number;
    createCount: number;
  }
  | {
    kind: 'replace-section';
    title: string;
    remoteStartIndex: number;
    remoteEndIndex: number;
    localStartIndex: number;
    localEndIndex: number;
    deleteCount: number;
    createCount: number;
  }
  | {
    kind: 'replace-contiguous-blocks';
    remoteStartIndex: number;
    remoteEndIndex: number;
    localStartIndex: number;
    localEndIndex: number;
    deleteCount: number;
    createCount: number;
  };

export type SyncPatchPlanV2 = {
  kind: 'feishu-sync-patch-plan';
  version: 2;
  currentHash: string;
  desiredHash: string;
  operation: SyncPatchOperation;
  currentChildren: FeishuBlock[];
  replacementBlocks: FeishuBlock[];
  expectedChildren: FeishuBlock[];
  warnings: string[];
};
```

- [ ] **Step 2: Write planner tests for small contiguous diffs**

Create `packages/cli/test/sync-planner.test.ts` with cases for:

```ts
import { describe, expect, it } from 'vitest';
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import { planSyncPatch } from '../src/workflows/sync/planner.js';

describe('sync patch planner', () => {
  it('plans noop when current and desired blocks match', () => {
    const blocks = markdownToFeishuBlocks('# Title\n\nBody\n');
    expect(planSyncPatch({ currentChildren: blocks, desiredChildren: blocks }).operation.kind).toBe('noop');
  });

  it('plans a contiguous block replacement for a small body edit', () => {
    const current = markdownToFeishuBlocks('# Title\n\nOld body\n\n## Next\n\nSame\n');
    const desired = markdownToFeishuBlocks('# Title\n\nNew body\n\n## Next\n\nSame\n');
    const plan = planSyncPatch({ currentChildren: current, desiredChildren: desired });
    expect(plan.operation).toMatchObject({
      kind: 'replace-contiguous-blocks',
      remoteStartIndex: 1,
      remoteEndIndex: 2,
      localStartIndex: 1,
      localEndIndex: 2,
      deleteCount: 1,
      createCount: 1
    });
  });

  it('falls back to replace-document when too much changed', () => {
    const current = markdownToFeishuBlocks('# A\n\nOne\n\n## B\n\nTwo\n');
    const desired = markdownToFeishuBlocks('# X\n\nAlpha\n\n## Y\n\nBeta\n');
    expect(planSyncPatch({ currentChildren: current, desiredChildren: desired }).operation.kind).toBe('replace-document');
  });
});
```

- [ ] **Step 3: Implement `planSyncPatch()`**

Implement the planner by:

1. Hashing full current and desired children.
2. Returning `noop` when hashes match.
3. Reusing the existing unique heading logic when `section` is provided.
4. Finding common prefix and suffix block hashes for non-section sync.
5. Returning `replace-contiguous-blocks` when the changed window is small and both unchanged sides are non-empty.
6. Falling back to `replace-document` for large or ambiguous diffs.

The small-window threshold should be conservative:

```ts
const DEFAULT_MAX_CONTIGUOUS_REPLACE_BLOCKS = 12;
```

- [ ] **Step 4: Adapt `applyPatch()` to the V2 plan**

Keep the current create-before-delete safety rule. For `replace-contiguous-blocks`, create at `remoteEndIndex`, verify Feishu created the requested count, then delete `[remoteStartIndex, remoteEndIndex)`.

- [ ] **Step 5: Preserve existing receipt and section behavior**

Run:

```bash
npm test -- sync
npm test -- section
npm test -- preflight
```

Expected: all current safety tests pass, including “section writes do not update the whole-document receipt.”

- [ ] **Step 6: Expose the new plan in dry-run output**

Update `runSyncCommand()` printing so dry-run shows:

```text
operation: replace-contiguous-blocks
remote range: 12..15
local range: 12..14
will delete: 3
will create: 2
```

Run:

```bash
npm test -- sync
npm run typecheck
```

Expected: tests and typecheck pass.

### Task 7: Split The Feishu Gateway By API Surface And Reliability Policy

**Files:**
- Create: `packages/cli/src/services/feishu/errors.ts`
- Create: `packages/cli/src/services/feishu/retry.ts`
- Create: `packages/cli/src/services/feishu/docx-client.ts`
- Create: `packages/cli/src/services/feishu/docs-content-client.ts`
- Create: `packages/cli/src/services/feishu/block-convert-client.ts`
- Create: `packages/cli/src/services/feishu/drive-client.ts`
- Create: `packages/cli/src/services/feishu/bitable-client.ts`
- Modify: `packages/cli/src/feishu/client.ts`
- Test: `packages/cli/test/feishu-client.test.ts`
- Test: `packages/cli/test/feishu-retry.test.ts`

- [ ] **Step 1: Add retry policy tests**

Create `packages/cli/test/feishu-retry.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { withFeishuRetry } from '../src/services/feishu/retry.js';
import { FeishuApiError } from '../src/services/feishu/errors.js';

describe('Feishu retry policy', () => {
  it('retries rate-limited requests and then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new FeishuApiError('rate limited', { code: 99991400, status: 429 }))
      .mockResolvedValueOnce('ok');

    await expect(withFeishuRetry(fn, { sleep: async () => undefined })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry validation errors', async () => {
    const fn = vi.fn().mockRejectedValue(new FeishuApiError('bad request', { code: 230001, status: 400 }));
    await expect(withFeishuRetry(fn, { sleep: async () => undefined })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Implement typed errors**

Create `packages/cli/src/services/feishu/errors.ts`:

```ts
export type FeishuApiErrorInput = {
  code?: number;
  status?: number;
  method?: string;
  path?: string;
  requestId?: string;
  responseBody?: unknown;
};

export class FeishuApiError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  readonly requestId?: string;
  readonly responseBody?: unknown;

  constructor(message: string, input: FeishuApiErrorInput = {}) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = input.code;
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.requestId = input.requestId;
    this.responseBody = input.responseBody;
  }
}
```

- [ ] **Step 3: Implement retry helper**

Create `packages/cli/src/services/feishu/retry.ts`:

```ts
import { FeishuApiError } from './errors.js';

export type FeishuRetryOptions = {
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function withFeishuRetry<T>(
  operation: () => Promise<T>,
  options: FeishuRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableFeishuError(error)) break;
      await sleep(250 * attempt);
    }
  }

  throw lastError;
}

function isRetryableFeishuError(error: unknown): boolean {
  return error instanceof FeishuApiError &&
    (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504);
}
```

- [ ] **Step 4: Extract docx/Drive/Bitable clients behind the existing facade**

Keep `FeishuClient` as the public facade for compatibility. Internally delegate docx methods to `DocxClient`, Drive methods to `DriveClient`, and Bitable methods to `BitableClient`. Do not change `FeishuDocClient` tests or workflow imports in this step.

- [ ] **Step 5: Run Feishu tests and full typecheck**

Run:

```bash
npm test -- feishu-client
npm test -- feishu-retry
npm run typecheck
```

Expected: all pass.

### Task 8: Expand Markdown Preflight Into A Structured Publish Report

**Files:**
- Create: `packages/cli/src/services/markdown/preflight.ts`
- Modify: `packages/cli/src/markdown/blocks.ts`
- Modify: `packages/cli/src/sync/preflight.ts`
- Modify: `packages/cli/src/sync/status.ts`
- Modify: `packages/cli/src/sync/run-sync.ts`
- Test: `packages/cli/test/markdown-preflight.test.ts`
- Test: `packages/cli/test/preflight.test.ts`

- [ ] **Step 1: Add report tests**

Create `packages/cli/test/markdown-preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildMarkdownPreflightReport } from '../src/services/markdown/preflight.js';

describe('Markdown publish preflight', () => {
  it('reports unsupported local links before Feishu writes', () => {
    const report = buildMarkdownPreflightReport('See [local](./local.md) and [anchor](#section).\n');
    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['unsupported-link-url', 'unsupported-link-url']);
  });

  it('accepts absolute http links', () => {
    const report = buildMarkdownPreflightReport('See [docs](https://milvus.io/docs/).\n');
    expect(report.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Implement structured preflight report**

Create `packages/cli/src/services/markdown/preflight.ts`:

```ts
import { markdownToFeishuBlocks } from '../../markdown/blocks.js';
import { validateFeishuBlocksForWrite, type FeishuPreflightIssue } from '../../sync/preflight.js';

export type MarkdownPreflightReport = {
  kind: 'markdown-publish-preflight';
  version: 1;
  passed: boolean;
  issues: FeishuPreflightIssue[];
};

export function buildMarkdownPreflightReport(markdown: string): MarkdownPreflightReport {
  const issues = validateFeishuBlocksForWrite(markdownToFeishuBlocks(markdown));
  return {
    kind: 'markdown-publish-preflight',
    version: 1,
    passed: issues.length === 0,
    issues
  };
}
```

- [ ] **Step 3: Print preflight issues in dry-run/status JSON**

Update `status` and `sync` dry-run JSON output to include `preflight.passed` and `preflight.issues`. Pretty output should keep the existing concise error behavior unless `--format json` is used.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- markdown-preflight
npm test -- preflight
npm run typecheck
```

Expected: all pass.

### Task 9: Restructure Docs Around One Workflow Source

**Files:**
- Modify: `packages/cli/README.md`
- Modify: `apps/docs/guide/quickstart.md`
- Create: `apps/docs/guide/workflows.md`
- Create: `apps/docs/internals/docs-architecture.md`
- Create: `apps/docs/reference/safety-gates.md`
- Modify: `apps/docs/guide/baseline-sync.md`
- Modify: `apps/docs/guide/section-sync.md`
- Modify: `apps/docs/guide/multisdk-workflow.md`
- Modify: `apps/docs/guide/sdk-reference-workflow.md`
- Modify: `apps/docs/guide/sdk-reference-release-workflow.md`
- Modify: `apps/docs/guide/release-workflow.md`
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/agent/non-interactive.md`
- Modify: `apps/docs/agent/skill-roadmap.md`
- Modify: `apps/docs/agent/skills/*.md`
- Modify: `apps/docs/.vitepress/config.ts`

- [ ] **Step 1: Define docs architecture**

Create `apps/docs/internals/docs-architecture.md`:

```md
# Docs Architecture

The documentation has one source of workflow truth: `md2feishu workflow show <workflow-id>`.

Human-facing docs and agent-facing docs may have different entry pages, but they must not duplicate workflow command sequences, safety gates, or completion criteria. They should link to the same workflow pages and reference tables.

## Layers

| Layer | Audience | Purpose |
| --- | --- | --- |
| Quickstart | Human users | Choose the right workflow and run the first command. |
| Workflow guide | Humans and agents | Explain workflow intent, artifacts, safety gates, and completion state. |
| Command reference | Humans needing exact flags | Document command syntax, not workflow strategy. |
| Agent skills | Agents | Select workflow, enforce boundaries, and call CLI recipes. |
| Internals | Maintainers | Explain architecture, receipts, harness, Feishu API behavior, and release checks. |

## Duplication Rule

If a command sequence appears in more than one page, replace the duplicate with a link to the workflow guide or `md2feishu workflow show <workflow-id>`.

## URL Compatibility

Keep existing guide and skill URLs where possible. Old pages may remain as short entry points, but they must not become separate workflow sources.
```

- [ ] **Step 2: Create one workflow guide**

Create `apps/docs/guide/workflows.md`:

````md
# Workflows

Use workflows instead of memorizing command combinations.

```bash
md2feishu workflow list
md2feishu workflow show <workflow-id>
```

| Workflow | Use when | Starts with |
| --- | --- | --- |
| `baseline-sync` | Pull current Feishu content into local Markdown before editing. | `md2feishu workflow show baseline-sync` |
| `reviewed-section-sync` | Replace one reviewed Feishu section from local Markdown. | `md2feishu workflow show reviewed-section-sync` |
| `multisdk-examples` | Complete and validate Java, JavaScript, Go, or REST examples from Python examples. | `md2feishu workflow show multisdk-examples` |
| `sdk-reference-authoring` | Plan, write, and audit SDK reference changes on Feishu. | `md2feishu workflow show sdk-reference-authoring` |
| `sdk-reference-web-content-release` | Release audited SDK reference docs to `web-content` after human approval. | `md2feishu workflow show sdk-reference-web-content-release` |
| `release-notes` | Audit and apply Milvus release-note changes. | `md2feishu workflow show release-notes` |

Workflow details are generated from the CLI registry. If this page and CLI output disagree, update this page or the registry in the same change.
````

- [ ] **Step 3: Rewrite quickstart around workflows**

Update the quickstart top section to start with these choices:

```md
## Choose a workflow

- Pull Feishu into Markdown: `md2feishu workflow show baseline-sync`
- Publish one reviewed section: `md2feishu workflow show reviewed-section-sync`
- Complete multi-SDK examples: `md2feishu workflow show multisdk-examples`
- Author SDK reference changes on Feishu: `md2feishu workflow show sdk-reference-authoring`
- Release audited SDK references to web-content: `md2feishu workflow show sdk-reference-web-content-release`
- Audit release notes: `md2feishu workflow show release-notes`
```

- [ ] **Step 4: Move safety gates into one reference page**

Create `apps/docs/reference/safety-gates.md`:

```md
# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `sync`, `code-blocks apply`, `multisdk apply`, `reference apply`, `release apply` | Prevent accidental writes. |
| `--write` + confirmation | Feishu and local docs writes | Requires explicit user intent. |
| Receipt conflict check | whole-document `sync` | Prevent overwriting remote edits. |
| Section uniqueness | `sync --section` | Prevent ambiguous partial writes. |
| Validation evidence | `multisdk apply --write` | Prevent untested snippets from reaching Feishu. |
| Report hash approval | `release apply --write` | Prevent stale audit approvals. |
| Human release trigger | `sdk-reference-web-content-release` | Prevent authoring tasks from touching `web-content` prematurely. |
| Readback audit | `sync`, `multisdk`, `reference` | Prove remote state matches the plan. |
```

Replace duplicated safety tables in `apps/docs/reference/commands.md` and `apps/docs/agent/non-interactive.md` with links to this page.

- [ ] **Step 5: Update agent docs to call workflow recipes first**

`apps/docs/agent/non-interactive.md` should state:

```md
Run `md2feishu workflow show <workflow-id> --format json` before choosing commands. Use the returned steps as the allowed sequence unless the user explicitly asks for a lower-level operation.
```

- [ ] **Step 6: Collapse old workflow pages into thin entry points**

Audit these pages and replace duplicated step-by-step workflow content with links to `apps/docs/guide/workflows.md`, `apps/docs/reference/safety-gates.md`, `apps/docs/reference/commands.md`, or the relevant workflow skill page:

```text
apps/docs/guide/baseline-sync.md
apps/docs/guide/section-sync.md
apps/docs/guide/multisdk-workflow.md
apps/docs/guide/sdk-reference-workflow.md
apps/docs/guide/sdk-reference-release-workflow.md
apps/docs/guide/release-workflow.md
apps/docs/agent/non-interactive.md
apps/docs/agent/skills/*.md
```

Keep command-specific flag details in `apps/docs/reference/commands.md`.

Each retained guide page should follow this shape:

````md
# <Workflow Name>

Use this page as a stable URL for the workflow. The canonical step sequence comes from:

```bash
md2feishu workflow show <workflow-id>
```

- Workflow index: [Workflows](/guide/workflows)
- Safety gates: [Safety Gates](/reference/safety-gates)
- Command flags: [Commands](/reference/commands)
````

Do not remove pages from the sidebar in the same change unless they are replaced by an obvious workflow index link. This keeps old bookmarks usable while eliminating duplicated runbooks.

- [ ] **Step 7: Build docs**

Run:

```bash
npm run docs:build
```

Expected: docs build passes.

### Task 10: Package Workflows As Agent Skills

**Files:**
- Create: `apps/docs/agent/skills/feishu-baseline-sync.md`
- Create: `apps/docs/agent/skills/feishu-reviewed-section-sync.md`
- Create: `apps/docs/agent/skills/feishu-multisdk-examples.md`
- Create: `apps/docs/agent/skills/feishu-sdk-reference-authoring.md`
- Create: `apps/docs/agent/skills/feishu-sdk-reference-release.md`
- Create: `apps/docs/agent/skills/feishu-release-notes.md`
- Create: `apps/docs/agent/skills/legacy.md`
- Modify: `apps/docs/agent/skills/feishu-markdown-pull.md`
- Modify: `apps/docs/agent/skills/feishu-markdown-push.md`
- Modify: `apps/docs/agent/skills/feishu-codeblock-writer.md`
- Modify: `apps/docs/agent/skills/milvus-multisdk-example-sync.md`
- Modify: `apps/docs/agent/skills/sdk-reference-publisher.md`
- Modify: `apps/docs/agent/skills/milvus-release-notes-workflow.md`
- Modify: `apps/docs/agent/skill-roadmap.md`
- Modify: `apps/docs/agent/non-interactive.md`
- Test: `packages/cli/test/workflow-registry.test.ts`

- [ ] **Step 1: Define the skill packaging rule**

Add this rule to `apps/docs/agent/non-interactive.md`:

```md
## Workflow Skills

Each first-class workflow has a matching agent skill. The skill is responsible for choosing the workflow, loading `md2feishu workflow show <workflow-id> --format json`, preserving safety gates, and stopping at human approval boundaries.

The CLI remains the source of truth for execution. Skills must not duplicate command sequences manually when `workflow show` can provide them.

Legacy operation-specific skills should redirect to workflow skills. Keep legacy pages only as compatibility aliases until external agent installations have migrated.
```

- [ ] **Step 2: Create baseline sync skill**

Create `apps/docs/agent/skills/feishu-baseline-sync.md`:

````md
---
name: feishu-baseline-sync
description: Use when pulling a Feishu doc into local Markdown as a baseline before editing or comparing changes
---

# Feishu Baseline Sync

## Required Discovery

Run:

```bash
md2feishu workflow show baseline-sync --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Do not write to Feishu in this workflow.
- Prefer official-first Markdown behavior when the CLI default supports it.
- Save pulled Markdown to an explicit output path.
- After pull, run status or diff before suggesting any write workflow.

## Completion

The workflow is complete when the local Markdown baseline exists and the user knows whether it matches the current Feishu document.
````

- [ ] **Step 3: Create reviewed section sync skill**

Create `apps/docs/agent/skills/feishu-reviewed-section-sync.md`:

````md
---
name: feishu-reviewed-section-sync
description: Use when only one reviewed Feishu document section should be updated from local Markdown while preserving the rest of the remote doc
---

# Feishu Reviewed Section Sync

## Required Discovery

Run:

```bash
md2feishu workflow show reviewed-section-sync --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Start with `diff`.
- Dry-run `sync --section` before any write.
- The section heading must be unique locally and remotely.
- Do not use whole-document `sync --write` unless the user explicitly changes the task.
- Section writes do not update the whole-document receipt; explain this if the user asks about later status output.

## Completion

The workflow is complete when the selected section write passes readback verification.
````

- [ ] **Step 4: Create multi-SDK examples skill**

Create `apps/docs/agent/skills/feishu-multisdk-examples.md`:

````md
---
name: feishu-multisdk-examples
description: Use when completing Java, JavaScript, Go, or REST examples in a Feishu doc based on existing Python examples
---

# Feishu Multi-SDK Examples

## Required Discovery

Run:

```bash
md2feishu workflow show multisdk-examples --format json
md2feishu harness tools --workflow multisdk --format json
```

Use the workflow steps and harness tool registry as the allowed command menu.

## Safety Rules

- Work inside the task directory created by `multisdk init`.
- Do not write snippets to Feishu until verification evidence is recorded.
- Run dry-run apply before `--write`.
- Run readback audit after write.
- Finish with `md2feishu harness grade <task-dir> --workflow multisdk`.

## Completion

The workflow is complete when the target language lanes are audited and the harness grade is `passed` or clearly reports only user-approved incomplete lanes.
````

- [ ] **Step 5: Create SDK reference authoring skill**

Create `apps/docs/agent/skills/feishu-sdk-reference-authoring.md`:

````md
---
name: feishu-sdk-reference-authoring
description: Use when SDK reference changes need to be planned, written, and audited on Feishu without releasing to web-content
---

# Feishu SDK Reference Authoring

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-authoring --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Start with source freshness preflight.
- Do not accept a no-action plan unless source freshness evidence supports it.
- Dry-run `reference apply` before `--write`.
- Run `reference audit` after Feishu writes.
- Do not run `reference export`, `reference web-content`, or `reference release run` in this skill.

## Completion

The workflow is complete when Feishu reference changes are written and audited. Releasing to `web-content` is a separate human-triggered workflow.
````

- [ ] **Step 6: Create SDK reference release skill**

Create `apps/docs/agent/skills/feishu-sdk-reference-release.md`:

````md
---
name: feishu-sdk-reference-release
description: Use when a human has approved audited Feishu SDK reference docs for release to the web-content repository
---

# Feishu SDK Reference Release

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-web-content-release --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Confirm the user is explicitly starting the release workflow.
- Re-run `reference audit` for the exact manifest before export.
- Export only into the user-provided `web-content` checkout.
- Report changed files and handoff commands; do not stage, commit, push, or open a PR unless the user explicitly asks.

## Completion

The workflow is complete when the audited Feishu reference content has been exported to `web-content` and the handoff report identifies the changed files.
````

- [ ] **Step 7: Create release notes skill**

Create `apps/docs/agent/skills/feishu-release-notes.md`:

````md
---
name: feishu-release-notes
description: Use when Milvus release notes from Feishu need SDK tag, Variables, user-doc link, and local docs audit before apply
---

# Feishu Release Notes

## Required Discovery

Run:

```bash
md2feishu workflow show release-notes --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Pull Feishu release notes into the task directory before auditing.
- Scan SDK tags before auditing Variables.
- Do not run `release apply --write` until the current report hash is approved.
- If audit blockers exist, report them and stop before write.

## Completion

The workflow is complete when approved release-note changes are applied to the local Milvus docs checkout or blockers are clearly reported.
````

- [ ] **Step 8: Mark older operation-specific skills as legacy aliases**

Create `apps/docs/agent/skills/legacy.md`:

```md
# Legacy Skill Aliases

These older operation-specific skill pages are retained only as compatibility aliases. New agent work should use workflow skills.

| Legacy skill | Replacement workflow skill |
| --- | --- |
| `feishu-markdown-pull` | `feishu-baseline-sync` |
| `feishu-markdown-push` | `feishu-reviewed-section-sync` for partial reviewed-doc writes; workflow registry for other sync cases |
| `feishu-codeblock-writer` | `feishu-multisdk-examples` when completing SDK examples; low-level code-block operations only when explicitly requested |
| `milvus-multisdk-example-sync` | `feishu-multisdk-examples` |
| `sdk-reference-publisher` | `feishu-sdk-reference-authoring`; `feishu-sdk-reference-release` only after explicit human release intent |
| `milvus-release-notes-workflow` | `feishu-release-notes` |
```

At the top of each legacy skill page, add the concrete replacement message:

```md
> Legacy alias: prefer `feishu-baseline-sync` for new agent runs. This page is retained for compatibility and should not be expanded with new workflow logic.
```

```md
> Legacy alias: prefer `feishu-reviewed-section-sync` for reviewed section writes. For other sync cases, run `md2feishu workflow list` and select the matching workflow.
```

```md
> Legacy alias: prefer `feishu-multisdk-examples` for SDK example completion. Use low-level code-block commands only when the user explicitly asks for block-level operations.
```

For `sdk-reference-publisher`, use:

```md
> Legacy alias: use `feishu-sdk-reference-authoring` for Feishu writing/audit. Use `feishu-sdk-reference-release` only after the user explicitly starts web-content release.
```

For `milvus-release-notes-workflow`, use:

```md
> Legacy alias: prefer `feishu-release-notes` for new release-note audit and apply runs.
```

- [ ] **Step 9: Add pressure scenarios to the roadmap**

Update `apps/docs/agent/skill-roadmap.md` with these test scenarios:

```md
## Workflow Skill Pressure Scenarios

- Baseline sync: agent must not write to Feishu after pull unless the user switches workflows.
- Reviewed section sync: agent must not use whole-document write when the user asks for one section.
- Multi-SDK examples: agent must not write unverified snippets.
- SDK reference authoring: agent must stop after Feishu audit and must not export to `web-content`.
- SDK reference release: agent must require explicit human release intent before touching `web-content`.
- Release notes: agent must not apply local docs changes without approval of the current report hash.
```

- [ ] **Step 10: Verify workflow IDs and docs**

Run:

```bash
npm test -- workflow
npm run docs:build
```

Expected: all workflow IDs referenced by skill pages exist in the workflow registry and docs build passes.

### Task 11: Final Verification And Release Readiness

**Files:**
- Modify only files touched by prior tasks.

- [ ] **Step 1: Run the focused workflow tests**

Run:

```bash
npm test -- sync
npm test -- section
npm test -- preflight
npm test -- multisdk
npm test -- reference
npm test -- release
npm test -- harness
npm test -- workflow
```

Expected: all pass.

- [ ] **Step 2: Run full checks**

Run:

```bash
npm run typecheck
npm test
npm run docs:build
```

Expected: all pass.

- [ ] **Step 3: Manually inspect top-level help**

Run:

```bash
npm run dev -- --help
npm run dev -- workflow list
npm run dev -- harness tools --workflow multisdk --format json
```

Expected:

- Help still exposes existing top-level workflows.
- `workflow list` prints the six user-story workflows.
- Harness tools still returns the multi-SDK tool menu.

- [ ] **Step 4: Update the capability inventory**

After implementation, update `apps/docs/internals/capability-inventory.md` so the “Known gaps” section reflects only remaining gaps. Do not claim block-level sync is implemented unless `sync-planner.test.ts` proves it.

## Sequencing Guidance

Implement in this order:

1. Behavior lock and inventory.
2. CLI split with no behavior change.
3. Workflow registry and user-facing discovery.
4. Harness normalization.
5. Official Markdown adapter evaluation.
6. Sync planner improvements.
7. Feishu gateway reliability split.
8. Markdown preflight reports.
9. Docs restructure around one workflow source.
10. Workflow skill packaging.
11. Full verification.

This order avoids changing Feishu write semantics while the command surface is being moved. The first behavior-changing task is Task 5, after command registration and workflow discovery are under test.

## Completion Criteria

The refactor is complete when current evidence proves all of the following:

- `packages/cli/src/cli/index.ts` is a thin bootstrap and command groups live under `packages/cli/src/cli/commands/`.
- `md2feishu workflow list` and `md2feishu workflow show <id>` describe the user stories without requiring command memorization.
- `sync` dry-runs can explain `noop`, `replace-section`, `replace-contiguous-blocks`, or `replace-document`.
- Official Feishu Markdown export/import can be selected explicitly and has a documented smoke checklist before becoming a default.
- The intended default Markdown behavior is official-first `auto`, with local conversion retained as fallback and debugging support.
- Whole-document writes still require explicit write intent and still protect receipt conflicts.
- Section writes still preserve remote content outside the section and do not update whole-document receipts.
- `multisdk` retains validation evidence, dry-run, write, audit, trace, and grade gates.
- `reference` authoring and `reference` web-content release are separate workflows; authoring can finish without touching `web-content`.
- `reference` and `release` workflows can be inspected through the shared workflow registry and harness tool registry.
- Feishu API errors are typed enough to distinguish retryable transport/rate-limit failures from user-fixable validation failures.
- Human docs and agent docs share one workflow source instead of duplicating command sequences, safety gates, and completion criteria.
- Docs and agent skill pages point users to workflow recipes first.
- Each first-class workflow has a matching skill page with pressure scenarios that prevent common agent mistakes such as whole-document writes, unverified snippet writes, and premature `web-content` release.
- Older operation-specific skills are marked as legacy aliases and point to the new workflow skills, so agents have one obvious skill per workflow instead of competing overlapping skills.
- `npm run typecheck`, `npm test`, and `npm run docs:build` pass.
