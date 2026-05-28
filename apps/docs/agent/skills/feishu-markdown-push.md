---
name: feishu-markdown-push
description: Use when a local Markdown file should be published to an existing Feishu document with dry-run, diff, status, or merge checks.
---

# Feishu Markdown Push

> Legacy alias: prefer `feishu-reviewed-section-sync` for reviewed section writes. For other sync cases, run `md2feishu workflow list` and select the matching workflow.

Use this page only as a compatibility alias.

For reviewed section writes, load:

```bash
md2feishu workflow show reviewed-section-sync --format json
```

For other sync cases, choose from:

```bash
md2feishu workflow list
```

Shared write gates live in [Safety Gates](/reference/safety-gates).
