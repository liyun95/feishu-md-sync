# Section Sync UX Hardening Experiment Plan

> **For agentic workers:** This is the design plan for the live experiment. Do not implement hardening changes until the live evidence section has been filled in. Use `feishu-section-sync` for the workflow under test, and keep the CLI workflow registry as the source of truth for command sequencing.

**Goal:** Test the real `feishu-section-sync` workflow end to end, record the evidence, and identify UX hardening work that makes local-section-to-Feishu writes safe, explainable, and easy for agents to run.

**Architecture:** Treat `md2feishu sync --section` as the low-level Feishu write primitive. The skill should orchestrate a workflow that starts from a known local baseline, checks the selected section, dry-runs the block-level patch, writes only after approval, and verifies both readback hashes and human-visible Feishu output. Official Feishu Markdown export remains the baseline pull/readback path; section writes still use Docx block APIs because official Markdown conversion does not preserve existing remote block IDs by itself.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, Feishu Docx block APIs, official Feishu Markdown export, local Markdown renderer for section planning, VitePress docs, Codex skills.

---

## Current State

The `section-sync` registry recipe currently exposes three steps:

1. `diff`: inspect local versus remote changes.
2. `dry-run`: plan `md2feishu sync <doc.md> <feishu-doc> --section "<heading>"`.
3. `write`: run the same command with `--write -y`.

The implementation already has important safety features:

- Section heading must be unique locally and remotely.
- Auto-mode uses official Markdown for pull/readback, but local rendering for stable section planning.
- Block-level section planning can update text-like blocks in place, create inserted blocks, delete removed blocks, or fall back to bounded range replacement.
- Unsafe block-level fallback writes are refused.
- Section writes do not update the whole-document receipt, so later whole-document status may need explanation.

The previous live test exposed two UX risks that this experiment must verify again:

- Escaped Markdown such as `\&\#39;`, `\.`, and `\_` must not be written back as visible text.
- The workflow should avoid deleting and recreating the whole section when a small block-level update is possible.

## Planned Deliverables

This experiment should produce four artifacts before implementation starts:

1. A refreshed local baseline Markdown file under `/Users/liyun/Downloads/`.
2. A live-run evidence section in this document with exact commands and results.
3. A UX problem list grounded in the live run, not only in code inspection.
4. A follow-up implementation plan for the confirmed hardening work.

Do not jump from a dry-run result directly to implementation. The output that matters here is the evidence-backed workflow design.

## Experiment Document

Use the same real Feishu document unless the user provides a replacement:

```text
https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true
```

Use a local working file under `/Users/liyun/Downloads/` so the user can inspect the exact artifact. The preferred file name is:

```text
/Users/liyun/Downloads/feishu-md-sync-section-sync-live.md
```

The target section should be a unique heading with enough structure to exercise real docs content. `FAQ` is the first candidate because earlier testing showed escaped text and visible Feishu write-history concerns there. If `FAQ` is not unique locally or remotely, stop and choose another unique section before writing.

## Experiment Variables

Keep these explicit so repeated runs are comparable:

| Variable | Default | Why it matters |
| --- | --- | --- |
| Remote Feishu document | `https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true` | Uses the same document family as the baseline-sync test. |
| Local baseline path | `/Users/liyun/Downloads/feishu-md-sync-section-sync-live.md` | Gives the user a stable artifact to inspect. |
| Candidate heading | `FAQ` | Exercises long prose, punctuation, inline code, bullets, and previous escaped-Markdown failures. |
| Markdown engine mode | `auto` | Matches normal CLI defaults: official export/readback plus local section planning. |
| Write scope | One unique heading section | The experiment is invalid if it becomes a whole-document write. |
| Approval gate | User-approved live write after dry-run | The write target is a real Feishu document. |

## Experiment Workflow

### Phase 1: Prepare a Clean Baseline

Use `feishu-baseline-sync` or the equivalent CLI workflow to pull the current remote Feishu content to the local working file.

Expected evidence:

- The local Markdown file exists at `/Users/liyun/Downloads/feishu-md-sync-section-sync-live.md`.
- The file is readable and does not contain obvious raw escaped Feishu Markdown in normal prose.
- If a baseline receipt is written, `md2feishu status` is clean immediately after pull.

Do not manually edit the file until the baseline content has been inspected.

### Phase 2: Make a Minimal Local Section Edit

