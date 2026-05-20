# Skill Roadmap

The future `md2feishu` Skill should let an agent safely sync Markdown to Feishu using this CLI.

The Skill is not implemented yet. This page defines the expected behavior.

## Intended Purpose

- Install or locate the `md2feishu` CLI.
- Sync a local Markdown file to a Feishu docx document.
- Detect remote edits before writing.
- Use the merge workflow when both local and Feishu changed.
- Stop on unresolved conflicts.

## Expected Inputs

- Local Markdown path.
- Feishu doc token, docx URL, or wiki URL.
- Whether writes are authorized.
- Conflict policy:
  - fail
  - merge
  - local wins only after explicit approval

## Expected Behavior

1. Verify the CLI is available.
2. Run `status` or dry-run first.
3. Refuse unsafe first overwrites unless explicitly authorized.
4. Prefer `--strategy merge` for automated writes.
5. Generate `.merged.md` when conflicts exist.
6. Ask the human to resolve conflict markers.
7. Publish resolved `.merged.md` with `--strategy local-wins`.

## Non-Goals

- The Skill should not decide semantic content conflicts by itself.
- The Skill should not use `--force-initial-overwrite` without explicit human approval.
- The Skill should not publish files that still contain conflict markers.
