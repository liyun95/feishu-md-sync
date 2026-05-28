# Baseline Sync

## Use this when

Use this workflow when you need to pull current Feishu content into local Markdown before editing, comparing, or preparing a later reviewed write.

## Do not use this when

Do not use this workflow when you already have reviewed local changes that should be written back to Feishu. Use [Reviewed Section Sync](/guide/section-sync) for one reviewed section, or inspect the direct CLI reference for advanced whole-document sync cases.

## Skill

Ask Codex to use:

```text
feishu-baseline-sync
```

## Workflow recipe

```bash
md2feishu workflow show baseline-sync
```

## What changes

This workflow writes a local Markdown baseline from the current Feishu document. It does not write to Feishu.

## Safety boundary

Baseline sync is read-oriented. Any later Feishu write is a separate decision and should go through the workflow that matches the write target.

## Completion state

The workflow is complete when the current Feishu document has been exported to local Markdown and the local file is ready for review or editing.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