Edit only the selected local section. Use a small, reversible acceptance note that is easy for the user to find in Feishu.

Recommended first edit:

```markdown
Live sync acceptance note: section-sync updated this line from local Markdown on 2026-05-29.
```

Recommended second edit, only if the first edit is clean:

```markdown
- Live sync acceptance bullet: inserted by section-sync on 2026-05-29.
```

Expected evidence:

- `git diff` is irrelevant because the file is outside the repo; use `diff -u` against a copied baseline or show the edited section.
- No content outside the selected heading section is intentionally changed.
- Existing links, inline code, XML-like include tags, apostrophes, underscores, and punctuation remain human-readable in the local Markdown.

### Phase 3: Dry-Run the Section Write

Run the workflow recipe first:

```bash
npm exec -- md2feishu workflow show section-sync --format json
```

Then dry-run the selected section:

```bash
npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --format json
```

Expected evidence:

- `patchPlan.operation` is `replace-section` only as the high-level section boundary, while `blockLevelSectionPatch.kind` is `block-level-section-patch`.
- For a text-only edit, dry-run shows one or more `update` operations and no whole-section delete/recreate fallback.
- For a bullet insertion, dry-run shows a small `create` operation and no broad delete.
- `unsafeForWrite` is absent or false.
- Warnings are understandable and do not imply hidden whole-document writes.

If the dry-run reports `replace-range`, `block fallback write: unsafe`, escaped Markdown preflight warnings, duplicate headings, or unexpectedly high create/delete counts, stop before writing and record the evidence.

### Phase 4: Write With Approval

Only write after the dry-run evidence is scoped and the user has approved the live write.

```bash
npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --write -y --format json
```

Expected evidence:

- Write result reports the intended number of updated, created, and deleted blocks.
- Readback verification passes.
- The command output explicitly says section sync does not update the whole-document receipt.
- No whole-document sync command is used.

### Phase 5: Verify Remote UX

After the write, verify the actual Feishu document, not only CLI hashes.

Expected evidence:

- The acceptance note is visible under the selected section.
- No visible escaped Markdown pollution appears around the edited content.
- Non-target sections are still present and visually unchanged.
- Feishu edit history should look like focused block updates/inserts when the dry-run predicted block-level updates or creates. A full section delete/recreate is acceptable only if the dry-run explicitly reported a bounded fallback and the user approved that fallback.

### Phase 6: Record Findings

Create or update a live run section in this document after the experiment. Record:

- Commands run.
- Local file path.
- Selected section heading.
- Dry-run summary.
- Write summary.
- Readback result.
- Visual Feishu result.
- Any mismatch between what the CLI said and what the user saw.

## Stop Conditions

Stop the experiment before any Feishu write if one of these appears:

| Condition | Why it stops the run | Next action |
| --- | --- | --- |
| Local file was not freshly pulled or intentionally reviewed | Section sync should not write from a stale local draft by accident. | Refresh baseline or ask the user to confirm the local file is authoritative. |
| Target heading is missing or duplicated locally | The CLI cannot prove which local section should be written. | Pick a unique heading or fix the local Markdown. |
| Target heading is missing or duplicated remotely | The CLI cannot prove which remote section should be replaced. | Pick a unique heading or fix the Feishu document. |
| Dry-run reports `unsafeForWrite` | The write would be too broad or structurally risky. | Record the dry-run and design a safer patch strategy. |
| Dry-run shows broad delete/create for a small edit | UX would regress to the earlier full-section replacement concern. | Stop and inspect block-level planner behavior before writing. |
| Local section contains visible raw escaped Feishu Markdown | The write may pollute Feishu with escaped text. | Re-pull with official normalization or fix the source before dry-run. |
| User cannot inspect the target Feishu document after write | CLI readback is not enough for this UX experiment. | Delay write until visual verification is possible. |

## Evidence Capture

For each command, capture enough output to reproduce the decision:

```bash
npm exec -- md2feishu workflow show section-sync --format json
npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --format json
npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --write -y --format json
```

When summarizing JSON output in this document, preserve these fields:

- `mode`
- `patchPlan.operation`
- `patchPlan.section`
- `blockLevelSectionPatch.kind`
- `blockLevelSectionPatch.operations`
- `blockLevelSectionPatch.fallbackReason`
- `blockLevelSectionPatch.unsafeForWrite`
- `receipt.writeResult`
- `receipt.verificationResult`
- `warnings`

