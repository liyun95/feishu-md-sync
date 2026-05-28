# Baseline Sync UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make `feishu-baseline-sync` a safe, explainable, repeatable remote-to-local refresh workflow instead of a skill-managed sequence of ad hoc `pull`, shell `diff`, and manual overwrite steps.

**Architecture:** Keep `md2feishu pull` as the low-level export primitive, but harden it for baseline use: protect existing output files, optionally write a local baseline receipt, and expose workflow steps that match what agents actually need to do. The skill remains a thin orchestrator that reads `md2feishu workflow show baseline-sync --format json` and follows the recipe.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, Feishu docx/wiki APIs, official-first Markdown engine, existing `.sync/feishu` receipt model, VitePress docs, Codex skills.

---

## Evidence From Live Run

The tested command was:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --output /Users/liyun/Downloads/feishu-md-sync-block-level-baseline.md
```

To avoid overwriting local content blindly, the actual safe workflow required extra agent-managed steps:

1. Pull remote content to `/private/tmp/feishu-md-sync-block-level-baseline.remote.md`.
2. Run `diff -q` and `diff -u` between the temp file and the existing output file.
3. Copy the temp file over the requested output path only after the diff looked scoped.
4. Run `md2feishu status`.

The status result was technically correct but poor UX for a freshly pulled baseline:

```text
state: no-receipt
local changed: true
remote changed: true
```

That happens because `status` is receipt-oriented and compares imported local Markdown blocks against remote Feishu blocks. It does not know that the local file was just exported from Feishu. For baseline refresh, this creates noise and undermines confidence.

## Current UX Problems

| Problem | Current Behavior | Desired Behavior |
| --- | --- | --- |
| Existing output file safety | `pull --output <existing-file>` overwrites directly. The skill compensates by pulling to temp first. | CLI should refuse overwriting unless the caller passes explicit overwrite intent. |
| Baseline state | `pull` writes Markdown but no receipt. `status` reports `no-receipt` even after a successful pull. | Baseline workflow should optionally create a read receipt so later `status` has a real baseline. |
| Verification mismatch | Baseline verification uses `status`, which is optimized for write sync and can report noisy block-hash differences. | Baseline verification should confirm exported Markdown was written and, when a receipt is requested, that the receipt matches the remote snapshot used for the pull. |
| Agent complexity | Skill has to know temp-file, diff, and overwrite policy. | Workflow registry should encode these decisions so every agent follows the same route. |
| Shell quoting | Feishu wiki URLs with `?` fail under zsh unless quoted. | Workflow and skill docs should explicitly quote `<feishu-doc>` examples. |

## Target User Experience

For a new local baseline:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md --write-receipt
```

Expected output:

```text
wrote: doc.remote.md
receipt: .sync/feishu/doc.remote.md.<doc-id>.json
baseline: clean
```

For refreshing an existing file:

```bash
md2feishu pull '<feishu-doc>' --output /Users/liyun/Downloads/doc.md --write-receipt
```

Expected output:

```text
Refusing to overwrite existing output without --overwrite.
Preview first:
  md2feishu pull '<feishu-doc>' --output /private/tmp/doc.remote.md
Then replace intentionally:
  md2feishu pull '<feishu-doc>' --output /Users/liyun/Downloads/doc.md --overwrite --write-receipt
```

For an agent-managed refresh:

```bash
md2feishu pull '<feishu-doc>' --output /private/tmp/doc.remote.md
diff -u /Users/liyun/Downloads/doc.md /private/tmp/doc.remote.md
md2feishu pull '<feishu-doc>' --output /Users/liyun/Downloads/doc.md --overwrite --write-receipt
md2feishu status /Users/liyun/Downloads/doc.md '<feishu-doc>'
```

Expected status after receipt creation:

