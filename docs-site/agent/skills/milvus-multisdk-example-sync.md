---
name: milvus-multisdk-example-sync
description: Use when completing Milvus user-guide examples across Java, JavaScript, RESTful, and Go from a Python baseline.
---

# Milvus Multi-SDK Example Sync

Use this skill for Milvus user-guide multi-SDK example completion. C++ is out of V1 scope.

Workflow:

1. Accept one Feishu document URL.
2. Initialize a resumable task with `md2feishu multisdk init "$DOC" --out runs/<doc-token>`.
3. Use Python snippets as the behavioral baseline.
4. Use `sdk-source-verifier` to confirm SDK support from source.
5. Complete one lane at a time with `multisdk export`, local or Manta validation, `multisdk verify`, dry-run `multisdk apply`, write `multisdk apply --write -y`, and `multisdk audit`.
6. Repeat for Java, JavaScript, RESTful, and Go, then run `md2feishu multisdk finalize <task-dir>`.

Canonical order is `python > java > javascript > go > restful`. Prefer `javascript` externally; accept `node`, `nodejs`, and `js` as aliases.

Use `feishu-codeblock-writer` only as the low-level code-block engine when the resumable `multisdk` task state is unnecessary. Do not use whole-document sync unless the task explicitly asks to publish an entire Markdown file.
