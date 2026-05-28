---
name: feishu-reviewed-section-sync
description: Use when one reviewed section of an existing Feishu document should be updated from local Markdown while preserving the rest of the remote document.
---

# Feishu Reviewed Section Sync

Use this for section-scoped writes after review. Do not use it for whole-document replacement unless the user changes the task.

## Required Discovery

Run:

```bash
md2feishu workflow show reviewed-section-sync --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show reviewed-section-sync --format json
```

Follow the returned steps.

## Safety Rules

- Start with `diff`.
- Dry-run `sync --section` before any write.
- Require a unique section heading locally and remotely.
- Do not use whole-document `sync --write` unless the user explicitly changes the task.
- Explain that section writes do not update the whole-document receipt if later status output looks unexpected.

## Completion

Finish only when the selected section write passes readback verification.
