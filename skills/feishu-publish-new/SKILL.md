---
name: feishu-publish-new
description: Use when a local Markdown file has no existing Feishu target and should be published as a new Feishu docx before later push updates.
---

# Feishu Publish New

Use this when the user has local Markdown but no corresponding Feishu document URL yet.

Do not use `feishu-push` for first publication. `publish-new` owns title resolution, destination selection, duplicate-title checks, new docx creation, optional wiki placement, receipt creation, and the next `push` command.

## Required Discovery

Run:

```bash
md2feishu workflow show publish-new --format json
```

If `md2feishu` is not linked globally, run the equivalent from this repository:

```bash
npm exec -- md2feishu workflow show publish-new --format json
```

Follow the returned steps.

## Safety Rules

- Start with `md2feishu publish-new <doc.md>` dry-run.
- Confirm the title, title source, destination source, staging folder, wiki move behavior, duplicate-title result, and block count.
- Do not write unless a destination is explicit or configured.
- App-owned docx creation is allowed only when `--app-owned` or `FEISHU_PUBLISH_APP_OWNED=true` is explicit.
- For wiki publication, require `FEISHU_PUBLISH_FOLDER_TOKEN` or `--folder-token` because V1 creates a staging Drive docx before moving it into wiki.
- If duplicate title candidates are reported, use the existing URL with `md2feishu push` unless the user explicitly wants a separate new document.
- After write, verify the receipt exists and use the printed `md2feishu push <doc.md> '<new-url>'` command for subsequent updates.
- If later updates include important tables or local images/SVGs, use `feishu-push` and its docs v2 overwrite backend rules rather than changing the first-publication workflow.

## Completion

Finish only when the dry-run has been reviewed without writing, or when `publish-new --write` reports readback verification passed and a receipt was written. If wiki move or verification fails after docx creation, report the created docx URL and do not claim publication succeeded.
