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
md2feishu code-blocks update <feishu-doc> --language java --block-id blk_xxx --file snippets/java.java
md2feishu code-blocks update <feishu-doc> --language java --block-id blk_xxx --file snippets/java.java --write -y
```

Supported canonical language order is `python > java > javascript > go > restful`. Aliases `nodejs`, `node`, and `js` normalize to `javascript`; `rest` normalizes to `restful`.

`apply` defaults to dry-run. Writes require `--write -y`.

`update` is a lower-level command for replacing one existing Feishu code block by block ID. Prefer `plan`/`export`/`apply` when a document needs coordinated multi-block changes.

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

## `release`

Run a gated Milvus release-notes workflow that pulls Feishu source text, checks SDK tags, audits Variables and user-doc links, and applies local Milvus docs updates only after approval.

```bash
md2feishu release init \
  --release-line 2.6.x \
  --version 2.6.17 \
  --release-doc "$RELEASE_DOC" \
  --milvus-docs ~/milvus-docs \
  --out runs/releases/2.6.17
md2feishu release pull runs/releases/2.6.17
md2feishu release scan-sdk-tags runs/releases/2.6.17
md2feishu release audit runs/releases/2.6.17
md2feishu release approve runs/releases/2.6.17 --by "$USER"
md2feishu release apply runs/releases/2.6.17
md2feishu release apply runs/releases/2.6.17 --write
md2feishu release status runs/releases/2.6.17
```

Review `runs/releases/2.6.17/audit/report.md` before approval. `release apply` defaults to dry-run. `release apply --write` updates only local Milvus docs files and requires approval of the current report hash. `release status` reports current task progress without writing.

`--link-map` targets may include `requiredLanguages`. During `release audit`, those languages are checked in the linked Markdown section; missing code blocks or placeholder snippets block the report.

```json
{
  "targets": [
    {
      "keyword": "ARRAY_REMOVE",
      "localPath": "site/en/userGuide/insert-and-delete/upsert-entities.md",
      "anchor": "Upsert-ARRAY-fields-with-partial-update-operators",
      "requiredLanguages": ["nodejs", "go", "curl"]
    }
  ]
}
```

## `reference`

Publish SDK reference docs to Feishu Drive and Bitable from explicit manifests.

```bash
md2feishu reference preflight \
  --sdk java \
  --repo ~/sdk-doc-sync/repos/milvus-sdk-java \
  --version-line v3.0.x \
  --scan-state ~/sdk-doc-sync/.claude/skills/sdk-doc-sync/scan-state.json \
  --source-path sdk-core/src/main/java \
  --format json

md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
md2feishu reference export \
  --manifest reference-manifest.json \
  --web-content-repo /Volumes/web-content-cs/web-content-java-v30 \
  --manual java-v3.0.x \
  --config scripts/config.json \
  --scope changed \
  --skip-image-down \
  --out runs/reference/java-v3.0.x/web-content-export.json \
  --format json
```

Run `reference preflight` before accepting a `NO ACTION` result for an SDK line. `reference plan` rejects no-action impact matrices unless they include source freshness evidence with `source.baselineTag`, `source.latestTag`, and, when those tags differ, diff evidence such as `source.diffRange` or `source.changedPaths` plus item-level evidence.

Manifests must use `kind: "sdk-reference-publish-manifest"`. They must not write the SDK reference `Slug` field. Tracker rows require a pre-existing, shared release audit Base via `targets.releaseAuditBaseToken`; the CLI does not create a new Base.

`reference export` is the web-content handoff stage after a passing Feishu audit. It validates the requested manual in `web-content/scripts/config.json`, runs the Feishu-to-Markdown export through `scripts/lark-docs/index.js`, checks `git diff --check`, and reports changed files, untracked files, unrelated dirty files, and suggested staging paths. The default `--scope changed` exports only manifest doc actions by title; `--scope all` rebuilds the full manual. The command does not stage, commit, push, or open pull requests.

Use a case-sensitive `web-content` checkout or worktree on macOS. The command fails closed if the checkout is case-insensitive and contains case-conflicting tracked paths.

Common `reference export` options:

- `--web-content-repo <path>` - local `web-content` checkout, usually a fork branch/worktree.
- `--manual <manual>` - manual key in `scripts/config.json`, such as `java-v3.0.x`.
- `--config <file>` - config path relative to `--web-content-repo` unless absolute.
- `--scope changed` - export only manifest doc actions by title.
- `--scope all` - rebuild all docs for the manual.
- `--skip-image-down` - skip image downloads; use this for normal SDK reference text updates.
- `--out <file>` - write the handoff report JSON.

See [SDK Reference Workflow](/guide/sdk-reference-workflow) for the full team runbook, including impact matrix examples and fork PR handoff.
