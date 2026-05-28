# Section Sync

## Use this when

Use this workflow when one named section from local Markdown should replace the matching Feishu section while preserving the rest of the Feishu document.

## Do not use this when

Do not use this workflow for whole-document rewrites, duplicated section headings, or drafts that have not been checked by a human. The section title must be unique in both local Markdown and the remote Feishu document.

## Skill

Ask Codex to use:

```text
feishu-section-sync
```

## Workflow recipe

```bash
md2feishu workflow show section-sync
```

## What changes

This workflow replaces one heading section in Feishu. Content outside that section remains unchanged.

## How section sync writes

`sync --section` reads the current Feishu block tree, extracts the matching local Markdown heading section, converts only that section to desired blocks, and writes the smallest safe patch.

With `--markdown-engine auto`, section sync uses Feishu's official Markdown export for pull and readback, then uses the local Markdown renderer for stable block-level planning. Writes still use Feishu Docx block APIs.

For text-like blocks, the CLI updates existing Feishu blocks in place. This preserves block IDs and keeps Feishu edit history focused. When the block type changes or a complex block cannot be updated safely, the CLI falls back to replacing a small contiguous range and explains the fallback in dry-run output.

## Safety boundary

The workflow should dry-run and inspect the target section before writing. The Feishu write requires explicit approval through the workflow's write step.

## Completion state

The workflow is complete when the selected section has been written to Feishu, read back, and verified against the planned replacement.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Markdown Support](/reference/markdown-support)
