# Feishu Baseline Sync

Installable skill source: `skills/feishu-baseline-sync/SKILL.md`.

Use this skill when a user says the remote Feishu document changed and they want to sync or refresh it into local Markdown.

Workflow recipe:

```bash
md2feishu workflow show baseline-sync --format json
```

Default behavior:

- Pull directly to a new target path with `--write-receipt`.
- Create a separate `*.remote.md` or temporary file when the requested local Markdown file already exists.
- Refresh an existing local file only after comparing the existing file with the remote copy and confirming the overwrite is intentional.
- Use `--overwrite --write-receipt` for the final replacement.
- Tell the user which local file was written before suggesting any later Feishu write workflow.

After the final pull, expect `md2feishu status` to be clean when a baseline receipt was written. If status still reports `no-receipt`, explain that the local Markdown exists but has not been registered as a sync baseline.

Install team skills from the repository root:

```bash
scripts/install-codex-skills.sh
```
