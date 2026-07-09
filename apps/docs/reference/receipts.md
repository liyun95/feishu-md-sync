# Receipts

Receipts are written only after successful writes or explicit pull snapshot requests.

Legacy sync receipt location:

```text
.sync/feishu/
```

New-core receipt locations:

```text
.sync/feishu-md-sync/
.sync/feishu-md-sync/pulls/
```

Receipts are ignored by git.

## Why Receipts Exist

A receipt stores the last known successful sync state. On later syncs, `md2feishu` compares the current Feishu state to the receipt. If Feishu changed, the CLI refuses default writes.

New-core `publish` receipts are target-oriented. They record the last successful local Markdown to Feishu write and are used to detect remote drift before later block-patch writes.

New-core `pull` receipts are output-oriented. They record that one local `*.remote.md` snapshot came from one remote document revision. They do not mean the canonical local source file is synchronized, and they do not affect `publish` remote drift checks.

## Legacy Sync Stored Data

Legacy sync receipts include:

- source path
- source hash
- source snapshot
- Feishu document ID
- Feishu state hash
- best-effort Feishu Markdown snapshot
- block counts
- write result
- verification result
- timestamp

## New-Core Pull Snapshot Data

Pull snapshot receipts include:

- `kind: "pull-snapshot"`
- target docx or Wiki token
- output path
- profile
- remote revision when available
- raw official Markdown export hash
- profile-filtered output hash
- pull timestamp

## Resolved Merge Files

When syncing `doc.merged.md`, the CLI checks whether it can map back to `doc.md`.

If the original receipt exists, the CLI reuses it, writes the resolved content to Feishu, verifies readback, updates `doc.md`, and updates the original receipt.