Do not paste secrets, app IDs, app secrets, tenant tokens, or full auth diagnostics into the plan.

## Target User Experience

For a normal team member, the workflow should feel like this:

```text
I pulled the latest Feishu document to local Markdown.
I edited one section locally.
I asked the agent to sync that section back.
The agent showed exactly what section and blocks would change.
After I approved the write, only that section changed in Feishu.
The final Feishu page looked like normal Feishu content, not escaped Markdown.
```

For an agent, the workflow should be deterministic:

1. Load `md2feishu workflow show section-sync --format json`.
2. Confirm the local file is a recent baseline or explicitly refresh it first.
3. Confirm the target heading is unique locally and remotely.
4. Dry-run `sync --section` and summarize block-level operations in plain language.
5. Ask for write approval when the dry-run is scoped and safe.
6. Write, verify readback, and ask the user to visually inspect Feishu for formatting and edit-history quality.

## Live Run Evidence

Fill this section during the actual experiment.

### Run 1: Baseline And Text Edit

| Field | Value |
| --- | --- |
| Date | 2026-05-29 |
| Remote document | `https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true` |
| Local file | `/Users/liyun/Downloads/feishu-md-sync-section-sync-live.md` |
| Section heading | `FAQ` |
| Baseline command | `npm exec -- md2feishu pull '<feishu-doc>' --output /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md --write-receipt` |
| Baseline result | Wrote local file and baseline receipt; CLI printed `baseline: clean`. Follow-up `status` reported `state: clean`, `local changed: false`, `remote changed: false`. |
| Local edit summary | Replaced one existing FAQ acceptance-note paragraph: `block-level section sync wrote this line from local Markdown on 2026-05-28` -> `feishu-section-sync updated this line from local Markdown on 2026-05-29`. |
| Dry-run command | `npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --format json` |
| Dry-run patch mode | `patchPlan.operation: replace-section`; `blockLevelSectionPatch.kind: block-level-section-patch`. |
| Dry-run update/create/delete counts | `update: 1`, `create: 0`, `delete: 0`; high-level section boundary had `deleteCount: 19`, `createCount: 19`, but actual block-level operation was one text-like block update. |
| Dry-run fallback or warning | No `fallbackReason`; no `unsafeForWrite`; warning: section sync used local Markdown renderer for stable block-level planning while official export remains enabled for pull/readback. |
| Write command | `npm exec -- md2feishu sync /Users/liyun/Downloads/feishu-md-sync-section-sync-live.md '<feishu-doc>' --section "FAQ" --write -y --format json` |
| Write result | Passed. `receipt.writeResult` reported `mode: write`, `updated: 1`, `created: 0`, `deleted: 0`, `skipped: false`. CLI warnings said section sync used Feishu block-level patching and did not update the whole-document receipt. |
| Readback verification | Passed. CLI write verification had `ok: true` with matching expected/actual hash `ebe6f17cac5365f9e5f1c02359591630638627e8b09df34947a5e04f341f6f69`. Independent `pull` to `/private/tmp/feishu-md-sync-section-sync-readback.md` contained the updated FAQ note, and `diff -u` against the local file was empty. |
| Feishu visual result | Passed by human inspection. API readback also confirmed the rendered source content is present with no obvious escaped Markdown pollution around the edited FAQ lines. |
| Feishu edit-history result | Passed by human inspection. CLI evidence says the write used one block-level `update`, not create/delete. |
| UX issue found | Two issues. First, `md2feishu diff` produced a whole-document diff for a one-line section edit. The relevant change was visible, but the output was too noisy for section-sync approval. Second, `md2feishu status` after the successful section write reported `state: diverged`, `local changed: true`, `remote changed: true` because section sync intentionally does not update the whole-document receipt. This is technically explainable but confusing after a verified successful section write. |

Run 1 human verification passed. It is safe to proceed to Run 2 small insertion with the same dry-run-before-write gate.

### Run 2: Small Insertion

Run only if Run 1 is clean.

