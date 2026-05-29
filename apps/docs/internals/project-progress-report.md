# Project Progress Report

Date: 2026-05-28

This report reviews the CLI UX and stability refactor against the implementation plan in `docs/superpowers/plans/2026-05-28-cli-ux-stability-refactor.md`.

## Executive Summary

The project has moved from a single large command file into a workflow-oriented CLI for Feishu document operations. The main user-facing workflows are now discoverable through `md2feishu workflow list` and `md2feishu workflow show <workflow-id>`, and the default Markdown path uses official Feishu Markdown APIs first through `--markdown-engine auto`.

The current state is good enough for a team walkthrough and controlled dogfooding. It is not yet ready to promote whole-document official Markdown round-trip writes as a default workflow. For reviewed docs, the recommended write path remains section-scoped sync.

## What Is Implemented

| Area | Status | Evidence |
| --- | --- | --- |
| CLI command split | Done | `packages/cli/src/cli/index.ts` is a thin bootstrap. Command registration lives in `packages/cli/src/cli/commands/`. |
| Workflow registry | Done | `packages/cli/src/workflows/registry.ts` defines six workflow recipes. |
| Workflow discovery | Done | `md2feishu workflow list` and `md2feishu workflow show <workflow-id>` are available. |
| Official Markdown export/import adapter | Done | `--markdown-engine auto | official | local` is exposed on sync-related commands. |
| Feishu gateway split | Done | Feishu API adapters live under `packages/cli/src/services/feishu/`. |
| Safer sync planner | Done, conservative | Planner supports no-op, section replacement, contiguous block replacement, and whole-document replacement. |
| Markdown preflight | Done | Unsafe generated links are reported before writes. |
| SDK reference authoring/release split | Done | `sdk-reference-authoring` and `sdk-reference-web-content-release` are separate workflows. |
| Docs restructure | Done | Workflow docs and agent skills point to shared workflow recipes and safety gates. |
| Skill surface | Done | Operation-specific skill pages were removed from docs; installable skills now map to first-class workflows. |
| Harness expansion | Partial | Workflow tool registries exist. Non-`multisdk` graders are conservative placeholders. |

## Live Feishu Smoke Result

Using the updated Feishu app `cli_...dcb3` against:

```text
https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true
```

The following readonly checks passed:

```bash
md2feishu pull "$DOC" --markdown-engine official --output /private/tmp/feishu-md-sync-zxqk-all-perms-official.md
md2feishu pull "$DOC" --markdown-engine auto --output /private/tmp/feishu-md-sync-zxqk-all-perms-auto.md
md2feishu sync --markdown-engine official --format json /private/tmp/feishu-md-sync-zxqk-all-perms-official.md "$DOC"
md2feishu sync --markdown-engine auto --format json /private/tmp/feishu-md-sync-zxqk-all-perms-official.md "$DOC"
```

Observed:

- Wiki URL resolution works.
- Official Feishu Markdown export works.
- Official Markdown-to-block conversion works.
- `auto` and `official` pull output matched exactly.
- The exported Markdown had no whole-URL percent-encoding issue and no unsupported block placeholder.
- Dry-run sync preflight passed with no issues.

Important caveat: full-document dry-run planned `replace-document`, with current Feishu direct children `121` blocks and official converted source `347` blocks. This confirms the official API is usable, but full-document block round-trip is not stable enough to make whole-document overwrite the default write workflow.

## Current User Workflows

### Baseline Pull

Use this when Feishu is the source of truth and a writer wants a local Markdown baseline.

```bash
md2feishu workflow show baseline-sync
md2feishu pull "$DOC" --markdown-engine auto --output doc.remote.md
```

### Feishu Push

Use this when a writer edited local Markdown and wants the CLI to choose the safest Feishu write strategy.

```bash
md2feishu workflow show push
md2feishu push doc.md "$DOC" --scope heading:"Heading"
md2feishu push doc.md "$DOC" --scope heading:"Heading" --write -y
```

This is the recommended Markdown write workflow for reviewed documents.

