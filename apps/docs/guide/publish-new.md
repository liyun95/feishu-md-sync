# Publish a New Feishu Document

Use `publish-new` when local Markdown has no existing Feishu URL yet. After the first publication succeeds, use `push` for later updates.

```bash
md2feishu publish-new ./doc.md
md2feishu publish-new ./doc.md --write -y
md2feishu push ./doc.md '<new-feishu-url>'
```

The command is dry-run by default. Dry-run output shows the resolved title, destination, duplicate-title result, planned block count, wiki move behavior, and the receipt path that will be written after verification.

`publish-new` defaults to the local Markdown renderer so the first receipt baseline is stable for the next `push` dry-run. Use `--markdown-engine official` only when you explicitly want Feishu's Markdown conversion for the first render.

## Destinations

Publish to a Drive folder:

```bash
md2feishu publish-new ./doc.md --title "Doc Title" --folder-token <folder-token>
```

Publish as an app-owned docx, matching documents whose owner is the Feishu app:

```bash
md2feishu publish-new ./doc.md --title "Doc Title" --app-owned
```

Publish to a wiki parent:

```bash
md2feishu publish-new ./doc.md \
  --title "Doc Title" \
  --wiki-space-id <space-id> \
  --wiki-parent <node-token> \
  --folder-token <staging-folder-token>
```

Environment defaults:

```bash
FEISHU_PUBLISH_FOLDER_TOKEN=...
FEISHU_PUBLISH_SPACE_ID=...
FEISHU_PUBLISH_PARENT_NODE_TOKEN=...
FEISHU_PUBLISH_APP_OWNED=false
```

For wiki publication, the folder token is still required in V1 because the CLI creates a docx in Drive first, inserts blocks, then moves the docx into wiki.

## Duplicate Titles

If the destination already contains a document with the same title, `publish-new` refuses before creating anything. Use the reported URL with `md2feishu push` when the existing document is the intended target, or rerun with `--allow-duplicate-title --write` only when a separate new document is intentional.

## Failure Recovery

If the command fails after docx creation, it reports that a remote docx exists and does not write a receipt. Inspect or remove that created docx before retrying.
