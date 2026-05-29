# Feishu Push Live Test Plan

> **For agentic workers:** This plan tests the new clean-break `feishu-push` workflow against a real Feishu wiki document. Use `feishu-baseline-sync` for the remote-to-local baseline and `feishu-push` for local-to-Feishu writes. Do not use the retired `feishu-section-sync` workflow.

**Goal:** Verify that the new `feishu-push` skill and CLI workflow can pull a restored Feishu document, plan a scoped local edit, write it back through the new push surface, and verify readback.

**Remote document:** `https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true`

**Local files:**

- Baseline and edited Markdown: `/private/tmp/feishu-md-sync-push-live.md`
- Pre-edit copy: `/private/tmp/feishu-md-sync-push-live.before.md`
- Readback copy: `/private/tmp/feishu-md-sync-push-live.readback.md`

**Target section:** `FAQ`

**Acceptance edit:** Add one scoped test paragraph under `FAQ`:

```text
Live push acceptance note: feishu-push wrote this line from local Markdown on 2026-05-29.
```

## Test Workflow

1. Confirm the installed skill and CLI workflow surface.
   - `~/.codex/skills/feishu-push/SKILL.md` exists.
   - `md2feishu workflow show push --format json` returns workflow id `push`.
   - `md2feishu sync --help` does not expose `--section`.

2. Pull the restored remote Feishu document to a fresh local baseline.
   - Run `md2feishu pull '<feishu-doc>' --output /private/tmp/feishu-md-sync-push-live.md --overwrite --write-receipt`.
   - Copy the baseline to `/private/tmp/feishu-md-sync-push-live.before.md`.
   - Run `md2feishu status /private/tmp/feishu-md-sync-push-live.md '<feishu-doc>'`.
   - Expected: status is clean, or any non-clean state is recorded before pushing.

3. Edit only the `FAQ` section locally.
   - Add the acceptance note under the `FAQ` heading.
   - Confirm the note appears once.

4. Dry-run the new push workflow.
   - Run `md2feishu push /private/tmp/feishu-md-sync-push-live.md '<feishu-doc>' --scope heading:"FAQ"`.
   - Expected: selected strategy is `block-patch`, scope is `FAQ section`, risk is `low`, and the plan creates or updates a small number of blocks.
   - Stop before writing if the selected strategy is `section-replace` or `document-replace`.

5. Execute the real push write.
   - Run `md2feishu push /private/tmp/feishu-md-sync-push-live.md '<feishu-doc>' --scope heading:"FAQ" --write --yes`.
   - Expected: readback verification passes.

6. Pull readback and compare.
   - Run `md2feishu pull '<feishu-doc>' --output /private/tmp/feishu-md-sync-push-live.readback.md --overwrite`.
   - Confirm the acceptance note appears once in readback.
   - Run `diff -u /private/tmp/feishu-md-sync-push-live.md /private/tmp/feishu-md-sync-push-live.readback.md`.
   - Expected: no diff, or only explicitly recorded harmless normalization differences.

7. Human visual verification.
   - Ask the user to inspect the Feishu `FAQ` section.
   - Expected: the acceptance note is visible, formatting looks normal, and no unrelated section changed.

## Stop Conditions

- The remote document cannot be read or written by the configured Feishu app.
- The local or remote `FAQ` section is missing or duplicated.
- Dry-run selects `document-replace`.
- Dry-run selects `section-replace` for this minimal edit.
- The write fails readback verification.
- Readback contains escaped Markdown pollution around the edited content.

## Results

Executed on 2026-05-29 against the real Feishu wiki document.

- Installed skill verified at `/Users/liyun/.codex/skills/feishu-push/SKILL.md`.
- CLI workflow verified with `npm exec -- md2feishu workflow show push --format json`; workflow id is `push`.
- Pulled the restored remote baseline to `/private/tmp/feishu-md-sync-push-live.md` with `--overwrite --write-receipt`.
- Baseline status after pull was clean: local changed `false`, remote changed `false`.
- Local edit replaced the old `Live sync acceptance note...2026-05-28` line with:

```text
Live push acceptance note: feishu-push wrote this line from local Markdown on 2026-05-29.
```

- The edit was limited to one line under `FAQ`; `/private/tmp/feishu-md-sync-push-live.before.md` preserves the pre-edit copy.
- Push dry-run selected `block-patch`, scope `FAQ section`, risk `low`, with update `1`, create `0`, delete `0`.
- Real push command used `--scope heading:"FAQ" --write --yes`.
- Write result: `Applied Feishu changes`, update `1`, create `0`, delete `0`.
- Feishu readback verification passed.
- Pulled readback to `/private/tmp/feishu-md-sync-push-live.readback.md`.
- `rg` confirmed the new acceptance line appears once in the edited local file and once in the readback file.
- `diff -u /private/tmp/feishu-md-sync-push-live.md /private/tmp/feishu-md-sync-push-live.readback.md` produced no diff.
- Post-write status is `diverged`, which is expected for the current scoped-push behavior because scoped push does not update the whole-document receipt.

Observed UX issue and follow-up fix:

- The write output previously printed the stale dry-run hint `Run with --write to apply this plan.` after a successful write.
- Fixed `pushResultSummaryLines` so approval guidance is printed only for dry-runs.
- Added a CLI output test covering successful write output.
- Verification after the fix:
  - `npm test -- push-cli-output push-plan` passed.
  - `npm run typecheck` passed.
  - `npm run build` passed.
  - A follow-up real scoped `push --write --yes` against the same Feishu document produced update `0`, create `0`, delete `0`, readback verification `passed`, and did not print the stale `Run with --write` hint.

Human visual verification still needed:

- Inspect the Feishu `FAQ` section and confirm the new `Live push acceptance note...2026-05-29` line is visible, formatting looks normal, and no unrelated section changed.

## Coverage Boundaries

This live test proves the default safe path: a scoped `feishu-push` dry-run selected `block-patch`, then wrote one Feishu block update and passed readback.

It does not prove real Feishu writes for every fallback strategy:

- `section-replace` has unit coverage and planner coverage, but was intentionally not forced against the shared test document because it deletes and recreates a whole heading section.
- `document-replace` has unit coverage, planner coverage, and the `--replace-all` safety gate, but was intentionally not written against the shared test document because it replaces the whole document.
- Whole-document `runSync` write/readback/receipt behavior has fake-client test coverage, not live Feishu write coverage in this run.

Future live coverage for `section-replace` or `document-replace` should use a disposable Feishu document, not the shared wiki document used for baseline and default push acceptance.
