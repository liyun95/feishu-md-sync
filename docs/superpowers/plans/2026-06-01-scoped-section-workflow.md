# Scoped Section Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class scoped write support for inserting a new heading section before/after an existing heading and replacing document prefix content before a heading.

**Architecture:** Keep all section-range planning in `packages/cli/src/sync/section.ts`, then let `runSync()` select the correct patch plan and replacement blocks. The CLI exposes explicit options and validates invalid combinations before network writes. Existing patch application stays unchanged because both new operations can be represented as `replace-section` with zero deletes or prefix replacement with a bounded range.

**Tech Stack:** TypeScript ESM, Commander, Vitest, existing local Markdown engine and Feishu block patch planner.

---

## Scope

Implement this phase only:

- `--insert-section <heading> --before-section <existing-heading>`
- `--insert-section <heading> --after-section <existing-heading>`
- `--before-heading <existing-heading>` for replacing local prefix content before the target heading into remote prefix content before the same target heading
- dry-run output must show insertion/replacement range metadata through the existing section output path
- write path must use the existing create-before-delete safety behavior

Do not implement in this plan:

- Permission probe command
- Feishu `mention_doc` import
- review-draft transform profile
- scoped write receipts
- publish-new recovery guidance

## File Structure

- Modify `packages/cli/src/sync/section.ts`
  - Owns heading discovery, section replacement planning, section insertion planning, and prefix replacement planning.
- Modify `packages/cli/src/sync/run-sync.ts`
  - Adds scoped operation options and chooses the appropriate section planner.
- Modify `packages/cli/src/cli/commands/sync.ts`
  - Adds Commander options and invalid-combination validation.
- Modify `packages/cli/test/section.test.ts`
  - Unit tests for insertion and prefix range planning.
- Modify `packages/cli/test/sync.test.ts`
  - Integration tests for dry-run/write behavior through `runSync()`.
- Modify `packages/cli/test/cli-help-surface.test.ts`
  - Help surface coverage for the new CLI flags.

## Command Semantics

Valid:

```bash
md2feishu sync doc.md "$DOC" --insert-section "Pattern matching operators" --before-section "Arithmetic Operators"
md2feishu sync doc.md "$DOC" --insert-section "Regex filter templates" --after-section "Examples"
md2feishu sync doc.md "$DOC" --before-heading "How it works"
```

Invalid:

```bash
md2feishu sync doc.md "$DOC" --insert-section "New" --before-section "A" --after-section "B"
md2feishu sync doc.md "$DOC" --insert-section "New"
md2feishu sync doc.md "$DOC" --before-section "A"
md2feishu sync doc.md "$DOC" --before-heading "How it works" --section "How it works"
md2feishu sync doc.md "$DOC" --before-heading "How it works" --insert-section "New" --before-section "A"
```

### Task 1: Add Section Planner Unit Tests

**Files:**
- Modify: `packages/cli/test/section.test.ts`
- Modify later: `packages/cli/src/sync/section.ts`

- [ ] **Step 1: Write failing tests for insert-before, insert-after, and before-heading**

Append these imports and tests to `packages/cli/test/section.test.ts`. If the file already imports `markdownToFeishuBlocks`, reuse the existing import instead of duplicating it.

```ts
import { markdownToFeishuBlocks } from '../src/markdown/blocks.js';
import {
  planBeforeHeadingPatch,
  planInsertSectionPatch
} from '../src/sync/section.js';
```

```ts
describe('insert section planning', () => {
  it('inserts a local section before an existing remote heading', () => {
    const remote = markdownToFeishuBlocks(`## Intro

Remote intro

## Arithmetic Operators

Remote arithmetic
`);
    const local = markdownToFeishuBlocks(`## Pattern matching operators

New regex content
`);

    const plan = planInsertSectionPatch(remote, local, {
      insertSection: 'Pattern matching operators',
      relative: 'before',
      targetHeading: 'Arithmetic Operators'
    });

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(0);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'Pattern matching operators',
      remoteStartIndex: 2,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...remote.slice(0, 2),
      ...local,
      ...remote.slice(2)
    ]);
  });

  it('inserts a local section after an existing remote heading section', () => {
    const remote = markdownToFeishuBlocks(`## Examples

Remote examples

## Conclusion

