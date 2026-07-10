# Receipts

Receipts are written only after successful remote writes or explicit pull snapshot requests. They are ignored by git.

New-core receipt locations:

```text
.sync/feishu-md-sync/
.sync/feishu-md-sync/pulls/
.sync/feishu-md-sync/bases/
```

## Publish Receipts

`publish` receipts are target-oriented. They record the last successful local Markdown to Feishu write and are used to detect remote drift before later block-patch writes.

Stored data includes:

- target kind and token
- profile
- local source hash
- publish draft hash
- remote snapshot hash
- remote revision when available
- local base snapshot path and hash
- update timestamp

## Local Base Snapshots

After a successful `publish --write`, the CLI stores the local source Markdown used for that publish under:

```text
.sync/feishu-md-sync/bases/<target-kind>-<target-token>-local.md
```

The publish receipt stores only the snapshot path and hash:

```json
{
  "localBaseSnapshot": {
    "path": ".sync/feishu-md-sync/bases/docx-DocToken-local.md",
    "hash": "..."
  }
}
```

`merge` uses this local authoring snapshot as the three-way merge base when available:

```text
base:   last successfully published local source
local:  current local Markdown file
remote: current Feishu Markdown after pull-side profile filtering
```

If the base snapshot file is missing, `merge` falls back to conservative conflict regions. `merge` itself never updates the base snapshot; the next successful `publish --write` updates it.

## Pull Receipts

Pull snapshot receipts are output-oriented. They record that one local `*.remote.md` snapshot came from one remote document revision.

Stored data includes:

- `kind: "pull-snapshot"`
- target docx or Wiki token
- output path
- profile
- remote revision when available
- raw official Markdown export hash
- profile-filtered output hash
- pull timestamp

Pull receipts do not mean the canonical local source file is synchronized, and they do not affect publish remote drift checks.
