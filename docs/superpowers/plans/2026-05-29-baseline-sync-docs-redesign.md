# Baseline Sync Documentation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Redesign the Baseline Sync guide so readers understand it as a safe remote-to-local baseline refresh workflow, not just a raw Markdown export command.

**Architecture:** Keep the Baseline Sync guide as the canonical human-facing workflow page, backed by the CLI workflow registry and the `feishu-baseline-sync` skill. Add an Excalidraw decision-flow diagram as the central explanation in `How it works`, and fold local artifacts, baseline receipts, safety boundaries, and completion checks into that explanation instead of scattering them as top-level sections.

**Tech Stack:** VitePress Markdown, static image assets under `apps/docs/public/`, Excalidraw `.excalidraw` source files, `excalidraw-diagram` render pipeline, existing `md2feishu workflow show baseline-sync` CLI output, Node 20+ docs build.

---

## Source Context

This documentation plan must describe the final UX from:

- `docs/superpowers/plans/2026-05-28-baseline-sync-ux-hardening.md`
- `packages/cli/src/workflows/registry.ts`
- `skills/feishu-baseline-sync/SKILL.md`
- `apps/docs/agent/skills/feishu-baseline-sync.md`
- `apps/docs/guide/baseline-sync.md`
- `packages/cli/README.md`

The target behavior is:

- `pull --output <existing-file>` refuses to overwrite without `--overwrite`.
- `pull --write-receipt` records a read-only local baseline receipt.
- A fresh baseline pull with receipt can make `md2feishu status` report a clean baseline.
- Baseline Sync never writes to Feishu.
- Feishu wiki URLs in shell examples are quoted because they often contain `?`.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/docs/guide/baseline-sync.md` | Canonical user-facing Baseline Sync guide. Explains when to use the workflow, how to run it, how the safety model works, and what completion means. |
| `apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw` | Editable Excalidraw source for the `How it works` decision-flow diagram. |
| `apps/docs/public/diagrams/baseline-sync-how-it-works.png` | Rendered diagram embedded in the guide. |
| `apps/docs/agent/skills/feishu-baseline-sync.md` | Agent-facing summary. Only update if it contradicts the redesigned guide or omits the receipt/status expectation. |
| `packages/cli/README.md` | CLI-facing examples. Only update if the baseline examples do not match the final safe workflow. |

---

### Task 1: Confirm Final Workflow Facts Before Writing

**Files:**
- Read: `docs/superpowers/plans/2026-05-28-baseline-sync-ux-hardening.md`
- Read: `packages/cli/src/workflows/registry.ts`
- Read: `skills/feishu-baseline-sync/SKILL.md`
- Read: `apps/docs/agent/skills/feishu-baseline-sync.md`
- Read: `packages/cli/README.md`

- [x] **Step 1: Inspect the implementation plan that defines the target UX**

Run:

```bash
sed -n '1,220p' docs/superpowers/plans/2026-05-28-baseline-sync-ux-hardening.md
sed -n '220,520p' docs/superpowers/plans/2026-05-28-baseline-sync-ux-hardening.md
```

Expected: the plan describes `--overwrite`, `--write-receipt`, baseline receipts, clean status after receipt creation, and safe temp/diff/replace behavior.

- [x] **Step 2: Inspect the current workflow registry**

Run:

```bash
rg "baseline-sync|preview-pull|replace-local|write-receipt|overwrite" packages/cli/src/workflows/registry.ts -n
```

Expected after the UX-hardening implementation lands: the baseline workflow has ordered steps for auth, preview pull, diff review, explicit replacement, and status.

If the registry still shows only `auth`, `pull`, and `status`, write the guide against the target behavior in `docs/superpowers/plans/2026-05-28-baseline-sync-ux-hardening.md` and include a note in the final implementation summary that the docs are staged for that final CLI state.

- [x] **Step 3: Inspect related docs for contradictions**

Run:

```bash
sed -n '1,180p' apps/docs/agent/skills/feishu-baseline-sync.md
sed -n '1,180p' packages/cli/README.md
```

Expected final wording:

- Agent docs say a receipt-backed baseline can make `status` clean.
- README examples quote `<feishu-doc>`.
- Existing-file refresh examples use preview pull, `diff -u`, and final `--overwrite --write-receipt`.

---

### Task 2: Create the Excalidraw Diagram Asset

**Files:**
- Create: `apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw`
- Create: `apps/docs/public/diagrams/baseline-sync-how-it-works.png`

- [x] **Step 1: Create the diagrams directory**

Run:

```bash
mkdir -p apps/docs/public/diagrams
```

Expected: `apps/docs/public/diagrams` exists.

- [x] **Step 2: Use the `excalidraw-diagram` skill rules**

Read:

```bash
sed -n '1,220p' /Users/liyun/skills-hub/personal/excalidraw-diagram/SKILL.md
sed -n '1,220p' /Users/liyun/skills-hub/personal/excalidraw-diagram/references/color-palette.md
```

Expected: the diagram uses semantic colors from `references/color-palette.md`, clean technical styling, and a rendered PNG validation loop.

- [x] **Step 3: Design the diagram as a user decision flow**

Use this visual story:

```text
Title: How baseline sync protects local work