Remote conclusion
`);
    const local = markdownToFeishuBlocks(`## Regex filter templates

New template content
`);

    const plan = planInsertSectionPatch(remote, local, {
      insertSection: 'Regex filter templates',
      relative: 'after',
      targetHeading: 'Examples'
    });

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(0);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'Regex filter templates',
      remoteStartIndex: 2,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...remote.slice(0, 2),
      ...local,
      ...remote.slice(2)
    ]);
  });

  it('rejects insert-section when the local section is missing', () => {
    const remote = markdownToFeishuBlocks('## Existing\n\nRemote\n');
    const local = markdownToFeishuBlocks('## Other\n\nLocal\n');

    expect(() => planInsertSectionPatch(remote, local, {
      insertSection: 'Missing',
      relative: 'before',
      targetHeading: 'Existing'
    })).toThrow('Could not find local section "Missing".');
  });
});

describe('before-heading planning', () => {
  it('replaces only the prefix before an existing heading', () => {
    const remote = markdownToFeishuBlocks(`Remote intro

Remote note

## How it works

Remote how
`);
    const local = markdownToFeishuBlocks(`Local intro

Local note

## How it works

Local how should not sync
`);

    const plan = planBeforeHeadingPatch(remote, local, 'How it works');

    expect(plan.patchPlan.operation).toBe('replace-section');
    expect(plan.patchPlan.deleteCount).toBe(2);
    expect(plan.patchPlan.createCount).toBe(2);
    expect(plan.patchPlan.section).toMatchObject({
      title: 'before heading: How it works',
      remoteStartIndex: 0,
      remoteEndIndex: 2,
      localStartIndex: 0,
      localEndIndex: 2
    });
    expect(plan.expectedChildren).toEqual([
      ...local.slice(0, 2),
      ...remote.slice(2)
    ]);
  });

  it('rejects before-heading when the target heading is missing remotely', () => {
    const remote = markdownToFeishuBlocks('Remote intro\n');
    const local = markdownToFeishuBlocks('Local intro\n\n## How it works\n');

    expect(() => planBeforeHeadingPatch(remote, local, 'How it works')).toThrow(
      'Could not find remote section "How it works".'
    );
  });
});
```

- [ ] **Step 2: Run the section tests and verify they fail**

Run:

```bash
npm test -- section.test.ts
```

Expected: FAIL because `planInsertSectionPatch` and `planBeforeHeadingPatch` are not exported.

### Task 2: Implement Section Insertion And Prefix Planning

**Files:**
- Modify: `packages/cli/src/sync/section.ts`
- Test: `packages/cli/test/section.test.ts`

- [ ] **Step 1: Add option and shared return types**

Add these exports near the existing `SectionPatchPlan` type in `packages/cli/src/sync/section.ts`:

```ts
export type InsertSectionOptions = {
  insertSection: string;
  relative: 'before' | 'after';
  targetHeading: string;
};
```

- [ ] **Step 2: Add `planInsertSectionPatch`**

Add this function after `planSectionPatch()` in `packages/cli/src/sync/section.ts`:

```ts
export function planInsertSectionPatch(
  currentChildren: FeishuBlock[],
  desiredChildren: FeishuBlock[],
  options: InsertSectionOptions
): SectionPatchPlan {
  const localRange = findUniqueSectionRange(desiredChildren, options.insertSection, 'local');
  const targetRange = findUniqueSectionRange(currentChildren, options.targetHeading, 'remote');
  const insertionIndex = options.relative === 'before' ? targetRange.startIndex : targetRange.endIndex;
  const expectedChildren = [
    ...currentChildren.slice(0, insertionIndex),
    ...localRange.blocks,
    ...currentChildren.slice(insertionIndex)
  ];
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(expectedChildren);
  const basePlan = {
    deleteCount: 0,
    createCount: localRange.blocks.length,
    currentHash,
    desiredHash,
    section: {
      title: localRange.title,
      remoteStartIndex: insertionIndex,
      remoteEndIndex: insertionIndex,
      localStartIndex: localRange.startIndex,
      localEndIndex: localRange.endIndex
    }
  };

  return {
    patchPlan: currentHash === desiredHash
      ? { ...basePlan, operation: 'noop' }
      : { ...basePlan, operation: 'replace-section' },
    replacementBlocks: localRange.blocks,
    expectedChildren,
    localRange,
    remoteRange: {
      title: localRange.title,
      level: localRange.level,
      startIndex: insertionIndex,
      endIndex: insertionIndex,
      blocks: []
    }
  };
}
```

