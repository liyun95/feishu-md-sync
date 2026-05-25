---
name: feishu-codeblock-writer
description: Use when directly inspecting, exporting, applying, or auditing code blocks inside an existing Feishu document outside the resumable multi-SDK workflow.
---

# Feishu Codeblock Writer

Use this skill for direct code-block operations in an existing Feishu document. It owns `md2feishu code-blocks inspect`, `plan`, `export`, `apply`, and `audit`.

Do not use this as the main entry point for Milvus multi-language example completion. For those tasks, use `milvus-multisdk-example-sync`; that workflow wraps code-block writes with per-language state, validation evidence, dry-run gates, and readback audit.

Use this skill when the user already knows which code blocks should change or needs a focused code-block inventory/audit. It does not choose SDK APIs, infer feature availability, or manage a multi-language Milvus task.

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

Boundaries:

- Do not decide SDK support or generate Milvus examples.
- Do not run Manta jobs or manage by-language validation state.
- Do not rewrite whole documents.

Use `sdk-source-verifier` for source truth, `milvus-multisdk-example-sync` for Milvus multi-language example completion, `feishu-markdown-pull` for Feishu-to-Markdown export, and `feishu-markdown-push` for local Markdown publishing.
