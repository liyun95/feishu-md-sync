---
name: feishu-sdk-reference-release
description: Use when a human has approved audited Feishu SDK reference docs for release to the web-content repository
---

# Feishu SDK Reference Release

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-web-content-release --format json
```

Use the returned steps as the command sequence.

## Safety Rules

- Confirm the user is explicitly starting the release workflow.
- Re-run `reference audit` for the exact manifest before export.
- Export only into the user-provided `web-content` checkout.
- Report changed files and handoff commands; do not stage, commit, push, or open a PR unless the user explicitly asks.

## Completion

The workflow is complete when the audited Feishu reference content has been exported to `web-content` and the handoff report identifies the changed files.
