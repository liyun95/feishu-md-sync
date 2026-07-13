# Troubleshooting

## `Feishu changed since the last receipt`

The remote document changed after your last successful sync.

Run:

```bash
feishu-md-sync status ./doc.md --target DocToken
feishu-md-sync diff ./doc.md --target DocToken
feishu-md-sync merge ./doc.md --target DocToken
```

## `untracked remote: no publish receipt exists for this target`

The target document has content, but no receipt exists yet.

Run a dry-run and review the plan. If adopting the remote is intentional, pass the explicit confirmation on write:

```bash
feishu-md-sync publish ./doc.md --target DocToken --write --confirm-untracked-remote
```

## `Cannot merge because the previous receipt has no source snapshot`

Merge works best from a successful publish receipt that stored the last local source snapshot.

Run `pull` to inspect the current remote and resolve manually, or publish once after review so future merges have a base snapshot.

## `Verification mismatch after write`

The readback state did not match the desired write state.

Do not retry destructive writes blindly. Inspect the Feishu document and rerun a dry-run or `status`.

## `strategy: blocked`

`auto` found at least one change that cannot be matched or written safely. Review the listed blocker. Common table blockers include duplicate or empty first-column keys, row deletion/reorder, merged cells, nested lists, and a teammate edit inside the same target table.

Resolve the local or remote conflict and rerun the dry-run. Whole-document replacement remains available only when you deliberately select `--strategy document-replace --confirm-destructive`.

## `remote-whiteboard-changed` or `whiteboard-conflict`

The tracked Feishu Whiteboard changed after the last verified receipt. `remote-whiteboard-changed` means only the remote board changed; `whiteboard-conflict` means both the local SVG and remote board changed.

Inspect the remote board before deciding. There is no automatic Whiteboard pull or merge. To make the local SVG authoritative for one reviewed asset, rerun publish with its exact normalized PNG key:

```bash
feishu-md-sync publish ./article.md --target DocToken --profile none --sync-whiteboards \
  --write --confirm-collaboration-risk \
  --confirm-remote-whiteboard-overwrite assets/architecture.png
```

Repeat the option for each independently reviewed asset. Do not use a broad confirmation in place of asset-specific review.

## `inline-whiteboard-unsupported`

The PNG and same-name SVG exist, but the image is embedded in prose. Put the image reference on its own line:

```md
![Architecture](./assets/architecture.png)
```

## `invalid Whiteboard SVG`

The sibling SVG is malformed or uses a construct that cannot be imported safely. Ensure it is self-contained, has a `viewBox`, and uses supported shapes, paths, groups, symbols, text, and basic transforms. Remove scripts, embedded images, external references, filters, masks, clipping, patterns, radial gradients, and matrix/skew transforms.

## Whiteboard correspondence is ambiguous or missing

The local standalone image must map to exactly one remote image or Whiteboard block at the same semantic position. Multiple untracked asset slots under one heading are intentionally ambiguous; separate them under different headings or establish receipts one at a time. Initial adoption also requires neighboring semantic content to match, so adopt the asset before changing adjacent text. This feature does not upload the PNG or create a missing image slot. Add or move the ordinary image in Feishu, then rerun the dry-run.

## `4003101: doc data is not ready ... whiteboard`

Feishu may keep a newly created or recently updated Whiteboard in an asynchronous apply window. The CLI fails closed and does not write a receipt for that attempt. Wait for Feishu to finish applying the previous Whiteboard change, then rerun the same publish command; the Whiteboard update uses a board-, SVG-, and remote-state-specific idempotency token.

## Auth Or API Errors

Check:

- `lark-cli auth status`
- `FEISHU_MD_SYNC_LARK_AS`, when set
- Feishu app permissions
- whether the app can access the target docx or wiki document
