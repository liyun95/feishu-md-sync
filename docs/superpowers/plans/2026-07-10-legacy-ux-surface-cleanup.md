# Legacy UX Surface Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `feishu-md-sync` expose only the new-core Markdown/Feishu sync surface and remove legacy user and Agent entry points.

**Architecture:** Keep old implementation files in the repository for a later dead-code deletion pass, but stop registering legacy commands and stop installing legacy main-flow skills. Split new-core `status`, `pull`, `diff`, and `merge` command registration out of the old `sync.ts` registrar so the top-level CLI can register only `publish`, `pull`, `status`, `diff`, `merge`, and `doctor auth`.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, VitePress.

---

## Tasks

- [ ] Add a new `packages/cli/src/cli/commands/core.ts` registrar for new-core `status`, `pull`, `diff`, and `merge`, reusing `runStatus`, `runPull`, `runDiff`, `runMerge`, `LarkCliAdapter`, `parseFeishuTarget`, and profile config helpers.
- [ ] Update `packages/cli/src/cli/index.ts` to register only `registerPublishCommand`, `registerCoreCommands`, and `doctor auth`; remove legacy registrars and legacy remote-conflict help.
- [ ] Remove the `md2feishu` bin alias from `packages/cli/package.json`.
- [ ] Update CLI tests so top-level help only exposes new-core commands and old commands are unavailable.
- [ ] Update README and docs entry pages to use `feishu-md-sync` only and to recommend `publish --create` instead of `publish-new`.
- [ ] Update `scripts/install-codex-skills.sh` so old main-flow skills are no longer installed, and retired old main-flow skill directories are removed from the install target.
- [ ] Run `npm run typecheck`, `npm run build`, `npm test`, `npm run docs:build`, and live Feishu smoke.

## Definition of Done

- `feishu-md-sync --help` shows `publish`, `pull`, `status`, `diff`, `merge`, and `doctor` only.
- `sync`, `push`, `publish-new`, `workflow`, `harness`, `multisdk`, `reference`, `release`, and `code-blocks` are not available as CLI commands.
- `packages/cli/package.json` exposes only `feishu-md-sync`.
- Docs and README no longer direct users to old main-flow skills or `md2feishu`.
- Default and live tests pass.

