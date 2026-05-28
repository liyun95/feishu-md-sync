---
name: feishu-baseline-sync
description: Use when pulling a Feishu doc into local Markdown as a baseline before editing or comparing changes
---

# Feishu Baseline Sync

## Required Discovery

Run:

```bash
md2feishu workflow show baseline-sync --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Do not write to Feishu in this workflow.
- Prefer official-first Markdown behavior when the CLI default supports it.
- Save pulled Markdown to an explicit output path.
- After pull, run status or diff before suggesting any write workflow.

## Completion

The workflow is complete when the local Markdown baseline exists and the user knows whether it matches the current Feishu document.
