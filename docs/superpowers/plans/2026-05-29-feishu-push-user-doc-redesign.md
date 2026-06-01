# Feishu Push User Doc Redesign Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Feishu Push user guide so it matches the clarity, workflow framing, and safety explanation quality of the Baseline Sync guide.

**Architecture:** Treat `apps/docs/guide/push.md` as a workflow guide, not a CLI reference page. Preserve the existing command reference in `apps/docs/reference/commands.md`, and add a compact push decision-flow diagram plus troubleshooting sections so users and agents can reason about safe writes before using `--write`.

**Tech Stack:** VitePress Markdown docs, Excalidraw source diagram, exported PNG diagram, existing `md2feishu workflow show push` registry output.

---

## Current Gap

`apps/docs/guide/baseline-sync.md` works because it is organized around the user's job:

- what the workflow does;
- when to use it and when not to;
- the safe execution path;
- how the workflow works;
- local artifacts and receipts;
- safety boundary;
- completion check;
- troubleshooting;
- related reference.

`apps/docs/guide/push.md` currently has the right facts but reads like a short command list. It does not explain:

- why dry-run is the central UX gate;
- how to interpret strategy selection;
- why `--scope` is a guard, not a strategy choice;
- what receipt behavior users should expect after scoped push;
- why `section-replace` and `document-replace` are higher-risk fallbacks;
- how to troubleshoot common refusal and warning messages.

## Target Information Architecture

Restructure `apps/docs/guide/push.md` to this outline:

```markdown
# Feishu Push

## What Feishu push does

### Use this when

### Do not use this when

## Run the workflow

### Start with a dry-run

### Limit the review to one heading

### Write after review

### Replace the whole document only when intentional

## How it works

### Decision flow

### Strategy meanings

### Local artifacts and receipts

### Safety boundary

### Completion check

## Troubleshooting

### `Requested push strategy ... does not match selected strategy ...`

### `Refusing document-replace write without --replace-all`

### `Feishu changed since the last receipt`

### `Scoped push does not update the whole-document receipt`

### `Verification mismatch after write`

### zsh rejects or changes a wiki URL

## Related reference
```

## Desired User Story

After reading the page, a user should understand this workflow:

1. Start from a local Markdown file that already corresponds to an existing Feishu document.
2. Run a dry-run first.
3. Read the selected strategy, risk, scope, and operation counts.
4. If the plan is `block-patch`, approve the write when the changed blocks look right.
5. If the plan is `section-replace`, understand that a whole heading section will be recreated and approve only when that is intentional.
6. If the plan is `document-replace`, use `--replace-all` only after deciding that full replacement is intended.
7. After write, trust readback verification but still visually inspect Feishu for rendered formatting.
8. If scoped push leaves `status` as `diverged`, understand that this can be a receipt limitation rather than a failed write.

---

### Task 1: Rewrite The Push Guide Structure

**Files:**
- Modify: `apps/docs/guide/push.md`

- [ ] **Step 1: Replace the intro and usage boundary**

Replace the top of `apps/docs/guide/push.md` with:

```markdown
# Feishu Push

## What Feishu push does

Feishu push writes local Markdown changes back to an existing Feishu document. It is a local-to-remote workflow: it can write Feishu content, so every write starts with a dry-run strategy plan.

Use this page when you need to understand the workflow. Use `md2feishu workflow show push` when you need the exact command recipe from the installed CLI.

The user does not choose block-level, section-level, or whole-document writes up front. The CLI inspects the local Markdown and current Feishu document, then selects the safest strategy it can explain.

### Use this when

- You edited local Markdown and want to write the changes back to an existing Feishu document.
- You already have a Feishu docx or wiki URL for the target document.
- You need a dry-run plan before approving a Feishu write.
- You want an agent to choose the write strategy from the current local and remote state.

### Do not use this when

- You only need to refresh local Markdown from Feishu. Use [Baseline Sync](/guide/baseline-sync).
- Your local Markdown does not have a Feishu document yet. Use [Publish New](/guide/publish-new).
- You are updating verified SDK code blocks. Use [Multi-SDK Examples](/guide/multisdk-workflow).
- You are releasing audited SDK references to `web-content`. Use [SDK Reference Release](/guide/sdk-reference-release-workflow).
```

- [ ] **Step 2: Rewrite the execution section**

Replace the current `Run the workflow`, `Dry-run first`, `Optional heading scope`, `Write after review`, and `Whole-document replacement` sections with:

````markdown
## Run the workflow

Ask Codex to use:

```text
feishu-push
```

Or inspect the CLI recipe directly:

```bash
md2feishu workflow show push
```

### Start with a dry-run

```bash
md2feishu push doc.md '<feishu-doc>'
```

Expected result:

```text
Intent: push local Markdown to Feishu
Selected strategy: block-patch
Scope: FAQ section
Risk: low

Planned Feishu changes:
- update 1 blocks
- create 0 blocks
- delete 0 blocks

Run with --write to apply this plan.
```

