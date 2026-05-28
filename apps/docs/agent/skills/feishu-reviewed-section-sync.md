---
name: feishu-reviewed-section-sync
description: Use when only one reviewed Feishu document section should be updated from local Markdown while preserving the rest of the remote doc
---

# Feishu Reviewed Section Sync

## Required Discovery

Run:

```bash
md2feishu workflow show reviewed-section-sync --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Start with `diff`.
- Dry-run `sync --section` before any write.
- The section heading must be unique locally and remotely.
- Do not use whole-document `sync --write` unless the user explicitly changes the task.
- Section writes do not update the whole-document receipt; explain this if the user asks about later status output.

## Completion

The workflow is complete when the selected section write passes readback verification.
