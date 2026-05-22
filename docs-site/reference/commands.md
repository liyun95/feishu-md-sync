# Command Reference

Examples use the installed `md2feishu` binary. Inside a fresh repository checkout, use `npm exec -- md2feishu ...` until you run `npm link`.

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
- `--publish-profile <profile>` - apply a publish transform before diffing or writing. Currently supports `milvus`.
- `--host <url>` - Feishu API host.
- `--timeout-ms <number>` - Feishu API timeout.

The `milvus` publish profile strips frontmatter, drops a first H1 when it duplicates the frontmatter title, rewrites standalone `Milvus` references for shared Milvus/Zilliz Cloud publishing, and wraps versioned names such as `Milvus 3.0` in a Milvus-only include.

## `status`

```bash
md2feishu status <markdown-file> <feishu-doc> [--publish-profile milvus]
```

Shows local/remote sync state without writing.

## `diff`

```bash
md2feishu diff <markdown-file> <feishu-doc> [--publish-profile milvus]
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

## `multisdk`

Run a resumable, language-scoped multi-SDK code-block workflow for one Feishu document.

```bash
md2feishu multisdk init <feishu-doc> --out runs/<doc-token>
md2feishu multisdk status <task-dir>
md2feishu multisdk export <task-dir> --language java
md2feishu multisdk verify <task-dir> --language java --evidence evidence/java.log --command "mvn test"
md2feishu multisdk apply <task-dir> --language java
md2feishu multisdk apply <task-dir> --language java --write -y
md2feishu multisdk audit <task-dir> --language java
md2feishu multisdk finalize <task-dir>
```

`multisdk apply` defaults to dry-run. Writes require `--write` and either `-y` or interactive confirmation. Each language must have verification evidence and a successful dry-run before write. Supported lanes are `java`, `javascript`, `go`, and `restful`; `node`, `nodejs`, and `js` normalize to `javascript`.

## `reference`

Publish SDK reference docs to Feishu Drive and Bitable from explicit manifests.

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
```

Manifests must use `kind: "sdk-reference-publish-manifest"`. They must not write the SDK reference `Slug` field. Tracker rows require a pre-existing, shared release audit Base via `targets.releaseAuditBaseToken`; the CLI does not create a new Base.
