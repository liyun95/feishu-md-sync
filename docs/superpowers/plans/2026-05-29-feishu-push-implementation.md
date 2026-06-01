# Feishu Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the clean-break `feishu-push` workflow as the default local-Markdown-to-Feishu write path.

**Architecture:** Reuse the existing sync engine for Feishu reads, Markdown conversion, block-level section planning, writes, and readback verification. Add a push-facing planner/output layer that maps low-level patch plans to user-facing strategies (`block-patch`, `section-replace`, `document-replace`) and gates risky writes. Replace the old `section-sync` workflow/skill/docs surface with `push`.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, VitePress docs, Codex skills.

---

### Task 1: Push Strategy Layer

**Files:**
- Create: `packages/cli/src/sync/push-plan.ts`
- Modify: `packages/cli/src/sync/run-sync.ts`
- Test: `packages/cli/test/push-plan.test.ts`

- [x] Add a first-class push strategy plan that derives user-facing strategy, risk, scope, counts, approval requirement, and fallback reason from `SyncRunResult`.
- [x] Add a run-sync option that can force section replacement instead of block-level section patching.
- [x] Cover small block update, unsafe section fallback, document replacement, and strategy override rejection in tests.

### Task 2: CLI Push Command

**Files:**
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Test: `packages/cli/test/push-cli-output.test.ts`
- Test: `packages/cli/test/cli-help-surface.test.ts`

- [x] Add `md2feishu push <doc.md> <feishu-doc>`.
- [x] Support `--scope heading:"..."`, `--strategy auto|block-patch|section-replace|document-replace`, `--replace-all`, `--write`, `--yes`, `--format pretty|json`, publish transform, markdown engine, host, and timeout.
- [x] Make dry-run default and print intent, selected strategy, scope, risk, operation counts, fallback reason, and approval gate.
- [x] Reject document replacement writes unless `--replace-all` is present.
- [x] Remove `--section` from the public `sync` command surface.

### Task 3: Workflow Registry And Harness Menus

**Files:**
- Modify: `packages/cli/src/workflows/registry.ts`
- Modify: `packages/cli/src/harness/task.ts`
- Modify: `packages/cli/src/harness/tools.ts`
- Modify: `packages/cli/src/harness/grade.ts`
- Modify: `packages/cli/src/workflows/sync/grader.ts`
- Test: `packages/cli/test/workflow-registry.test.ts`
- Test: `packages/cli/test/harness-tools.test.ts`

- [x] Replace workflow id `section-sync` with `push`.
- [x] Update command recipes to use `md2feishu push`.
- [x] Keep baseline workflow unchanged.
- [x] Update tests so `workflow list/show` and harness tool menus expose `push`.

### Task 4: Skills And Install Script

**Files:**
- Create: `skills/feishu-push/SKILL.md`
- Delete: `skills/feishu-section-sync/SKILL.md`
- Modify: `scripts/install-codex-skills.sh`
- Create: `apps/docs/agent/skills/feishu-push.md`
- Delete: `apps/docs/agent/skills/feishu-section-sync.md`

- [x] Add the new installable `feishu-push` skill.
- [x] Remove `feishu-section-sync` from the install list.
- [x] Keep legacy alias cleanup only for old operation-specific skills.
- [x] Update agent skill docs to point to `workflow show push`.

### Task 5: User Docs

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `apps/docs/index.md`
- Modify: `apps/docs/guide/quickstart.md`
- Modify: `apps/docs/guide/workflows.md`
- Modify: `apps/docs/guide/baseline-sync.md`
- Delete or redirect: `apps/docs/guide/section-sync.md`
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/reference/safety-gates.md`
- Modify: `apps/docs/reference/markdown-support.md`
- Modify: `apps/docs/agent/install.md`
- Modify: `apps/docs/agent/skill-roadmap.md`
- Modify: `apps/docs/agent/safe-write-policy.md`
- Modify: related agent/internal pages that still recommend `sync --section`.

- [x] Make `feishu-push` the only documented local-to-Feishu Markdown write workflow.
- [x] Remove normal docs links to Section Sync.
- [x] Explain that block/section/document granularity is chosen by dry-run plan, not by the user up front.
- [x] Include high-risk `--replace-all` gate in safety docs.

### Task 6: Verification

**Files:**
- All touched files.

- [x] Run targeted push/workflow/CLI tests.
- [x] Run full `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run docs:build`.
- [x] Check `rg "feishu-section-sync|section-sync|sync --section"` and classify remaining hits as historical specs/plans only or remove them.
