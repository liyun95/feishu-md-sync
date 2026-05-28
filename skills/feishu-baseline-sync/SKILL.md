---
name: feishu-baseline-sync
description: Use when a remote Feishu docx or wiki document needs to be pulled or refreshed into local Markdown for review, comparison, editing, or later sync work.
---

# Feishu Baseline Sync

Use the CLI workflow registry as the source of truth. Do not reconstruct the command sequence from memory.

## Local Output Policy

Baseline sync is the answer when the user says the remote Feishu document changed and they want to sync it to local Markdown. It reads Feishu and writes a local Markdown file; it does not write anything back to Feishu.

The first UX decision is whether to create a new remote copy or update an existing local file.

Default to a new reviewable file when the user has not explicitly chosen an output path. Use a filename such as:

```text
<doc-name-or-token>.remote.md
```

or a temporary path under `/private/tmp` for one-off inspection. Do not overwrite an existing local Markdown file by default.

Only update an existing Markdown file in place when the user clearly says to update that file, or when all of these are true:

- The user gave the exact output path.
- The file is already understood to be the baseline for this Feishu document.
- Local uncommitted edits or local-only changes have been checked or ruled out.

If local edits may exist, pull to a separate `*.remote.md` file first and compare before replacing anything.

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
- If the user does not specify whether to overwrite, choose a new `*.remote.md` or temporary output path.
- Before overwriting an existing local Markdown file, verify that the user intended an in-place update.
- Prefer official-first Markdown export behavior when the installed CLI supports it.
- After pulling, run status or diff before suggesting any write workflow.

## Completion

Finish only when the local Markdown baseline exists and the user knows which file was written. If a separate remote copy was created, tell the user how it relates to the previous local file and whether a comparison is still needed.
