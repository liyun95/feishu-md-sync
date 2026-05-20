# Command Reference

## Root Shorthand

```bash
md2feishu ./doc.md DocToken
```

Equivalent to:

```bash
md2feishu sync ./doc.md DocToken
```

## `sync`

```bash
md2feishu sync <markdown-file> <feishu-doc> [options]
```

Options:

- `--write` - write to Feishu. Omitted means dry-run.
- `-y, --yes` - skip write confirmation.
- `--strategy <strategy>` - `fail`, `local-wins`, or `merge`.
- `--force-initial-overwrite` - allow first write to replace existing non-empty Feishu content.
- `--host <url>` - Feishu API host.
- `--timeout-ms <number>` - Feishu API timeout.

## `status`

```bash
md2feishu status <markdown-file> <feishu-doc>
```

Shows local/remote sync state without writing.

## `diff`

```bash
md2feishu diff <markdown-file> <feishu-doc>
```

Shows a best-effort diff between local Markdown and current Feishu content exported as Markdown.

## `pull`

```bash
md2feishu pull <feishu-doc> --output feishu.remote.md
```

Exports current Feishu content as best-effort Markdown.

## `merge`

```bash
md2feishu merge <markdown-file> <feishu-doc>
```

Writes a `.merged.md` file that combines the last receipt snapshot, current local Markdown, and current Feishu Markdown export.