- [ ] **Step 3: Add `planBeforeHeadingPatch`**

Add this function after `planInsertSectionPatch()`:

```ts
export function planBeforeHeadingPatch(
  currentChildren: FeishuBlock[],
  desiredChildren: FeishuBlock[],
  headingTitle: string
): SectionPatchPlan {
  const remoteTarget = findUniqueSectionRange(currentChildren, headingTitle, 'remote');
  const localTarget = findUniqueSectionRange(desiredChildren, headingTitle, 'local');
  const replacementBlocks = desiredChildren.slice(0, localTarget.startIndex);
  const expectedChildren = [
    ...replacementBlocks,
    ...currentChildren.slice(remoteTarget.startIndex)
  ];
  const currentHash = hashBlocks(currentChildren);
  const desiredHash = hashBlocks(expectedChildren);
  const basePlan = {
    deleteCount: remoteTarget.startIndex,
    createCount: replacementBlocks.length,
    currentHash,
    desiredHash,
    section: {
      title: `before heading: ${remoteTarget.title}`,
      remoteStartIndex: 0,
      remoteEndIndex: remoteTarget.startIndex,
      localStartIndex: 0,
      localEndIndex: localTarget.startIndex
    }
  };

  return {
    patchPlan: currentHash === desiredHash
      ? { ...basePlan, operation: 'noop' }
      : { ...basePlan, operation: 'replace-section' },
    replacementBlocks,
    expectedChildren,
    localRange: {
      title: `before heading: ${localTarget.title}`,
      level: localTarget.level,
      startIndex: 0,
      endIndex: localTarget.startIndex,
      blocks: replacementBlocks
    },
    remoteRange: {
      title: `before heading: ${remoteTarget.title}`,
      level: remoteTarget.level,
      startIndex: 0,
      endIndex: remoteTarget.startIndex,
      blocks: currentChildren.slice(0, remoteTarget.startIndex)
    }
  };
}
```

- [ ] **Step 4: Run section tests**

Run:

```bash
npm test -- section.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/cli/src/sync/section.ts packages/cli/test/section.test.ts
git commit -m "Add scoped section planning"
```

### Task 3: Wire New Scoped Operations Through `runSync`

**Files:**
- Modify: `packages/cli/src/sync/run-sync.ts`
- Test: `packages/cli/test/sync.test.ts`

- [ ] **Step 1: Write failing integration tests**

Append these tests inside the existing `describe('runSync', () => { ... })` in `packages/cli/test/sync.test.ts` before the final `});`:

```ts
  it('dry-runs inserting a local section before an existing remote heading', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `## Pattern matching operators

New regex content
`);
    const remote = markdownToFeishuBlocks(`## Intro

Remote intro

## Arithmetic Operators

Remote arithmetic
`);
    const client = fakeClient(remote, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      insertSection: {
        heading: 'Pattern matching operators',
        relative: 'before',
        targetHeading: 'Arithmetic Operators'
      }
    });

    expect(result.patchPlan.operation).toBe('replace-section');
    expect(result.patchPlan.deleteCount).toBe(0);
    expect(result.patchPlan.createCount).toBe(2);
    expect(result.patchPlan.section).toMatchObject({
      title: 'Pattern matching operators',
      remoteStartIndex: 2,
      remoteEndIndex: 2
    });
    expect(client.createChildren).not.toHaveBeenCalled();
    expect(client.deleteChildren).not.toHaveBeenCalled();
  });

  it('writes an inserted section before deleting nothing from the remote document', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `## Pattern matching operators

New regex content
`);
    const remote = markdownToFeishuBlocks(`## Intro

Remote intro

## Arithmetic Operators

Remote arithmetic
`);
    const local = markdownToFeishuBlocks(await readFile(sourcePath, 'utf8'));
    const expected = [
      ...remote.slice(0, 2),
      ...local,
      ...remote.slice(2)
    ];
    const client = fakeClient(expected, remote);

    const result = await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      insertSection: {
        heading: 'Pattern matching operators',
        relative: 'before',
        targetHeading: 'Arithmetic Operators'
      }
    });

    expect(result.receiptWritten).toBe(false);
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', local, { index: 2 });
    expect(client.deleteChildren).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Scoped sync does not update the whole-document receipt.'
    ]));
  });

  it('writes only the prefix before a heading', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, `Local intro