Start:
  Remote Feishu changed

Decision:
  Does the target local file exist?

No branch:
  Pull directly to local Markdown
  Command artifact: md2feishu pull '<feishu-doc>' --output doc.remote.md --write-receipt
  Result: Local Markdown + baseline receipt
  Status: clean baseline

Yes branch:
  Pull to separate remote copy
  Command artifact: md2feishu pull '<feishu-doc>' --output doc.remote.md
  Compare: diff existing file against remote copy
  Decision: Safe to replace?

Safe branch:
  Replace intentionally
  Command artifact: md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
  Result: Local Markdown + baseline receipt
  Status: clean baseline

Unsafe branch:
  Keep files separate
  Review local-only edits before choosing a write workflow

Exit:
  Choose next workflow
  Options: edit locally, run Section Sync, or stop because no write is needed
```

Visual constraints:

- Use a top-to-bottom flow with two branches after the first decision.
- Use a decision diamond for “Does the target local file exist?”.
- Use a second decision diamond for “Safe to replace?”.
- Use warning color for the “Keep files separate” path.
- Use success color for “Status: clean baseline”.
- Use dark evidence artifacts for command examples.
- Do not use decorative characters; this is a technical workflow diagram without a natural actor role.

- [x] **Step 4: Write the `.excalidraw` source file**

Create `apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw` with:

- JSON root `type: "excalidraw"`.
- White background.
- Roughness `0`.
- Descriptive element IDs such as `start_remote_changed`, `decision_target_exists`, `command_new_baseline`, `decision_safe_to_replace`, and `exit_next_workflow`.
- Text labels exactly matching the diagram story in Step 3.

Expected: the file opens as valid Excalidraw JSON and contains no placeholder text.

- [x] **Step 5: Render the PNG**

Run:

```bash
cd /Users/liyun/skills-hub/personal/excalidraw-diagram/references
uv run python render_excalidraw.py /Users/liyun/feishu-md-sync/apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw
```

Expected: `apps/docs/public/diagrams/baseline-sync-how-it-works.png` is created.

- [x] **Step 6: View and validate the rendered diagram**

Open the PNG with the available image viewer tool or local preview.

Validation checklist:

- The eye path starts at “Remote Feishu changed”.
- The two local-file branches are visually obvious.
- Command snippets are readable.
- “Baseline receipt” is visible as a local artifact, not a Feishu write.
- The warning path does not look like a successful completion path.
- No text overlaps or clips.
- Arrows do not pass through labels or command artifacts.
- The diagram can be understood without reading the surrounding prose.

- [x] **Step 7: Fix and re-render until the checklist passes**

Repeat:

```bash
cd /Users/liyun/skills-hub/personal/excalidraw-diagram/references
uv run python render_excalidraw.py /Users/liyun/feishu-md-sync/apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw
```

Expected: the PNG passes the validation checklist without caveats.

---

### Task 3: Rewrite the Baseline Sync Guide Structure

**Files:**
- Modify: `apps/docs/guide/baseline-sync.md`

- [x] **Step 1: Replace the current top-level outline**

Rewrite `apps/docs/guide/baseline-sync.md` with this heading structure:

```md
# Baseline Sync

## What baseline sync does

### Use this when

### Do not use this when

## Run the workflow

### Create a new local baseline

### Refresh an existing local file

## How it works

### Decision flow

### Local artifacts

### Why the receipt matters

### Safety boundary

### Completion check

## Troubleshooting

## Related reference
```

Expected: `Use this when` and `Do not use this when` are H3 sections under `What baseline sync does`, not standalone H2 sections.

- [x] **Step 2: Write the `What baseline sync does` section**

Use this content:

```md
## What baseline sync does

Baseline sync refreshes local Markdown from the current Feishu document. It is a remote-to-local workflow: it can write local Markdown and an optional local baseline receipt, but it never writes content back to Feishu.

Use this page when you need to understand the workflow. Use `md2feishu workflow show baseline-sync` when you need the exact command recipe from the installed CLI.

### Use this when

- The Feishu document changed and you want to pull the current remote content before editing.
- You need a local Markdown baseline for review, comparison, or later section sync.
- You want an agent to refresh local content without risking a Feishu write.