| Field | Value |
| --- | --- |
| Date | 2026-05-29 |
| Local edit summary | Inserted one bullet directly after the FAQ acceptance-note paragraph: `Live sync acceptance bullet: inserted by feishu-section-sync on 2026-05-29.` |
| Dry-run patch mode | `patchPlan.operation: replace-section`; `blockLevelSectionPatch.kind: block-level-section-patch`. |
| Dry-run update/create/delete counts | `update: 0`, `create: 1`, `delete: 0`; high-level section boundary had `deleteCount: 19`, `createCount: 20`, but actual block-level operation was one bullet block create at index `107`. |
| Write result | Passed. `receipt.writeResult` reported `mode: write`, `created: 1`, `updated: 0`, `deleted: 0`, `skipped: false`. CLI warnings said section sync used Feishu block-level patching and did not update the whole-document receipt. |
| Readback verification | Passed. CLI write verification had `ok: true` with matching expected/actual hash `43b246e19ca3209b6df27f5aa4682c16e0ebd8f48761ce7283bc8a3ca6c51acd`. Independent `pull` to `/private/tmp/feishu-md-sync-section-sync-run2-readback.md` contained the updated FAQ note plus inserted bullet, and `diff -u` against the local file was empty. |
| Feishu visual result | Passed by human inspection. API readback also confirmed the bullet is present with no obvious escaped Markdown pollution around the edited FAQ lines. |
| Feishu edit-history result | Passed by human inspection. The user confirmed the inserted bullet looked like a normal small-scope edit. CLI evidence says the write used one block-level `create`, not section delete/recreate. |
| UX issue found | Dry-run and write were safe, but both warned `Feishu changed since the last receipt; section sync will replace only section "FAQ" in the current remote document.` This is expected after Run 1 because section sync does not update the whole-document receipt, but the wording is noisy for a deliberate sequence of section writes. Follow-up `status` still reported `state: diverged`, `local changed: true`, `remote changed: true` after a verified successful write. |

Run 2 human verification passed.

## Experiment Result

The core section-sync behavior passed both live runs:

- A one-line paragraph edit planned and wrote as one block-level `update`.
- A one-bullet insertion planned and wrote as one block-level `create`.
- Neither run used a full-section delete/recreate path.
- CLI readback verification passed for both writes.
- Independent official pull readback matched the local Markdown after each write.
- Human Feishu inspection confirmed normal visual output and small-scope edit history for both runs.

The implementation is safe enough for the tested small edit classes, but the workflow UX still needs hardening before team rollout.

## Confirmed UX Problems

| Problem | Evidence | Impact |
| --- | --- | --- |
| Whole-document diff is too noisy for section approval | Run 1 changed one FAQ line, but `md2feishu diff` emitted a whole-document diff. | Agents and users must hunt for the relevant section change before approving a write. |
| High-level `replace-section` wording hides the actual block-level operation | Dry-run showed `patchPlan.operation: replace-section` even though `blockLevelSectionPatch.operations` was one `update` or one `create`. | A user may think the CLI is about to replace the whole section unless the agent explains the lower-level plan. |
| Receipt warning is noisy for sequential section writes | Run 2 dry-run and write warned that Feishu changed since the last receipt because Run 1 did not update the whole-document receipt. | Correct behavior reads like a conflict warning, even when the previous section write was intentional and verified. |
| `status` reports `diverged` after verified section writes | After both successful writes, `status` still reported local and remote changed because section sync does not update the whole-document receipt. | Users may interpret a successful section write as broken or unclean. |
| Skill and docs under-explain visual verification | The skill says readback verification is required, but the live experiment showed visual Feishu inspection is also needed to catch formatting and edit-history UX. | Agents may stop after hash verification without asking the user to inspect Feishu. |

## Hardening Plan

1. Add a section-scoped approval view.
   - Prefer a new CLI output path that shows only the selected local and remote section diff.
   - Use it in the `section-sync` workflow before dry-run approval.

2. Make dry-run output user-facing by default.
   - Keep `patchPlan.operation` for machine compatibility.
   - In pretty output, lead with `patch mode: block-level`, then `block updates`, `block creates`, `block deletes`, fallback reason, and write safety.
   - In docs, explain that `replace-section` is the high-level boundary, not necessarily the write primitive.

3. Improve section-write receipt/status UX.
   - Either write a section-operation receipt/log, or teach `status` to distinguish "whole-document baseline diverged because section writes occurred" from unknown drift.
   - Update warnings so deliberate verified section writes do not read like unexpected remote conflict.

4. Update `feishu-section-sync` skill behavior.
   - Require a recent baseline or explicit user confirmation that the local file is authoritative.
   - Require a section-scoped dry-run summary before write.
   - Finish only after CLI readback and user visual/edit-history confirmation.

