---
name: feishu-push
description: Use when local Markdown changes should be pushed to an existing Feishu document. The CLI chooses block, section, or document strategy from a dry-run plan.
---

# Feishu Push

Use this when the user wants local Markdown changes written back to an existing Feishu document.

Do not ask the user to choose block-level, section-level, or document-level write strategy up front. The workflow dry-run chooses the strategy and shows the scope, risk, and operation counts before any write.

## Required Discovery

Run:

```bash
md2feishu workflow show push --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show push --format json
```

Follow the returned steps.

## Safety Rules

- Start with a push dry-run.
- Summarize selected strategy, scope, risk, updates, creates, deletes, and fallback reason.
- For `block-patch`, write only after the dry-run is understood and approved.
- For `section-replace`, explicitly tell the user which heading section will be recreated.
- For `document-replace`, do not write unless the dry-run recommends full replacement and the user approves `--replace-all`.
- For Markdown with important tables or local images/SVGs, consider `--write-backend docx-v2-overwrite` only as a whole-document replacement path. Dry-run first, require `--replace-all`, pass `--image-root-dir` and `--image-size` when needed, and report table/media readback counts.
- Use `push --scope heading:"..."` only when a heading scope is a guard, not as a separate workflow.
- After write, verify readback and ask the user to visually inspect Feishu when rendered document content changed.

## Completion

Finish only when the push write has passed readback verification, or when the dry-run shows no Feishu write is needed. If the CLI selects `document-replace` or docs v2 overwrite, stop at dry-run unless the user explicitly approves full document replacement.
