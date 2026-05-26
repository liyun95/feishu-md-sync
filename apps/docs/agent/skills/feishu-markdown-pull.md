---
name: feishu-markdown-pull
description: Use when a Feishu docx or wiki document should be exported into local Markdown for review, comparison, or local docs updates.
---

# Feishu Markdown Pull

Use this skill when Feishu is the source document and the agent needs a local Markdown snapshot. It owns `md2feishu pull` only.

Typical triggers:

- the user gives a Feishu doc/wiki URL and asks to pull it down;
- release notes or user docs need to be copied from Feishu into `milvus-docs`;
- the agent needs a local Markdown file before comparing or editing content.

Workflow:

```bash
md2feishu pull "$DOC" --output feishu.remote.md
```

For Milvus docs updates, write the pulled file to a task or temp path first, inspect the Markdown, then apply changes to the target docs file deliberately.

Boundaries:

- Do not write back to Feishu from this skill.
- Do not decide whether local Markdown should overwrite remote content.
- Do not patch individual code blocks; use `feishu-codeblock-writer` or `milvus-multisdk-example-sync`.

Use `feishu-markdown-push` when local Markdown should be published to an existing Feishu document.
