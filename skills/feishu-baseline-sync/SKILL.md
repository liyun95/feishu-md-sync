---
name: feishu-baseline-sync
description: Use when a remote Feishu docx or wiki document needs to be pulled or refreshed into local Markdown for review, comparison, editing, or later sync work.
---

# Feishu Baseline Sync

Use the CLI workflow registry as the source of truth. Do not reconstruct the command sequence from memory.

## Local Output Policy

Baseline sync is the answer when the user says the remote Feishu document changed and they want to sync it to local Markdown. It reads Feishu and writes local files only; it does not write anything back to Feishu.

Always run `md2feishu workflow show baseline-sync --format json` first and follow the returned steps.

When the target path does not exist, pull directly to that path with `--write-receipt`.

When the target path already exists:

1. Pull the remote document to a separate `*.remote.md` or `/private/tmp/*.remote.md` file.
2. Compare the existing file and the remote copy with `diff -u`.
3. Replace the existing file only when the user has already provided exact overwrite intent, or after the diff shows no local-only edits that need preservation.
4. Use `--overwrite --write-receipt` for the final replacement.

Quote Feishu URLs in shell commands because wiki URLs often contain `?`.

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
- If the user does not specify whether to overwrite, choose a new `*.remote.md` or temporary output path first.
- Before overwriting an existing local Markdown file, verify that the user intended an in-place update and reviewed or ruled out local-only edits.
- Prefer official-first Markdown export behavior when the installed CLI supports it.
- After the final pull with `--write-receipt`, run status before suggesting any write workflow.

## Completion

Finish only when the local Markdown baseline exists and the user knows which file was written. If `md2feishu status` reports `no-receipt`, explain that the file exists but has not been registered as a sync baseline. If a separate remote copy was created, tell the user how it relates to the previous local file and whether a comparison is still needed.
