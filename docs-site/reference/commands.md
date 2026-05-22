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

## `code-blocks`

Inspect, plan, export, apply, and audit code blocks without rewriting the whole document.

```bash
md2feishu code-blocks inspect <feishu-doc> --format json
md2feishu code-blocks plan <feishu-doc> --expect java,javascript,go,restful --out manifest.json --format json
md2feishu code-blocks export <feishu-doc> --out ./snippets --manifest manifest.json --expect java,javascript,go,restful
md2feishu code-blocks apply <feishu-doc> --manifest manifest.json --format json
md2feishu code-blocks apply <feishu-doc> --manifest manifest.json --write -y --format json
md2feishu code-blocks audit <feishu-doc> --expect java,javascript,go,restful --allow-placeholders java --format json
```

Supported canonical language order is `python > java > javascript > go > restful`. Aliases `nodejs`, `node`, and `js` normalize to `javascript`; `rest` normalizes to `restful`.

`apply` defaults to dry-run. Writes require `--write -y`.

## `reference`

Publish SDK reference docs to Feishu Drive and Bitable from explicit manifests.

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
```

Manifests must use `kind: "sdk-reference-publish-manifest"`. They must not write the SDK reference `Slug` field. Tracker rows require a pre-existing, shared release audit Base via `targets.releaseAuditBaseToken`; the CLI does not create a new Base.