Local note

## How it works

Local how should not sync
`);
    const remote = markdownToFeishuBlocks(`Remote intro

Remote note

## How it works

Remote how
`);
    const local = markdownToFeishuBlocks(await readFile(sourcePath, 'utf8'));
    const expected = [
      ...local.slice(0, 2),
      ...remote.slice(2)
    ];
    const client = fakeClient(expected, remote);

    await runSync(client, {
      sourcePath,
      documentId: 'doc1234567890123',
      rootDir: dir,
      dryRun: false,
      yes: true,
      beforeHeading: 'How it works'
    });

    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'page', local.slice(0, 2), { index: 2 });
    expect(client.deleteChildren).toHaveBeenCalledWith('doc1234567890123', 'page', 0, 2);
  });
```

- [ ] **Step 2: Run sync tests and verify they fail**

Run:

```bash
npm test -- sync.test.ts
```

Expected: FAIL with TypeScript/test errors because `insertSection` and `beforeHeading` are not in `SyncOptions`.

- [ ] **Step 3: Add option types and planner imports**

Modify imports in `packages/cli/src/sync/run-sync.ts`:

```ts
import {
  planBeforeHeadingPatch,
  planInsertSectionPatch,
  planSectionPatch,
  type InsertSectionOptions
} from './section.js';
```

Add this exported type near `SyncOptions`:

```ts
export type SyncInsertSectionOptions = {
  heading: string;
  relative: InsertSectionOptions['relative'];
  targetHeading: string;
};
```

Add these fields to `SyncOptions`:

```ts
  insertSection?: SyncInsertSectionOptions;
  beforeHeading?: string;
```

- [ ] **Step 4: Replace the section planner selection**

Find this code:

```ts
  const sectionPatch = options.section ? planSectionPatch(currentChildren, desiredBlocks, options.section) : null;
  const patchPlan = sectionPatch?.patchPlan ?? planSmartPatch(currentChildren, desiredBlocks);
  const patchBlocks = sectionPatch?.replacementBlocks ?? replacementBlocksForPlan(patchPlan, desiredBlocks);
```

Replace it with:

```ts
  const scopedPatch = scopedPatchPlan({
    currentChildren,
    desiredBlocks,
    section: options.section,
    insertSection: options.insertSection,
    beforeHeading: options.beforeHeading
  });
  const patchPlan = scopedPatch?.patchPlan ?? planSmartPatch(currentChildren, desiredBlocks);
  const patchBlocks = scopedPatch?.replacementBlocks ?? replacementBlocksForPlan(patchPlan, desiredBlocks);
```

Add this helper near the bottom of `run-sync.ts` before `originalPathForMergedFile()`:

```ts
function scopedPatchPlan(input: {
  currentChildren: FeishuBlock[];
  desiredBlocks: FeishuBlock[];
  section?: string;
  insertSection?: SyncInsertSectionOptions;
  beforeHeading?: string;
}) {
  if (input.section) {
    return planSectionPatch(input.currentChildren, input.desiredBlocks, input.section);
  }
  if (input.insertSection) {
    return planInsertSectionPatch(input.currentChildren, input.desiredBlocks, {
      insertSection: input.insertSection.heading,
      relative: input.insertSection.relative,
      targetHeading: input.insertSection.targetHeading
    });
  }
  if (input.beforeHeading) {
    return planBeforeHeadingPatch(input.currentChildren, input.desiredBlocks, input.beforeHeading);
  }
  return null;
}
```

- [ ] **Step 5: Generalize receipt behavior for scoped writes**

Find:

```ts
    if (options.section) {
      warnings.push('Section sync does not update the whole-document receipt.');
    }
```

Replace with:

```ts
    if (isScopedSync(options)) {
      warnings.push('Scoped sync does not update the whole-document receipt.');
    }
```

Find:

```ts
  const receiptWritten = mode === 'write' && !options.section;
```

Replace with:

```ts
  const receiptWritten = mode === 'write' && !isScopedSync(options);
```

