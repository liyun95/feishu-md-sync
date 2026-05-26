# Conflict Workflow

`md2feishu` is fail-closed.

If Feishu changed since the last successful receipt, default writes are refused and nothing is written.

## Inspect State

```bash
npm exec -- md2feishu status ./doc.md DocToken
```

The status command reports whether local Markdown changed, whether remote Feishu changed, and which receipt was used.

## Compare Local And Remote

```bash
npm exec -- md2feishu diff ./doc.md DocToken
```

The diff compares local Markdown with a best-effort Markdown export of the current Feishu document.

## Pull Remote Markdown

```bash
npm exec -- md2feishu pull DocToken --output feishu.remote.md
```

Use `pull` when you need a local copy of the current Feishu content.

## Generate One Merge File

```bash
npm exec -- md2feishu merge ./doc.md DocToken
```

This writes `./doc.merged.md`. If conflicts exist, resolve the conflict markers in that file.
