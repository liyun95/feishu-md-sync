# Release Notes

## Use this when

Use this workflow when Milvus release notes from Feishu need SDK tag checks, Variables audit, user-doc link checks, and approved local docs apply.

## Do not use this when

Do not use this workflow for SDK reference authoring or general Feishu document updates. Use the SDK reference workflows or Feishu Push instead.

## Skill

Ask Codex to use:

```text
feishu-release-notes
```

## Workflow recipe

```bash
md2feishu workflow show release-notes
```

## What changes

This workflow can prepare release-note audit artifacts and apply approved changes to a local docs checkout.

## Safety boundary

The workflow should not apply local docs changes until the current release-note report hash has been reviewed and approved.

## Completion state

The workflow is complete when SDK tags, Variables usage, and user-doc links have been audited, and any approved local docs changes have been applied.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
