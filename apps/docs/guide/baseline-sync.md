# Baseline Sync

## What baseline sync does

Baseline sync refreshes local Markdown from the current Feishu document. It is a remote-to-local workflow: it can write local Markdown and an optional local baseline receipt, but it never writes content back to Feishu.

Use this page when you need to understand the workflow. Use `md2feishu workflow show baseline-sync` when you need the exact command recipe from the installed CLI.

### Use this when

- The Feishu document changed and you want to pull the current remote content before editing.
- You need a local Markdown baseline for review, comparison, or a later Feishu push.
- You want an agent to refresh local content without risking a Feishu write.

### Do not use this when

- You already have local Markdown changes that should be written to Feishu.
- You want to push local Markdown changes back to Feishu. Use [Feishu Push](/guide/push).
- You want an advanced whole-document write. Inspect the direct CLI reference and safety gates first.

## Run the workflow

Ask Codex to use:

```text
feishu-baseline-sync
```

Or inspect the CLI recipe directly:

```bash
md2feishu workflow show baseline-sync
```

### Create a new local baseline

When the output path does not exist, pull directly to that path and write a baseline receipt:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md --write-receipt
```

Expected result:

```text
wrote: doc.remote.md
receipt: .sync/feishu/...
baseline: clean
```

Quote Feishu URLs in shell commands. Wiki URLs often contain `?`, which shells such as zsh can treat as a pattern character when the URL is unquoted.

### Refresh an existing local file

When the requested output file already exists, preview the remote content first:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
```

Replace the existing file only after the diff shows that overwriting is intentional:

```bash
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
md2feishu status doc.md '<feishu-doc>'
```

The final status should report a clean baseline. If it does not, keep the existing file and remote copy separate until the mismatch is understood.

## How it works

### Decision flow

![Baseline sync decision flow](/diagrams/baseline-sync-how-it-works.png)

Baseline sync starts with one UX decision: whether the requested local output already exists. New files can be written directly. Existing files are protected by a preview-and-diff path before any intentional overwrite.

### Local artifacts

Baseline sync can create two local artifacts:

- A Markdown file containing the current Feishu content.
- A `.sync/feishu/...json` baseline receipt when `--write-receipt` is used.

The receipt records the remote state that produced the Markdown file. It is local state only.

### Why the receipt matters

`md2feishu status` is receipt-oriented. Without a receipt, a freshly pulled file can still look noisy because the CLI has no registered baseline for that local path. With a baseline receipt, the CLI can recognize that the local Markdown was created from the current Feishu state and report a clean baseline.

A pull-created receipt does not mean Feishu was written. It records a read-only pull.

### Safety boundary

Baseline sync reads Feishu and writes local files. It does not write Feishu content.

If the target local file already exists, `pull --output <file>` refuses to replace it unless `--overwrite` is explicit. This prevents a remote pull from silently erasing local-only edits.

Any later Feishu write is a separate decision. Use [Feishu Push](/guide/push) so the CLI can choose the safest write strategy from a dry-run plan.

### Completion check

Baseline sync is complete when:

- The local Markdown file exists at the agreed path.
- The baseline receipt exists if `--write-receipt` was requested.
- `md2feishu status <file> '<feishu-doc>'` reports a clean baseline, or the remaining mismatch has been explained before any write workflow starts.

## Troubleshooting

### `Refusing to overwrite existing output without --overwrite`

The output file already exists. Pull to a separate remote copy, compare it with the existing file, and replace the existing file only when the diff confirms that overwriting is intentional.

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
```

### `status` reports `no-receipt`

The Markdown file exists, but the CLI has not registered it as a baseline for that Feishu document. Pull again with `--write-receipt` if the local file should represent the current remote state.

```bash
md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
md2feishu status doc.md '<feishu-doc>'
```

### zsh rejects or changes a wiki URL

Quote the Feishu document URL:

```bash
md2feishu pull 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true' --output doc.remote.md --write-receipt
```

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Feishu Push](/guide/push)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Receipts](/reference/receipts)