```text
state: clean
local changed: false
remote changed: false
```

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/cli/src/sync/pull.ts` | Return both exported Markdown and the remote state needed for baseline receipts. |
| `packages/cli/src/cli/commands/sync.ts` | Add `pull --overwrite` and `pull --write-receipt`; refuse unsafe output replacement by default. |
| `packages/cli/test/pull-baseline-receipt.test.ts` | Unit coverage for baseline receipt construction. |
| `packages/cli/test/cli-pull-output-policy.test.ts` | CLI-level coverage for output overwrite policy. |
| `packages/cli/src/workflows/registry.ts` | Update `baseline-sync` recipe to match the safe temp/diff/overwrite/receipt workflow. |
| `packages/cli/test/workflow-registry.test.ts` | Lock in the improved baseline workflow steps. |
| `skills/feishu-baseline-sync/SKILL.md` | Make the installed skill follow the new CLI behavior and explain `status: clean` after receipt creation. |
| `apps/docs/agent/skills/feishu-baseline-sync.md` | Public skill behavior summary. |
| `apps/docs/guide/baseline-sync.md` | User-facing workflow guide. |
| `packages/cli/README.md` | Short CLI-facing baseline example. |

---

### Task 1: Add Pull Result Metadata

**Files:**
- Modify: `packages/cli/src/sync/pull.ts`
- Test: `packages/cli/test/pull-baseline-receipt.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/cli/test/pull-baseline-receipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pullRemoteMarkdownWithState } from '../src/sync/pull.js';
import type { FeishuDocClient } from '../src/feishu/types.js';

