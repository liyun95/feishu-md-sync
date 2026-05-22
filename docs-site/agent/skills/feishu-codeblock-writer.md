---
name: feishu-codeblock-writer
description: Use when updating or inserting verified language code blocks inside an existing Feishu document.
---

# Feishu Codeblock Writer

Use this skill for local code-block operations in an existing Feishu document. It owns `md2feishu code-blocks inspect`, `plan`, `export`, `apply`, and `audit`.

For Milvus multi-SDK document tasks that need resumable per-language state, use `milvus-multisdk-example-sync` and the `md2feishu multisdk` CLI; this skill remains the low-level code-block engine.

Workflow:

1. Inspect the document inventory.
2. Plan or export a manifest for `python > java > javascript > go > restful`.
3. Fill snippet files with already verified code.
4. Run dry-run apply.
5. Run write apply with `--write -y`.
6. Audit the document.

Commands:

```bash
md2feishu code-blocks inspect "$DOC" --format json
md2feishu code-blocks plan "$DOC" --expect java,javascript,go,restful --out manifest.json --format json
md2feishu code-blocks export "$DOC" --out ./snippets --manifest manifest.json --expect java,javascript,go,restful
md2feishu code-blocks apply "$DOC" --manifest manifest.json --format json
md2feishu code-blocks apply "$DOC" --manifest manifest.json --write -y --format json
md2feishu code-blocks audit "$DOC" --expect java,javascript,go,restful --allow-placeholders java --format json
```

Do not use this skill to decide SDK support, generate Milvus examples, run Manta jobs, or rewrite whole documents. Use `sdk-source-verifier` for source truth and `feishu-markdown-sync` for whole-document sync.
