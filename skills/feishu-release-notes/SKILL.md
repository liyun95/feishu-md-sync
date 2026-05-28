---
name: feishu-release-notes
description: Use when Milvus release notes from Feishu need SDK tag, Variables, user-doc link, or local docs audit before approved apply.
---

# Feishu Release Notes

Use the workflow recipe for release-note audit and apply. Do not bypass the approval gate for local docs changes.

## Required Discovery

Run:

```bash
md2feishu workflow show release-notes --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show release-notes --format json
```

Follow the returned steps.

## Safety Rules

- Pull Feishu release notes into the task directory before auditing.
- Scan SDK tags before auditing Variables.
- Do not run `release apply --write` until the current report hash is approved.
- If audit blockers exist, report them and stop before writing.

## Completion

Finish only when approved release-note changes are applied to the local Milvus docs checkout, or blockers are clearly reported.