describe('pullRemoteMarkdownWithState', () => {
  it('returns exported markdown with the remote block hash needed for a baseline receipt', async () => {
    const client: FeishuDocClient = {
      getDocumentBlocks: async () => [
        { block_id: 'doc123', block_type: 1, children: ['heading1'] },
        { block_id: 'heading1', block_type: 3, heading1: { elements: [], style: {} } }
      ]
    } as unknown as FeishuDocClient;

    const result = await pullRemoteMarkdownWithState(client, 'doc123', {
      exportMarkdown: async () => ({ markdown: '# Remote\n' }),
      importMarkdown: async () => ({ blocks: [] })
    });

    expect(result.markdown).toBe('# Remote\n');
    expect(result.remoteBlockCount).toBe(1);
    expect(result.remoteHash).toHaveLength(64);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- packages/cli/test/pull-baseline-receipt.test.ts
```

Expected: FAIL because `pullRemoteMarkdownWithState` does not exist.

- [x] **Step 3: Implement pull metadata**

Update `packages/cli/src/sync/pull.ts`:

```ts
import type { FeishuDocClient } from '../feishu/types.js';
import { hashBlocks } from '../core/hash.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { comparableDirectChildBlocks, findPageBlock, renderableDirectChildBlocks } from './block-state.js';

export type PulledRemoteMarkdown = {
  markdown: string;
  remoteHash: string;
  remoteBlockCount: number;
};

export async function pullRemoteMarkdownWithState(
  client: FeishuDocClient,
  documentId: string,
  engine: MarkdownEngine = createMarkdownEngine({ mode: 'local' })
): Promise<PulledRemoteMarkdown> {
  const existingBlocks = await client.getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(existingBlocks, documentId);
  const renderableChildren = renderableDirectChildBlocks(existingBlocks, pageBlock);
  const comparableChildren = comparableDirectChildBlocks(existingBlocks, pageBlock);
  const exported = await engine.exportMarkdown({ documentId, fallbackBlocks: renderableChildren });

  return {
    markdown: exported.markdown,
    remoteHash: hashBlocks(comparableChildren),
    remoteBlockCount: comparableChildren.length
  };
}

export async function pullRemoteMarkdown(
  client: FeishuDocClient,
  documentId: string,
  engine: MarkdownEngine = createMarkdownEngine({ mode: 'local' })
): Promise<string> {
  return (await pullRemoteMarkdownWithState(client, documentId, engine)).markdown;
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- packages/cli/test/pull-baseline-receipt.test.ts
```

Expected: PASS.

---

### Task 2: Protect Existing Pull Outputs

**Files:**
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Test: `packages/cli/test/cli-pull-output-policy.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/cli/test/cli-pull-output-policy.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertPullOutputWritable } from '../src/cli/commands/sync.js';

describe('pull output policy', () => {
  it('refuses to overwrite an existing output unless --overwrite is explicit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'md2feishu-pull-policy-'));
    const output = join(dir, 'doc.md');
    await writeFile(output, 'local draft\n', 'utf8');

    await expect(assertPullOutputWritable(output, false)).rejects.toThrow(/Refusing to overwrite existing output/);
    expect(await readFile(output, 'utf8')).toBe('local draft\n');
  });

  it('allows a missing output path without --overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'md2feishu-pull-policy-'));
    await expect(assertPullOutputWritable(join(dir, 'new.md'), false)).resolves.toBeUndefined();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- packages/cli/test/cli-pull-output-policy.test.ts
```

Expected: FAIL because `assertPullOutputWritable` is not exported.

- [x] **Step 3: Implement the overwrite guard**

In `packages/cli/src/cli/commands/sync.ts`, update `PullCommandOptions`:

```ts
type PullCommandOptions = BaseCommandOptions & {
  output?: string;
  markdownEngine?: string;
  overwrite?: boolean;
  writeReceipt?: boolean;
};
```

Add the option to the `pull` command:

```ts
.option('--overwrite', 'allow pull to replace an existing output file')
.option('--write-receipt', 'write a local baseline receipt after exporting to --output')
```

Before writing the output file, call:

```ts
await assertPullOutputWritable(normalized.output, normalized.overwrite === true);
```

Add this exported helper near the bottom of the file:

```ts
export async function assertPullOutputWritable(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    await readFile(outputPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!overwrite) {
    throw new Error(
      `Refusing to overwrite existing output without --overwrite: ${outputPath}`
    );
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- packages/cli/test/cli-pull-output-policy.test.ts
```

Expected: PASS.

---

### Task 3: Write Baseline Receipts From Pull

**Files:**
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Test: `packages/cli/test/pull-baseline-receipt.test.ts`

- [x] **Step 1: Extend the test**

Add this import at the top of `packages/cli/test/pull-baseline-receipt.test.ts`:

```ts
import { buildPullBaselineReceipt } from '../src/cli/commands/sync.js';
```

Append this test block:

```ts
describe('buildPullBaselineReceipt', () => {
  it('records a read-only baseline without pretending Feishu was written', async () => {
    const receipt = await buildPullBaselineReceipt({
      sourcePath: '/tmp/doc.md',
      sourceMarkdown: '# Remote\n',
      documentId: 'doc123',
      remoteHash: 'a'.repeat(64),
      remoteBlockCount: 3,
      timestamp: '2026-05-28T00:00:00.000Z'
    });

    expect(receipt.sourcePath).toBe('/tmp/doc.md');
    expect(receipt.sourceHash).toHaveLength(64);
    expect(receipt.feishuStateHash).toBe('a'.repeat(64));
    expect(receipt.sourceSnapshot).toBe('# Remote\n');
    expect(receipt.feishuMarkdownSnapshot).toBe('# Remote\n');
    expect(receipt.writeResult).toEqual({
      mode: 'dry-run',
      deleted: 0,
      created: 0,
      updated: 0,
      skipped: true
    });
    expect(receipt.verificationResult).toEqual({
      ok: true,
      expectedHash: 'a'.repeat(64),
      actualHash: 'a'.repeat(64)
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- packages/cli/test/pull-baseline-receipt.test.ts
```

Expected: FAIL because `buildPullBaselineReceipt` does not exist.

- [x] **Step 3: Implement receipt writing**

In `packages/cli/src/cli/commands/sync.ts`, import:

```ts
import { hashSource } from '../../core/hash.js';
import { writeReceipt, type SyncReceipt } from '../../receipts/receipt.js';
import { pullRemoteMarkdownWithState } from '../../sync/pull.js';
```

Replace the pull action internals with:

```ts
const pulled = await pullRemoteMarkdownWithState(client, documentId, createCliMarkdownEngine(client, normalized.markdownEngine));
if (normalized.output) {
  await assertPullOutputWritable(normalized.output, normalized.overwrite === true);
  await writeFile(normalized.output, pulled.markdown, 'utf8');
  console.log(`wrote: ${normalized.output}`);
  if (normalized.writeReceipt) {
    const statePath = receiptPath(process.cwd(), normalized.output, documentId);
    const receipt = await buildPullBaselineReceipt({
      sourcePath: normalized.output,
      sourceMarkdown: pulled.markdown,
      documentId,
      remoteHash: pulled.remoteHash,
      remoteBlockCount: pulled.remoteBlockCount,
      timestamp: new Date().toISOString()
    });
    await writeReceipt(statePath, receipt);
    console.log(`receipt: ${statePath}`);
    console.log('baseline: clean');
  }
  return;
}
stdout.write(pulled.markdown);
```

Add:

```ts
export type PullBaselineReceiptInput = {
  sourcePath: string;
  sourceMarkdown: string;
  documentId: string;
  remoteHash: string;
  remoteBlockCount: number;
  timestamp: string;
};

export async function buildPullBaselineReceipt(input: PullBaselineReceiptInput): Promise<SyncReceipt> {
  return {
    sourcePath: path.resolve(input.sourcePath),
    sourceHash: hashSource(input.sourceMarkdown),
    sourceSnapshot: input.sourceMarkdown,
    feishuDocId: input.documentId,
    feishuStateHash: input.remoteHash,
    feishuMarkdownSnapshot: input.sourceMarkdown,
    timestamp: input.timestamp,
    blockCounts: {
      source: input.remoteBlockCount,
      feishuBefore: input.remoteBlockCount,
      feishuAfter: input.remoteBlockCount
    },
    warnings: ['Receipt created by read-only baseline pull; no Feishu write was performed.'],
    writeResult: {
      mode: 'dry-run',
      deleted: 0,
      created: 0,
      updated: 0,
      skipped: true
    },
    verificationResult: {
      ok: true,
      expectedHash: input.remoteHash,
      actualHash: input.remoteHash
    }
  };
}
```

- [x] **Step 4: Run targeted tests**

Run:

```bash
npm test -- packages/cli/test/pull-baseline-receipt.test.ts packages/cli/test/status.test.ts packages/cli/test/receipt.test.ts
```

Expected: PASS.

---

### Task 4: Update Workflow Registry

**Files:**
- Modify: `packages/cli/src/workflows/registry.ts`
- Modify: `packages/cli/test/workflow-registry.test.ts`

- [x] **Step 1: Write the failing registry test**

Update the baseline test in `packages/cli/test/workflow-registry.test.ts`:

```ts
it('gives safe next commands for a baseline sync', () => {
  const recipe = getWorkflowRecipe('baseline-sync');
  expect(recipe.title).toBe('Pull Feishu to local Markdown baseline');
  expect(recipe.steps.map((step) => step.id)).toEqual([
    'auth',
    'preview-pull',
    'review-diff',
    'replace-local',
    'status'
  ]);
  expect(recipe.steps[3].command).toContain('--overwrite');
  expect(recipe.steps[3].command).toContain('--write-receipt');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- packages/cli/test/workflow-registry.test.ts
```

Expected: FAIL because the current workflow has only `auth`, `pull`, and `status`.

- [x] **Step 3: Update the recipe**

Change the `baseline-sync` recipe in `packages/cli/src/workflows/registry.ts`:

```ts
{
  id: 'baseline-sync',
  title: 'Pull Feishu to local Markdown baseline',
  whenToUse: 'Refresh local Markdown from current Feishu content before editing, comparison, or later section sync.',
  primaryArtifacts: ['local Markdown file', '.sync/feishu baseline receipt'],
  steps: [
    { id: 'auth', purpose: 'Check credentials without printing secrets.', command: 'md2feishu doctor auth', writes: 'none', verifies: 'APP_ID and APP_SECRET are present.' },
    { id: 'preview-pull', purpose: 'Export current Feishu content to a reviewable remote copy first.', command: "md2feishu pull '<feishu-doc>' --output <doc>.remote.md", writes: 'local', verifies: 'The remote copy exists and is reviewable.' },
    { id: 'review-diff', purpose: 'Compare the remote copy with any existing local baseline before replacement.', command: 'diff -u <existing-doc.md> <doc>.remote.md', writes: 'none', verifies: 'Diff is understood and scoped to expected remote edits.' },
    { id: 'replace-local', purpose: 'Replace an existing local baseline only after explicit overwrite intent.', command: "md2feishu pull '<feishu-doc>' --output <existing-doc.md> --overwrite --write-receipt", writes: 'local', verifies: 'The requested local file and receipt are refreshed from Feishu.' },
    { id: 'status', purpose: 'Confirm the refreshed file is the current baseline.', command: "md2feishu status <existing-doc.md> '<feishu-doc>'", writes: 'none', verifies: 'Status is clean, or any remaining mismatch is explained.' }
  ]
}
```

- [x] **Step 4: Run registry tests**

Run:

```bash
npm test -- packages/cli/test/workflow-registry.test.ts
```

Expected: PASS.

---

### Task 5: Update Skill and Docs

**Files:**
- Modify: `skills/feishu-baseline-sync/SKILL.md`
- Modify: `apps/docs/agent/skills/feishu-baseline-sync.md`
- Modify: `apps/docs/guide/baseline-sync.md`
- Modify: `packages/cli/README.md`

- [x] **Step 1: Update the installable skill**

In `skills/feishu-baseline-sync/SKILL.md`, replace the safety policy with this wording:

```md
## Local Output Policy

Baseline sync is the answer when the user says the remote Feishu document changed and they want to sync it to local Markdown. It reads Feishu and writes local files only; it does not write anything back to Feishu.

Always run `md2feishu workflow show baseline-sync --format json` first and follow the returned steps.

When the target path does not exist, pull directly to that path with `--write-receipt`.

When the target path already exists:

1. Pull the remote document to a separate `*.remote.md` or `/private/tmp/*.remote.md` file.
2. Compare the existing file and the remote copy with `diff -u`.
3. Replace the existing file only when the user has already provided exact overwrite intent, or after the diff shows no local-only edits that need preservation.
4. Use `--overwrite --write-receipt` for the final replacement.

Quote Feishu URLs in shell commands because wiki URLs often contain `?`.
```

- [x] **Step 2: Update user docs**

In `apps/docs/guide/baseline-sync.md`, add:

```md
## Existing local files

If the requested output file already exists, the baseline workflow first writes a separate remote copy, compares it with the existing file, and only then refreshes the requested file with explicit overwrite intent. This prevents a remote pull from silently erasing local-only edits.

## Baseline receipt

The baseline workflow can write a local receipt after a successful pull. This receipt records the remote state that produced the Markdown file; it does not mean Feishu was written. With this receipt, `md2feishu status` can report a clean baseline immediately after pull instead of the noisy `no-receipt` state.
```

- [x] **Step 3: Update agent docs**

In `apps/docs/agent/skills/feishu-baseline-sync.md`, add:

```md
After the final pull, expect `md2feishu status` to be clean when a baseline receipt was written. If status still reports `no-receipt`, explain that the local Markdown exists but has not been registered as a sync baseline.
```

- [x] **Step 4: Update package README**

In `packages/cli/README.md`, replace the baseline pull example with:

```bash
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md --write-receipt
```

For an existing local file:

```bash
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md
diff -u doc.md feishu.remote.md
npm exec -- md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
```

- [x] **Step 5: Build docs**

Run:

```bash
npm run docs:build
```

Expected: PASS.

---

### Task 6: Final Verification

**Files:**
- No new files.

- [x] **Step 1: Run focused tests**

Run:

```bash
npm test -- packages/cli/test/pull-baseline-receipt.test.ts packages/cli/test/cli-pull-output-policy.test.ts packages/cli/test/workflow-registry.test.ts packages/cli/test/status.test.ts packages/cli/test/receipt.test.ts
```

Expected: PASS.

- [x] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [x] **Step 3: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: PASS.

- [x] **Step 4: Run a live baseline smoke on the test wiki**

Run:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --output /private/tmp/feishu-md-sync-baseline-smoke.md --write-receipt
npm exec -- md2feishu status /private/tmp/feishu-md-sync-baseline-smoke.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true'
```

Expected:

```text
state: clean
local changed: false
remote changed: false
```

Then test overwrite safety:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --output /private/tmp/feishu-md-sync-baseline-smoke.md --write-receipt
```

Expected: FAIL with `Refusing to overwrite existing output without --overwrite`.

Run:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --output /private/tmp/feishu-md-sync-baseline-smoke.md --overwrite --write-receipt
```

Expected: PASS and prints `baseline: clean`.

## Rollout Notes

- This is a breaking safety improvement for `pull --output <existing-file>` because it stops silent replacement. The repo is still pre-team-rollout, so this is the right time to make that behavior stricter.
- `--write-receipt` should remain explicit. Plain `pull` can still be used as a raw export primitive without writing `.sync/feishu` state.
- The receipt warning must clearly state that no Feishu write happened, so future debugging does not confuse pull-created receipts with write-created receipts.
- The skill installer should be run after this lands:

```bash
scripts/install-codex-skills.sh
```

## UX Impact

- Users can say “sync remote Feishu to this existing Markdown file” and the agent has a deterministic workflow that protects local edits.
- A freshly pulled baseline no longer looks dirty only because no receipt exists.
- The CLI, docs, and skill all describe the same workflow, which reduces maintenance cost and avoids divergent agent behavior.
- Feishu writes remain separate: baseline sync still never writes remote content.
