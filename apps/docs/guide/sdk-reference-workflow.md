# SDK Reference Authoring

## Use this when

Use this workflow when SDK reference changes need to be planned, written, and audited in Feishu.

## Do not use this when

Do not use this workflow to export audited Feishu content into `web-content`. Use [SDK Reference Release](/guide/sdk-reference-release-workflow) only after a human explicitly starts release.

## Skill

Ask Codex to use:

```text
feishu-sdk-reference-authoring
```

## Workflow recipe

```bash
md2feishu workflow show sdk-reference-authoring
```

## What changes

This workflow can write SDK reference drafts and audit artifacts in Feishu. It does not touch the external `web-content` repository.

## Safety boundary

The workflow stops after Feishu write and audit. The release boundary is deliberate: publishing to the docs website is a separate human-triggered workflow.

## Completion state

The workflow is complete when the Feishu reference draft has been written, audited, and the audit result is available for human review.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [SDK Reference Release](/guide/sdk-reference-release-workflow)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
