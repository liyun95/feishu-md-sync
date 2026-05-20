# Troubleshooting

## `Feishu changed since the last receipt`

The remote document changed after your last successful sync.

Run:

```bash
npm exec -- md2feishu status ./doc.md DocToken
npm exec -- md2feishu diff ./doc.md DocToken
npm exec -- md2feishu merge ./doc.md DocToken
```

## `Initial write would replace existing Feishu content`

The target document has content, but no receipt exists yet.

If replacing the document is intentional:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --force-initial-overwrite
```

## `Cannot merge because the previous receipt has no source snapshot`

Merge needs a successful baseline sync that stored source snapshots.

Run a successful baseline sync first, then retry merge.

## `Verification mismatch after write`

The readback state did not match the desired write state.

Do not retry destructive writes blindly. Inspect the Feishu document and rerun a dry-run or `status`.

## Auth Or API Errors

Check:

- `APP_ID`
- `APP_SECRET`
- Feishu app permissions
- whether the app can access the target docx or wiki document
