---
name: feishu-baseline-sync
description: Use when pulling a Feishu docx or wiki document into local Markdown as the baseline before editing, comparison, or later sync work.
---

# Feishu Baseline Sync

Use the CLI workflow registry as the source of truth. Do not reconstruct the command sequence from memory.

## Required Discovery

Run:

```bash
md2feishu workflow show baseline-sync --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show baseline-sync --format json
```

Follow the returned steps.

## Safety Rules

- This workflow is read-only for Feishu; do not write remote content.
- Save the pulled Markdown to an explicit output path.
- Prefer official-first Markdown export behavior when the installed CLI supports it.
- After pulling, run status or diff before suggesting any write workflow.

## Completion

Finish only when the local Markdown baseline exists and the user knows whether it matches the current Feishu document.
