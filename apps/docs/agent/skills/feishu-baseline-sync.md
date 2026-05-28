# Feishu Baseline Sync

Installable skill source: `skills/feishu-baseline-sync/SKILL.md`.

Use this skill when a user says the remote Feishu document changed and they want to sync or refresh it into local Markdown.

Workflow recipe:

```bash
md2feishu workflow show baseline-sync --format json
```

Default behavior:

- Create a separate `*.remote.md` or temporary file when the user has not explicitly approved overwriting an existing local Markdown file.
- Refresh an existing local file only when the user provides that path and the overwrite is intentional.
- Tell the user which local file was written before suggesting any later Feishu write workflow.

Install team skills from the repository root:

```bash
scripts/install-codex-skills.sh
```