Add this helper near `scopedPatchPlan()`:

```ts
function isScopedSync(options: Pick<SyncOptions, 'section' | 'insertSection' | 'beforeHeading'>): boolean {
  return Boolean(options.section || options.insertSection || options.beforeHeading);
}
```

- [ ] **Step 6: Run sync tests**

Run:

```bash
npm test -- sync.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/cli/src/sync/run-sync.ts packages/cli/test/sync.test.ts
git commit -m "Wire scoped section operations into sync"
```

### Task 4: Add CLI Flags And Validation

**Files:**
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Modify: `packages/cli/test/cli-help-surface.test.ts`

- [ ] **Step 1: Add failing help-surface test**

In `packages/cli/test/cli-help-surface.test.ts`, extend the existing sync help test expectations with:

```ts
    expect(result.stdout).toContain('--insert-section <heading>');
    expect(result.stdout).toContain('--before-section <heading>');
    expect(result.stdout).toContain('--after-section <heading>');
    expect(result.stdout).toContain('--before-heading <heading>');
```

- [ ] **Step 2: Run help test and verify it fails**

Run:

```bash
npm test -- cli-help-surface.test.ts
```

Expected: FAIL because the new options are not listed.

- [ ] **Step 3: Add option fields**

In `packages/cli/src/cli/commands/sync.ts`, add fields to `SyncCommandOptions`:

```ts
  insertSection?: string;
  beforeSection?: string;
  afterSection?: string;
  beforeHeading?: string;
```

Add fields to `NormalizedSyncCommandOptions`:

```ts
  insertSection?: {
    heading: string;
    relative: 'before' | 'after';
    targetHeading: string;
  };
  beforeHeading?: string;
```

- [ ] **Step 4: Add Commander options to top-level sync and `sync` subcommand**

Add these option lines to both the top-level command and the `sync` subcommand after the existing `--section` option:

```ts
    .option('--insert-section <heading>', 'insert the named local heading section into the remote document')
    .option('--before-section <heading>', 'insert --insert-section before this existing remote heading')
    .option('--after-section <heading>', 'insert --insert-section after this existing remote heading section')
    .option('--before-heading <heading>', 'replace only content before this existing heading')
```

- [ ] **Step 5: Parse and validate scoped options**

In `normalizeSyncOptions()`, add local option reads after `const strategy = ...`:

```ts
  const section = optionFromArgv('--section') ?? commandOptionValue<string>(opts, 'section') ?? globals.section;
  const rawInsertSection = optionFromArgv('--insert-section') ?? commandOptionValue<string>(opts, 'insertSection') ?? globals.insertSection;
  const rawBeforeSection = optionFromArgv('--before-section') ?? commandOptionValue<string>(opts, 'beforeSection') ?? globals.beforeSection;
  const rawAfterSection = optionFromArgv('--after-section') ?? commandOptionValue<string>(opts, 'afterSection') ?? globals.afterSection;
  const beforeHeading = optionFromArgv('--before-heading') ?? commandOptionValue<string>(opts, 'beforeHeading') ?? globals.beforeHeading;
  const insertSection = parseInsertSectionOptions(rawInsertSection, rawBeforeSection, rawAfterSection);
  validateScopedOptions({ section, insertSection, beforeHeading });
```

Then replace the existing `section:` return field with:

```ts
    section,
    insertSection,
    beforeHeading,
```

Add these helpers near `parseMarkdownEngine()`:

```ts
function parseInsertSectionOptions(
  heading: string | undefined,
  beforeSection: string | undefined,
  afterSection: string | undefined
): NormalizedSyncCommandOptions['insertSection'] | undefined {
  if (!heading && !beforeSection && !afterSection) return undefined;
  if (!heading) {
    throw new Error('--before-section and --after-section require --insert-section.');
  }
  if (beforeSection && afterSection) {
    throw new Error('--insert-section requires only one of --before-section or --after-section.');
  }
  if (!beforeSection && !afterSection) {
    throw new Error('--insert-section requires --before-section or --after-section.');
  }
  return {
    heading,
    relative: beforeSection ? 'before' : 'after',
    targetHeading: beforeSection ?? afterSection ?? ''
  };
}

function validateScopedOptions(input: {
  section?: string;
  insertSection?: NormalizedSyncCommandOptions['insertSection'];
  beforeHeading?: string;
}): void {
  const selected = [
    input.section ? '--section' : '',
    input.insertSection ? '--insert-section' : '',
    input.beforeHeading ? '--before-heading' : ''
  ].filter(Boolean);
  if (selected.length > 1) {
    throw new Error(`Scoped sync options are mutually exclusive: ${selected.join(', ')}.`);
  }
}
```

