---
name: feishu-markdown-sync
description: Use when syncing a whole local Markdown file with an existing Feishu document.
---

# Feishu Markdown Sync

Use this skill for whole-document Markdown sync. It owns `status`, `diff`, `pull`, `merge`, and `sync`.

Commands:

```bash
md2feishu status ./doc.md "$DOC"
md2feishu diff ./doc.md "$DOC"
md2feishu pull "$DOC" --output feishu.remote.md
md2feishu merge ./doc.md "$DOC"
md2feishu sync ./doc.md "$DOC"
md2feishu sync ./doc.md "$DOC" --write --yes --strategy merge
md2feishu sync ./doc.merged.md "$DOC" --write --yes --strategy local-wins
```

Successful writes create receipts used for later remote-change detection. If local and Feishu both changed, produce a `.merged.md` and resolve conflict markers before publishing.

Do not use `--strategy local-wins` unless the human explicitly chose overwrite or the file is a resolved `.merged.md`. Do not use `--force-initial-overwrite` unless replacing existing Feishu content is intended.

Use `feishu-codeblock-writer` for local code-block updates and `milvus-multisdk-example-sync` for Milvus multi-SDK example completion.
