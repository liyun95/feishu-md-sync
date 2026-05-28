# Reviewed Section Sync

## Use this when

Use this workflow when one reviewed Markdown section should replace the matching Feishu section while preserving the rest of the Feishu document.

## Do not use this when

Do not use this workflow for whole-document rewrites, duplicated section headings, or unreviewed local drafts. The section title must be unique in both local Markdown and the remote Feishu document.

## Skill

Ask Codex to use:

```text
feishu-reviewed-section-sync
```

## Workflow recipe

```bash
md2feishu workflow show reviewed-section-sync
```

## What changes

This workflow replaces one heading section in Feishu. Content outside that section remains unchanged.

## Safety boundary

The workflow should dry-run and inspect the target section before writing. The Feishu write requires explicit approval through the workflow's write step.

## Completion state

The workflow is complete when the reviewed section has been written to Feishu, read back, and verified against the planned replacement.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Markdown Support](/reference/markdown-support)
