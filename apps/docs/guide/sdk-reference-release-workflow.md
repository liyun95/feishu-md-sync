# SDK Reference Release

## Use this when

Use this workflow when a human has approved audited SDK reference content in Feishu and wants to move it into the external `web-content` repository.

## Do not use this when

Do not use this workflow during SDK reference authoring. Do not start it only because Feishu writing finished; a human must explicitly ask for release.

## Skill

Ask Codex to use:

```text
feishu-sdk-reference-release
```

## Workflow recipe

```bash
md2feishu workflow show sdk-reference-web-content-release
```

## What changes

This workflow can export audited Feishu reference content and prepare changes in an external `web-content` checkout.

## Safety boundary

The human release request is the start condition. The workflow should confirm the audited manifest or report before touching `web-content`.

## Completion state

The workflow is complete when the `web-content` changes are prepared, checked, and handed off for review or PR creation according to the workflow output.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [SDK Reference Authoring](/guide/sdk-reference-workflow)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