- [ ] **Step 6: Pass options into `runSync()`**

In `runSyncCommand()`, add:

```ts
    insertSection: opts.insertSection,
    beforeHeading: opts.beforeHeading,
```

next to the existing `section: opts.section`.

- [ ] **Step 7: Run help and sync tests**

Run:

```bash
npm test -- cli-help-surface.test.ts sync.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/cli/src/cli/commands/sync.ts packages/cli/test/cli-help-surface.test.ts
git commit -m "Add scoped section CLI flags"
```

### Task 5: Add CLI Validation Tests

**Files:**
- Modify: `packages/cli/test/cli-help-surface.test.ts`
- Modify if needed: `packages/cli/src/cli/commands/sync.ts`

- [ ] **Step 1: Add invalid-combination tests**

Append these tests to `packages/cli/test/cli-help-surface.test.ts`:

```ts
  it('rejects insert-section without a relative target', async () => {
    const result = await runCli(['sync', 'doc.md', 'doc1234567890123', '--insert-section', 'New']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--insert-section requires --before-section or --after-section.');
  });

  it('rejects before-section without insert-section', async () => {
    const result = await runCli(['sync', 'doc.md', 'doc1234567890123', '--before-section', 'Existing']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--before-section and --after-section require --insert-section.');
  });

  it('rejects multiple scoped sync modes', async () => {
    const result = await runCli([
      'sync',
      'doc.md',
      'doc1234567890123',
      '--section',
      'Existing',
      '--before-heading',
      'How it works'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Scoped sync options are mutually exclusive: --section, --before-heading.');
  });
```

If the local `runCli()` helper currently does not expose `status`, change its return type from:

```ts
Promise<{ stdout: string; stderr: string }>
```

to:

```ts
Promise<{ stdout: string; stderr: string; status: number | null }>
```

and include:

```ts
status: result.status
```

in its return object.

- [ ] **Step 2: Run validation tests**

Run:

```bash
npm test -- cli-help-surface.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add packages/cli/test/cli-help-surface.test.ts packages/cli/src/cli/commands/sync.ts
git commit -m "Validate scoped section CLI options"
```

### Task 6: Final Verification

**Files:**
- Review all modified files

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- section.test.ts sync.test.ts cli-help-surface.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: all Vitest files pass.

- [ ] **Step 4: Inspect diff**

Run:

```bash
git diff --stat HEAD
git diff HEAD -- packages/cli/src/sync/section.ts packages/cli/src/sync/run-sync.ts packages/cli/src/cli/commands/sync.ts
```

Expected: only scoped section workflow files changed. No generated files, receipts, `.env`, or `dist/` output.

- [ ] **Step 5: Commit final cleanup if needed**

If Task 6 changed files:

```bash
git add packages/cli/src packages/cli/test
git commit -m "Polish scoped section workflow"
```

If no files changed, do not create an empty commit.

## Self-Review

Spec coverage:

- `insert-section before existing heading`: Task 1, Task 2, Task 3, Task 4.
- `insert-section after existing heading`: Task 1, Task 2, Task 4.
- `before-heading` prefix replacement: Task 1, Task 2, Task 3, Task 4.
- Dry-run range visibility: uses existing `patchPlan.section` output path; covered by Task 3 expectations.
- Write safety: uses existing `applyPatch()` create-before-delete behavior; covered by Task 3 write tests.
- Invalid CLI combinations: Task 4 helpers, Task 5 tests.

Placeholder scan:

- No task says TBD/TODO/implement later.
- Every code-changing step includes concrete code.
- Each verification step has a command and expected outcome.

Type consistency:

- CLI normalized option is `insertSection`.
- `SyncOptions` field is `insertSection`.
- Section planner option field is `insertSection`, with CLI mapping from `heading`.
- Prefix option is consistently `beforeHeading`.
