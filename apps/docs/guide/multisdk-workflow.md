# Multi-SDK Examples

## Use this when

Use this workflow when a Feishu user doc has Python examples and needs verified Java, JavaScript, Go, or REST examples.

## Do not use this when

Do not use this workflow for unrelated prose edits or whole-document sync. Use it only when the task is language-scoped example completion and validation.

## Skill

Ask Codex to use:

```text
feishu-multisdk-examples
```

## Workflow recipe

```bash
md2feishu workflow show multisdk-examples
```

## What changes

This workflow can update Feishu code blocks for the selected SDK languages. It may also produce local task artifacts such as manifests, snippets, validation evidence, and audit reports.

## Safety boundary

The workflow should not write unverified snippets. Apply steps should run only after language-specific validation evidence exists and the planned code-block diff has been reviewed.

## Completion state

The workflow is complete when the selected language examples are written to Feishu, audited, and any required handoff artifacts are available.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- Harness tools: `md2feishu harness tools --workflow multisdk --format json`
