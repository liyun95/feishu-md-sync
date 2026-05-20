# Receipts

Receipts are written only after successful writes.

Location:

```text
.sync/feishu/
```

Receipts are ignored by git.

## Why Receipts Exist

A receipt stores the last known successful sync state. On later syncs, `md2feishu` compares the current Feishu state to the receipt. If Feishu changed, the CLI refuses default writes.

## Stored Data

Receipts include:

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

## Resolved Merge Files

When syncing `doc.merged.md`, the CLI checks whether it can map back to `doc.md`.

If the original receipt exists, the CLI reuses it, writes the resolved content to Feishu, verifies readback, updates `doc.md`, and updates the original receipt.
