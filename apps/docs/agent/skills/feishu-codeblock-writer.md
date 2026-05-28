---
name: feishu-codeblock-writer
description: Use when directly inspecting, exporting, applying, or auditing code blocks inside an existing Feishu document outside the resumable multi-SDK workflow.
---

# Feishu Codeblock Writer

> Legacy alias: prefer `feishu-multisdk-examples` for SDK example completion. Use low-level code-block commands only when the user explicitly asks for block-level operations.

This page is retained for compatibility with older agent prompts. Do not add workflow logic here.

For multi-SDK example completion, load:

```bash
md2feishu workflow show multisdk-examples --format json
```

For truly direct block-level operations, use the command reference for `code-blocks` and keep the shared write gates from [Safety Gates](/reference/safety-gates).
