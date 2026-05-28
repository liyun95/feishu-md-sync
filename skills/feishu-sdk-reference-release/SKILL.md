---
name: feishu-sdk-reference-release
description: Use when a human has explicitly approved audited Feishu SDK reference docs for release into the web-content repository.
---

# Feishu SDK Reference Release

Use only after the user explicitly starts the release flow. SDK reference authoring must already be audited on Feishu.

## Required Discovery

Run:

```bash
md2feishu workflow show sdk-reference-web-content-release --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show sdk-reference-web-content-release --format json
```

Follow the returned steps.

## Safety Rules

- Confirm the user is explicitly starting release.
- Re-run `reference audit` for the exact manifest before export.
- Export only into the user-provided `web-content` checkout.
- Report changed files and handoff commands.
- Do not stage, commit, push, or open a PR unless the user explicitly asks.

## Completion

Finish only when the audited Feishu reference content has been exported to `web-content` and the handoff report identifies changed files.