Before approving a write, check:

- `Selected strategy`: whether the CLI plans `block-patch`, `section-replace`, or `document-replace`.
- `Scope`: whether the planned write is bounded to the expected section or affects the entire document.
- `Risk`: low for small block patches, medium for section replacement, high for document replacement.
- Operation counts: whether update/create/delete counts match the review intent.
- Fallback reason: why the CLI could not use a smaller patch, if a fallback is selected.

### Limit the review to one heading

Use a heading scope as a guard when only one named section should be considered:

```bash
md2feishu push doc.md '<feishu-doc>' --scope heading:"FAQ"
```

The scope does not mean the user has chosen section replacement. The planner can still use block-level updates inside that section when safe.

### Write after review

```bash
md2feishu push doc.md '<feishu-doc>' --write
```

Use `--yes` only when the dry-run has already been reviewed:

```bash
md2feishu push doc.md '<feishu-doc>' --write --yes
```

Expected write result:

```text
Applied Feishu changes:
- update 1 blocks
- create 0 blocks
- delete 0 blocks
Readback verification: passed
```

### Replace the whole document only when intentional

If the dry-run selects `document-replace`, the write is refused unless full replacement is explicit:

```bash
md2feishu push doc.md '<feishu-doc>' --strategy document-replace --replace-all --write --yes
```

Use this only when replacing the existing Feishu document is intentional.
````

### Task 2: Add Push Decision Flow Diagram

**Files:**
- Create: `apps/docs/public/diagrams/push-how-it-works.excalidraw`
- Create: `apps/docs/public/diagrams/push-how-it-works.png`
- Modify: `apps/docs/guide/push.md`

- [ ] **Step 1: Create the diagram source**

Create an Excalidraw diagram with this visual structure:

```text
Local Markdown changed
        |
        v
Dry-run strategy plan
        |
        v
Can safely patch individual blocks?
   | yes                         | no
   v                             v
block-patch                Can bound to one heading?
low risk                        | yes                  | no
   |                            v                      v
   v                       section-replace        document-replace
Write after review        medium risk             high risk
   |                       explicit approval       --replace-all
   v                            |                      |
Readback verification <---------+----------------------+
   |
   v
Visual inspection
```

Design constraints:

- Keep the diagram shorter than the baseline diagram.
- Do not show CLI commands inside the diagram.
- Use workflow decision labels only.
- Keep the main success path vertical: dry-run -> block-patch -> write -> readback -> visual inspection.
- Put `section-replace` and `document-replace` as side fallback paths.

- [ ] **Step 2: Export the diagram PNG**

Export the diagram to:

```text
apps/docs/public/diagrams/push-how-it-works.png
```

The image should be readable at the normal VitePress content width without taking a full page height.

- [ ] **Step 3: Reference the diagram in the guide**

Add this under `## How it works`:

```markdown
### Decision flow

![Feishu push decision flow](/diagrams/push-how-it-works.png)

Feishu push starts with a dry-run strategy plan. The safest normal path is `block-patch`: the CLI updates, creates, or deletes only the small block ranges that match the local edit. If that is unsafe, the planner falls back to a larger strategy and makes the approval boundary explicit.
```

### Task 3: Add Strategy, Receipt, Safety, And Completion Sections

**Files:**
- Modify: `apps/docs/guide/push.md`

- [ ] **Step 1: Add strategy meanings**

Add after the decision flow:

```markdown
### Strategy meanings

| Strategy | What it writes | Risk | Approval expectation |
| --- | --- | --- | --- |
| `block-patch` | Small block updates, creates, or deletes when the local and remote structure can be matched safely. | Low | Review the dry-run counts and write after approval. |
| `section-replace` | Recreates one heading section when block-level patching is unsafe but the change is still bounded to a unique heading. | Medium | Confirm that replacing the whole section is intentional. |
| `document-replace` | Replaces the whole Feishu document content. | High | Requires `--replace-all` and explicit human intent. |

The strategy is selected by the dry-run. Do not force a larger strategy unless the dry-run explains why the smaller strategy is unsafe.
```

- [ ] **Step 2: Add local artifacts and receipts**

Add:

```markdown
### Local artifacts and receipts

Feishu push can update the local `.sync/feishu/...json` receipt after a whole-document write. The receipt records the source hash, Feishu state hash, block counts, write result, and readback verification result.

Scoped push is different. When the write is limited to a heading scope, the CLI verifies readback but does not update the whole-document receipt. A later `md2feishu status` may report `diverged` even though the scoped write passed verification.

When this happens, inspect the write output and readback evidence before assuming the push failed.
```

- [ ] **Step 3: Add safety boundary**

Add:

```markdown
### Safety boundary

Feishu push can write remote Feishu content. A dry-run never writes Feishu.

The default safe path is:

1. Run dry-run.
2. Review selected strategy, scope, risk, and operation counts.
3. Write only after the plan matches the intended change.
4. Verify readback.
5. Visually inspect the rendered Feishu document when content changed.

Do not use `--replace-all` unless replacing the whole document is intentional.
```

