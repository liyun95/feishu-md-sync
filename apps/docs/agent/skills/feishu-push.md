# Feishu Push

Installable skill source: `skills/feishu-push/SKILL.md`.

Workflow recipe:

```bash
md2feishu workflow show push --format json
```

Use this skill when local Markdown changes should be pushed to an existing Feishu document. The dry-run chooses block-patch, section-replace, or document-replace and shows the risk before any write.

Install team skills from the repository root:

```bash
scripts/install-codex-skills.sh
```