### Do not use this when

- You already have local Markdown changes that should be written to Feishu.
- You want to replace one named Feishu section from local Markdown. Use [Section Sync](/guide/section-sync).
- You want an advanced whole-document write. Inspect the direct CLI reference and safety gates first.
```

Expected: the first paragraph defines the workflow by direction and write target.

- [x] **Step 3: Write the `Run the workflow` section**

Use this content:

````md
## Run the workflow

Ask Codex to use:

```text
feishu-baseline-sync
```

Or inspect the CLI recipe directly:

```bash
md2feishu workflow show baseline-sync
```

### Create a new local baseline

When the output path does not exist, pull directly to that path and write a baseline receipt:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md --write-receipt
```

Expected result:

```text
wrote: doc.remote.md
receipt: .sync/feishu/...
baseline: clean
```

Quote Feishu URLs in shell commands. Wiki URLs often contain `?`, which shells such as zsh can treat as a pattern character when the URL is unquoted.

### Refresh an existing local file

When the requested output file already exists, preview the remote content first:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
```

Replace the existing file only after the diff shows that overwriting is intentional:

```bash
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
md2feishu status doc.md '<feishu-doc>'
```

The final status should report a clean baseline. If it does not, keep the existing file and remote copy separate until the mismatch is understood.
````

Expected: this section avoids the heading `Quick start` and uses `Run the workflow`.

- [x] **Step 4: Write the `How it works` section**

Use this content:

````md
## How it works

### Decision flow

![Baseline sync decision flow](/diagrams/baseline-sync-how-it-works.png)

Baseline sync starts with one UX decision: whether the requested local output already exists. New files can be written directly. Existing files are protected by a preview-and-diff path before any intentional overwrite.

### Local artifacts

Baseline sync can create two local artifacts:

- A Markdown file containing the current Feishu content.
- A `.sync/feishu/...json` baseline receipt when `--write-receipt` is used.

The receipt records the remote state that produced the Markdown file. It is local state only.

### Why the receipt matters

`md2feishu status` is receipt-oriented. Without a receipt, a freshly pulled file can still look noisy because the CLI has no registered baseline for that local path. With a baseline receipt, the CLI can recognize that the local Markdown was created from the current Feishu state and report a clean baseline.

A pull-created receipt does not mean Feishu was written. It records a read-only pull.

### Safety boundary

Baseline sync reads Feishu and writes local files. It does not write Feishu content.

If the target local file already exists, `pull --output <file>` refuses to replace it unless `--overwrite` is explicit. This prevents a remote pull from silently erasing local-only edits.

Any later Feishu write is a separate decision. Use the workflow that matches the intended write target, such as [Section Sync](/guide/section-sync) for one named section.

### Completion check

Baseline sync is complete when:

- The local Markdown file exists at the agreed path.
- The baseline receipt exists if `--write-receipt` was requested.
- `md2feishu status <file> '<feishu-doc>'` reports a clean baseline, or the remaining mismatch has been explained before any write workflow starts.
````

Expected: local artifacts, receipt behavior, safety, and completion are all H3 subsections under `How it works`.

- [x] **Step 5: Write the `Troubleshooting` section**

Use this content:

````md
## Troubleshooting

### `Refusing to overwrite existing output without --overwrite`

The output file already exists. Pull to a separate remote copy, compare it with the existing file, and replace the existing file only when the diff confirms that overwriting is intentional.

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
```

### `status` reports `no-receipt`

The Markdown file exists, but the CLI has not registered it as a baseline for that Feishu document. Pull again with `--write-receipt` if the local file should represent the current remote state.

```bash
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
md2feishu status doc.md '<feishu-doc>'
```

### zsh rejects or changes a wiki URL

Quote the Feishu document URL:

```bash
md2feishu pull 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true' --output doc.remote.md --write-receipt
```
````

Expected: troubleshooting covers the final UX-hardening failure modes.

- [x] **Step 6: Keep related references short**

End with:

```md
## Related reference

- [Choose a Workflow](/guide/workflows)
- [Section Sync](/guide/section-sync)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Receipts](/reference/receipts)
```

Expected: related links point to workflow selection, next write workflow, safety model, CLI syntax, and receipt concept docs.

---

### Task 4: Align Adjacent Docs Only If Needed

**Files:**
- Modify if stale: `apps/docs/agent/skills/feishu-baseline-sync.md`
- Modify if stale: `packages/cli/README.md`

- [x] **Step 1: Check the agent skill page for receipt/status wording**

Run:

```bash
rg "status|receipt|no-receipt|baseline: clean|overwrite" apps/docs/agent/skills/feishu-baseline-sync.md -n
```