5. Redesign Section Sync docs.
   - Make the guide workflow-first, similar to the baseline-sync docs redesign.
   - Include the two live-run examples: one text block update and one bullet insertion.
   - Call out that section sync currently does not update the whole-document receipt.

## Answered UX Hardening Questions

The experiment answered the design questions as follows:

1. `feishu-section-sync` is the right workflow name, but the skill description should explicitly say "push one local Markdown section back to Feishu."
2. The workflow should refresh or explicitly confirm the local baseline before dry-run. The successful runs started from a clean baseline, and that made the write scope easy to trust.
3. Whole-document `diff` is not useful enough as the primary approval view for section sync. It should be replaced or supplemented with a section-scoped preview.
4. JSON dry-run output contains enough data, but user-facing pretty output should lead with the block-level operation summary.
5. Receipt/status behavior is confusing after successful section writes. `status: diverged` is technically explainable but bad UX when readback verification already passed.
6. Feishu edit-history effects matched the CLI block-level summary for the tested update and insert cases.

## Confirmed Hardening Work

These items are confirmed by the live evidence above and can be turned into an implementation plan.

| Area | Candidate hardening | Evidence needed |
| --- | --- | --- |
| Skill trigger | Clarify that `feishu-section-sync` means "write one changed local section to the matching Feishu section." | The live workflow worked, but approval depended on agent explanation of block-level behavior. |
| Baseline dependency | Add an explicit "refresh or confirm baseline" step before dry-run. | Clean baseline made both runs safe; subsequent section writes produced receipt warnings because whole-document baseline was stale. |
| Section approval view | Add a section-scoped diff or preview. | Run 1's whole-document diff was too noisy for a one-line FAQ edit. |
| Dry-run output | Show `patch mode`, update/create/delete counts, fallback reason, and write safety in plain language. | JSON had the right fields, but `replace-section` could scare users without the block-level summary. |
| Receipt/status UX | Explain or introduce section-level operation receipts. | Both successful writes left `status` as `diverged`. |
| Docs | Redesign the Section Sync guide around workflow, not commands. | Current guide does not explain baseline dependency, block-level summary, receipt behavior, or visual verification. |
| Agent docs | Expand `apps/docs/agent/skills/feishu-section-sync.md` beyond install source and command. | Team users need skills, not CLI internals. |

## Acceptance Criteria

The workflow can be considered hardened only when all of these are true:

- A user can say "sync this local section to Feishu" and the agent chooses `feishu-section-sync`, not baseline sync or whole-document sync.
- The workflow starts from a known local baseline or explicitly calls out that the local file may be stale.
- Dry-run blocks the write when the target section is missing, duplicated, unsafe, or likely polluted by raw escaped Feishu Markdown.
- For a small paragraph edit, the write uses block-level update with no full-section delete/recreate.
- For a small insertion, the write creates only the inserted block range.
- Feishu readback verification passes after write.
- Human visual inspection confirms no escaped Markdown pollution and no unintended non-target section changes.
- The skill and guide explain that section writes do not refresh the whole-document receipt.

## Post-Experiment Decision Rule

After the live evidence is recorded, classify the result into one of three outcomes:

| Outcome | Meaning | Follow-up |
| --- | --- | --- |
| Workflow works, docs are unclear | CLI behavior is acceptable, but users or agents must infer too much. | Update skill descriptions, workflow guide, and agent docs first. |
| CLI output is unclear but behavior is safe | The write is scoped, but approval evidence is hard to read. | Improve pretty output, workflow recipe steps, and JSON summaries. |
| Behavior is unsafe or visually wrong | The write changes too much, pollutes escaped Markdown, or fails visual verification. | Write an implementation plan before any more live writes. |

The follow-up plan should be evidence-led: each proposed code or docs change must point back to a live-run field in this document.

## Open Decisions

- Whether to add a dedicated `section-sync` receipt or operation log, instead of relying on whole-document receipts plus warnings.
- Whether workflow registry should add `auth`, `baseline-check`, `section-preview`, and `visual-verify` steps around the current `diff`, `dry-run`, and `write` steps.
- Whether to keep `FAQ` as the recurring smoke-test section or create a dedicated test section in the Feishu document to reduce risk to real content.
- Whether a future CLI command should provide a section-scoped diff to avoid whole-document diff noise.
