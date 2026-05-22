---
name: milvus-multisdk-example-sync
description: Use when completing Milvus user-guide examples across Java, JavaScript, RESTful, and Go from a Python baseline.
---

# Milvus Multi-SDK Example Sync

Use this skill for Milvus user-guide multi-SDK example completion. C++ is out of V1 scope.

Workflow:

1. Accept one Feishu document URL.
2. Inspect code blocks and identify Python anchors.
3. Use Python snippets as the behavioral baseline.
4. Use `sdk-source-verifier` to confirm SDK support from source.
5. Validate Java, JavaScript, RESTful, and Go snippets with appropriate local or Manta evidence.
6. Use `feishu-codeblock-writer` to export, apply, and audit snippets.

Canonical order is `python > java > javascript > go > restful`. Prefer `javascript` externally; accept `node`, `nodejs`, and `js` as aliases.

Do not use whole-document sync unless the task explicitly asks to publish an entire Markdown file.