Expected: the page states that after the final pull, `md2feishu status` should be clean when a baseline receipt was written.

If that wording is missing, add this paragraph under the default behavior list:

```md
After the final pull, expect `md2feishu status` to be clean when a baseline receipt was written. If status still reports `no-receipt`, explain that the local Markdown exists but has not been registered as a sync baseline.
```

- [x] **Step 2: Check the CLI README baseline examples**

Run:

```bash
rg "write-receipt|overwrite|diff -u|'<feishu-doc>'" packages/cli/README.md -n
```

Expected: the README has:

```bash
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md --write-receipt
```

And the existing-file flow:

```bash
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md
diff -u doc.md feishu.remote.md
npm exec -- md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
```

If the examples differ, replace the stale examples with the commands above.

---

### Task 5: Build and Inspect the Docs Page

**Files:**
- Verify: `apps/docs/guide/baseline-sync.md`
- Verify: `apps/docs/public/diagrams/baseline-sync-how-it-works.png`

- [x] **Step 1: Run the docs build**

Run:

```bash
npm run docs:build
```

Expected: PASS. The build must not report broken Markdown, missing image assets, or invalid links.

- [x] **Step 2: Start the local docs server**

Run:

```bash
npm run docs:dev -- --host 127.0.0.1
```

Expected: VitePress starts and prints a local URL.

- [x] **Step 3: Inspect the page in a browser**

Open:

```text
http://127.0.0.1:<port>/guide/baseline-sync
```

Validation checklist:

- The sidebar still shows `Baseline Sync` under Workflows.
- The page does not have a `Quick start` heading.
- `Use this when` and `Do not use this when` appear under `What baseline sync does`.
- `Run the workflow` contains both new-file and existing-file paths.
- The Excalidraw PNG renders under `How it works`.
- The diagram is not too wide on desktop.
- The diagram remains readable on a narrow/mobile viewport.
- `How it works` contains `Local artifacts`, `Why the receipt matters`, `Safety boundary`, and `Completion check`.
- Troubleshooting covers overwrite refusal, `no-receipt`, and quoted wiki URLs.

- [x] **Step 4: Stop the docs server**

Stop the VitePress process cleanly with `Ctrl-C` or the existing process-management tool.

Expected: no dev server process is left running.

---

### Task 6: Final Review

**Files:**
- Review: `apps/docs/guide/baseline-sync.md`
- Review: `apps/docs/public/diagrams/baseline-sync-how-it-works.excalidraw`
- Review: `apps/docs/public/diagrams/baseline-sync-how-it-works.png`
- Review if modified: `apps/docs/agent/skills/feishu-baseline-sync.md`
- Review if modified: `packages/cli/README.md`

- [x] **Step 1: Check the diff**

Run:

```bash
git diff -- apps/docs/guide/baseline-sync.md apps/docs/public/diagrams apps/docs/agent/skills/feishu-baseline-sync.md packages/cli/README.md
```

Expected:

- The guide is restructured around workflow understanding and safe operation.
- The diagram source and PNG are both present.
- Adjacent docs are changed only if they were stale.
- No generated VitePress output under `apps/docs/.vitepress/dist/` is included.

- [x] **Step 2: Run link and terminology checks manually**

Check these exact terms in the guide:

```bash
rg "baseline sync|baseline receipt|--write-receipt|--overwrite|Section Sync|no-receipt|Quick start" apps/docs/guide/baseline-sync.md -n
```

Expected:

- `baseline sync`, `baseline receipt`, `--write-receipt`, `--overwrite`, `Section Sync`, and `no-receipt` appear in appropriate contexts.
- `Quick start` does not appear.

- [x] **Step 3: Confirm docs build one final time**

Run:

```bash
npm run docs:build
```

Expected: PASS.

- [x] **Step 4: Summarize implementation**

Report:

- The guide was restructured with `Use this when` and `Do not use this when` under `What baseline sync does`.
- The workflow operation section is named `Run the workflow`.
- `How it works` now owns the diagram, local artifacts, receipt behavior, safety boundary, and completion check.
- The Excalidraw source and rendered PNG were added.
- Docs build result.

## Self-Review

- Spec coverage: The plan covers the final UX from the baseline hardening plan, the heading changes requested in discussion, and the Excalidraw diagram requirement.
- Placeholder scan: The plan contains no `TBD`, `TODO`, or unspecified implementation steps.
- Type and naming consistency: The plan consistently uses `baseline receipt`, `--write-receipt`, `--overwrite`, `Run the workflow`, and `How it works`.
- Scope check: The plan is limited to documentation and diagram assets. It does not implement the CLI hardening behavior itself.
