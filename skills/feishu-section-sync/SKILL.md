---
name: feishu-section-sync
description: Use when a named section from local Markdown should be synced into an existing Feishu document while preserving the rest of the remote document.
---

# Feishu Section Sync

Use this to write one named Markdown section from the local file into the matching section of an existing Feishu document. Do not use it for whole-document replacement unless the user changes the task.

## Required Discovery

Run:

```bash
md2feishu workflow show section-sync --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show section-sync --format json
```

Follow the returned steps.

## Safety Rules

- Start with `diff`.
- Dry-run `sync --section` before any write.
- Require a unique section heading locally and remotely.
- Treat the dry-run review as the approval gate before `--write`.
- Do not use whole-document `sync --write` unless the user explicitly changes the task.
- Explain that section writes do not update the whole-document receipt if later status output looks unexpected.

## Completion

Finish only when the selected section write passes readback verification.
