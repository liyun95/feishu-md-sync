# Troubleshooting

## `Feishu changed since the last receipt`

The remote document changed after your last successful sync.

Run:

```bash
npm exec -- feishu-md-sync status ./doc.md --target DocToken
npm exec -- feishu-md-sync diff ./doc.md --target DocToken
npm exec -- feishu-md-sync merge ./doc.md --target DocToken
```

## `untracked remote: no publish receipt exists for this target`

The target document has content, but no receipt exists yet.

Run a dry-run and review the plan. If adopting the remote is intentional, pass the explicit confirmation on write:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --write --confirm-untracked-remote
```

## `Cannot merge because the previous receipt has no source snapshot`

Merge works best from a successful publish receipt that stored the last local source snapshot.

Run `pull` to inspect the current remote and resolve manually, or publish once after review so future merges have a base snapshot.

## `Verification mismatch after write`

The readback state did not match the desired write state.

Do not retry destructive writes blindly. Inspect the Feishu document and rerun a dry-run or `status`.

## Auth Or API Errors

Check:

- `lark-cli auth status`
- `FEISHU_MD_SYNC_LARK_AS`, when set
- Feishu app permissions
- whether the app can access the target docx or wiki document
