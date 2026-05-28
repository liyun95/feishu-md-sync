---
name: feishu-release-notes
description: Use when Milvus release notes from Feishu need SDK tag, Variables, user-doc link, and local docs audit before apply
---

# Feishu Release Notes

## Required Discovery

Run:

```bash
md2feishu workflow show release-notes --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Pull Feishu release notes into the task directory before auditing.
- Scan SDK tags before auditing Variables.
- Do not run `release apply --write` until the current report hash is approved.
- If audit blockers exist, report them and stop before write.

## Completion

The workflow is complete when approved release-note changes are applied to the local Milvus docs checkout or blockers are clearly reported.
