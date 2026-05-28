# Baseline Sync

## Use this when

Use this workflow when the remote Feishu document changed and you need to pull or refresh that content into local Markdown before editing, comparing, or preparing a later write.

## Do not use this when

Do not use this workflow when you already have local changes that should be written back to Feishu. Use [Section Sync](/guide/section-sync) for one named section, or inspect the direct CLI reference for advanced whole-document sync cases.

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

If no exact output path is agreed, agents should create a separate review file such as `doc.remote.md` instead of overwriting an existing local Markdown file. Updating an existing file in place is appropriate only when you explicitly ask for that path to be refreshed and local-only edits have been checked or ruled out. In either case, the agent should tell you the written path before proposing any later Feishu write.

## Safety boundary

Baseline sync is read-oriented. Any later Feishu write is a separate decision and should go through the workflow that matches the write target.

## Completion state

The workflow is complete when the current Feishu document has been exported to local Markdown and the local file is ready for review or editing.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