- [ ] **Step 4: Replace completion check**

Replace the current completion section with:

```markdown
### Completion check

Feishu push is complete when:

- The dry-run plan was reviewed.
- Any required approval gate was satisfied.
- The write passed readback verification.
- Rendered Feishu content was visually inspected when document content changed.
- Any post-write `status` mismatch is explained before starting another write workflow.
```

### Task 4: Add Troubleshooting

**Files:**
- Modify: `apps/docs/guide/push.md`

- [ ] **Step 1: Add troubleshooting sections**

Add before `## Related reference`:

````markdown
## Troubleshooting

### `Requested push strategy ... does not match selected strategy ...`

The forced `--strategy` does not match the strategy selected by the dry-run.

Run without a forced strategy first:

```bash
md2feishu push doc.md '<feishu-doc>'
```

Use the selected strategy unless there is a specific reason to stop and choose a different workflow.

### `Refusing document-replace write without --replace-all`

The plan would replace the whole document. The CLI refuses this unless full replacement is explicit.

Review the dry-run. If full replacement is intentional:

```bash
md2feishu push doc.md '<feishu-doc>' --strategy document-replace --replace-all --write --yes
```

### `Feishu changed since the last receipt`

The remote document changed after the local receipt was written. For scoped push, the CLI can still write only the requested heading in the current remote document, but the warning should be reviewed.

If the remote edits are unexpected, stop and run:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
```

### `Scoped push does not update the whole-document receipt`

The scoped write passed readback verification, but the whole-document receipt was not updated. A later `status` may report `diverged`.

Use the push output and any independent readback pull to verify the scoped write:

```bash
md2feishu pull '<feishu-doc>' --output doc.readback.md --overwrite
diff -u doc.md doc.readback.md
```

### `Verification mismatch after write`

Readback did not match the expected block state after the write. Stop and inspect the Feishu document before retrying. Do not rerun with a larger strategy until the mismatch is understood.

### zsh rejects or changes a wiki URL

Quote the Feishu document URL:

```bash
md2feishu push doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```
````

### Task 5: Update Related References And Nearby Docs

**Files:**
- Modify: `apps/docs/guide/push.md`
- Modify: `apps/docs/reference/safety-gates.md`
- Modify: `packages/cli/README.md`

- [ ] **Step 1: Add receipts to related reference**

At the bottom of `apps/docs/guide/push.md`, make the related reference list:

```markdown
## Related reference

- [Choose a Workflow](/guide/workflows)
- [Baseline Sync](/guide/baseline-sync)
- [Publish New](/guide/publish-new)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Receipts](/reference/receipts)
```

- [ ] **Step 2: Keep command docs short**

Check `packages/cli/README.md` and `apps/docs/reference/commands.md`. They should list command syntax, but the user guidance should point to `apps/docs/guide/push.md`. Do not duplicate the full workflow explanation there.

- [ ] **Step 3: Safety gates alignment**

Check `apps/docs/reference/safety-gates.md` and ensure it names:

- dry-run strategy gate;
- `--replace-all` gate;
- readback verification;
- visual inspection;
- scoped receipt caveat.

### Task 6: Verification

**Files:**
- All touched docs and diagram files.

- [ ] **Step 1: Scan for forbidden old framing**

Run:

```bash
rg -n "section sync|sync --section|reviewed section sync|choose section replacement" apps/docs/guide/push.md apps/docs/reference/safety-gates.md packages/cli/README.md
```

Expected: no hits that describe `section-sync` as the current user-facing workflow.

- [ ] **Step 2: Build docs**

Run:

```bash
npm run docs:build
```

Expected: VitePress build passes.

- [ ] **Step 3: Check whitespace**

Run:

```bash
git diff --check apps/docs/guide/push.md apps/docs/public/diagrams/push-how-it-works.excalidraw apps/docs/public/diagrams/push-how-it-works.png apps/docs/reference/safety-gates.md packages/cli/README.md
```

Expected: no output and exit code 0.

- [ ] **Step 4: Review rendered page**

Run:

```bash
npm run docs:dev
```

Open `/guide/push` and verify:

- The page reads like a workflow guide, not a command reference.
- The decision diagram is readable without occupying most of the page.
- `Use this when` and `Do not use this when` clearly distinguish Baseline Sync, Publish New, Feishu Push, Multi-SDK Examples, and SDK Reference Release.
- The receipt caveat explains why scoped push can pass readback while later status reports `diverged`.
- Troubleshooting headings match real CLI messages.

## Completion Criteria

- `apps/docs/guide/push.md` follows the same workflow-guide shape as `apps/docs/guide/baseline-sync.md`.
- The page explains dry-run strategy review, heading scope, strategy meanings, receipts, safety boundary, completion check, and troubleshooting.
- A compact push decision-flow diagram exists and is referenced from the guide.
- Nearby reference docs remain concise and point users back to the guide.
- `npm run docs:build` passes.
