---
name: milvus-release-notes-workflow
description: Use when Milvus release notes, Variables.json, SDK version values, or release-note user-doc links need updating from Feishu source documents.
---

# Milvus Release Notes Workflow

> Legacy alias: prefer `feishu-release-notes` for new release-note audit and apply runs.

This page is retained for compatibility with older agent prompts. Do not add workflow logic here.

For release-note audit and apply runs, load:

```bash
md2feishu workflow show release-notes --format json
```

Shared write gates live in [Safety Gates](/reference/safety-gates).
