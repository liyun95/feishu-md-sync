---
name: feishu-markdown-push
description: Use when a local Markdown file should be published to an existing Feishu document with dry-run, diff, status, or merge checks.
---

# Feishu Markdown Push

Use this skill when local Markdown is the source and an existing Feishu document should be updated. It owns whole-document `status`, `diff`, `merge`, and `sync`.

Do not use this skill to pull remote content into local files. Use `feishu-markdown-pull` first when Feishu is the source or when remote state must be inspected before editing.

Workflow:

```bash
md2feishu status ./doc.md "$DOC"
md2feishu diff ./doc.md "$DOC"
md2feishu sync ./doc.md "$DOC"
md2feishu sync ./doc.md "$DOC" --write --yes --strategy merge
```

If local and Feishu both changed, generate a merged file:

```bash
md2feishu merge ./doc.md "$DOC"
md2feishu sync ./doc.merged.md "$DOC" --write --yes --strategy local-wins
```

Use `--publish-profile milvus` when publishing Milvus docs that share content with Zilliz Cloud.

Guardrails:

- Dry-run before every write.
- Successful writes create receipts used for later remote-change detection.
- Do not use `--strategy local-wins` unless the user explicitly chose overwrite or the file is a resolved `.merged.md`.
- Do not use `--force-initial-overwrite` unless replacing existing Feishu content is intended.
- Do not use `--force-whole-document-sync` to bypass an active `multisdk` task unless the user explicitly wants a whole-document write.
- Do not patch individual code blocks through whole-document sync; use `feishu-codeblock-writer` or `milvus-multisdk-example-sync`.