### Multi-SDK Example Completion

Use this when a Feishu user doc has Python examples and missing Java, JavaScript, Go, or REST examples.

```bash
md2feishu workflow show multisdk-examples
md2feishu multisdk init "$DOC" --out runs/<doc-token>
md2feishu harness tools --workflow multisdk
```

### SDK Reference Authoring

Use this for Feishu writing and audit only.

```bash
md2feishu workflow show sdk-reference-authoring
```

This workflow ends after Feishu reference docs are written and audited.

### SDK Reference Web-Content Release

Use this only after a human explicitly starts release.

```bash
md2feishu workflow show sdk-reference-web-content-release
```

This workflow moves audited Feishu reference docs into an external `web-content` checkout.

### Release Notes

Use this for gated Milvus release-note updates.

```bash
md2feishu workflow show release-notes
```

## What Is Not Finished Yet

| Gap | Impact | Suggested Next Step |
| --- | --- | --- |
| `workflow next <task-dir>` is not implemented | Agents can list/show recipes, but cannot ask the CLI for task-specific next action. | Add `workflow next` backed by task artifact readers. |
| Non-`multisdk` harness graders are placeholders | `harness grade` reports conservative `incomplete` for sync/reference/release workflows. | Implement artifact readers for receipts, patch plans, reference manifests, audit reports, and release approvals. |
| Whole-document official round-trip is not write-safe by default | Official convert can change block granularity significantly. | Keep whole-document writes behind dry-run and explicit confirmation; focus default UX on Feishu push strategy review. |
| Section/block planner needs more real fixtures | Current planner is conservative and should stay that way until tested on more reviewed docs. | Build a fixture corpus from real docs and add regression tests for common edit shapes. |
| Presentation docs are not optimized as a story | README and docs are usable references, but not a ready-made team talk. | Add a short demo script or presentation outline based on this report. |

## Recommended Roadmap

1. Add `workflow next`.
   Start with `multisdk` and release/reference task directories where task artifacts already exist.

2. Make non-`multisdk` harness grading real.
   Convert sync receipts, reference audit reports, web-content export reports, and release approval hashes into grade checks.

3. Promote Feishu push as the default writing story.
   Keep whole-document sync available, but document it as a deliberate operation after reviewing the dry-run plan.

4. Build a live fixture suite.
   Use real Feishu docs to cover cross-reference links, tables, callouts, code fences, details blocks, include tags, and section edits.

For early team dogfooding, use one shared Feishu app with the required document/wiki/Drive/Bitable permissions. Per-user CLI apps can remain a later operational model if attribution or isolation becomes important.

## Can The Team Present From The Current Docs?

Yes, with one caveat.

The current README and VitePress site are good enough for a technical walkthrough:

- Start with `packages/cli/README.md` for install, command overview, and safety model.
- Use `apps/docs/guide/quickstart.md` to explain how users choose workflows.
- Use `apps/docs/guide/workflows.md` to introduce the six supported workflows.
- Use `apps/docs/reference/safety-gates.md` to explain why the CLI defaults to dry-run and fail-closed writes.
- Use this progress report to explain project status, completed work, and remaining gaps.

They are not yet a polished presentation deck. For a team sharing session, use this talk flow:

1. Problem: one-off Feishu scripts were powerful but hard to operate safely.
2. New model: workflow-first CLI with dry-run-first writes.
3. Demo: `workflow list`, `workflow show baseline-sync`, `pull --markdown-engine auto`.
4. Demo: edit local Markdown, run `push`, inspect the selected strategy, then explain write gates.
5. Agent story: skills now select workflow recipes instead of memorizing command sequences.
6. Roadmap: `workflow next`, real graders, fixture corpus.

## Verification Snapshot

Recent local verification:

```bash
npm run typecheck
npm test
```

Recent live Feishu smoke:

```bash
md2feishu pull "$DOC" --markdown-engine official
md2feishu sync --markdown-engine official --format json <exported.md> "$DOC"
```

No write smoke was performed in the latest validation pass.
