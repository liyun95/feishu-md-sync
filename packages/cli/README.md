# feishu-md-sync

`feishu-md-sync` is a dry-run-first sync bridge between local Markdown and Feishu/Lark online documents. It uses the official `lark-cli` for authentication and Feishu document IO, then adds profiles, receipts, safety gates, status, diff, pull, merge, and publish UX.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Install

Install and authenticate the official Lark CLI:

```bash
npx @larksuite/cli@latest install
lark-cli auth login --domain docs,wiki,drive
lark-cli auth status --verify
```

With Node.js 20 or newer, install `feishu-md-sync` globally:

```bash
npm install --global feishu-md-sync@latest
feishu-md-sync --help
```

For a one-off run without a global install, use `npx --yes feishu-md-sync@latest --help`.

The selected `lark-cli` identity must have access to the target document, Drive folder, or Wiki parent.

## Main Commands

| Need | Command |
| --- | --- |
| Publish local Markdown to Feishu | `feishu-md-sync publish` |
| Create a new Feishu document from Markdown | `feishu-md-sync publish --create` |
| Pull a remote Markdown snapshot | `feishu-md-sync pull` |
| Check local/remote state | `feishu-md-sync status` |
| Inspect publish diff | `feishu-md-sync diff` |
| Merge remote edits into local Markdown | `feishu-md-sync merge` |

## Common Flow

The default profile is `none`. Start with a read-only status check and diff:

```bash
feishu-md-sync status ./doc.md --target DocToken
feishu-md-sync diff ./doc.md --target DocToken
```

Preview a publish without writing to Feishu:

```bash
feishu-md-sync publish ./doc.md --target DocToken
```

Write to an existing remote document for the first time after reviewing the plan:

```bash
feishu-md-sync publish ./doc.md --target DocToken --write --confirm-untracked-remote
feishu-md-sync status ./doc.md --target DocToken
```

If the remote document changed, pull a reviewable snapshot and merge it locally:

```bash
feishu-md-sync pull --target DocToken --output doc.remote.md --write-receipt
feishu-md-sync merge ./doc.md --target DocToken
feishu-md-sync publish ./doc.md --target DocToken --write
```

When the merge already makes the publish draft match Feishu, the final write is a no-op remote update that refreshes the local receipt and merge base.

Create a new document under a Drive folder or Wiki parent:

```bash
feishu-md-sync publish ./doc.md --target FolderOrWikiToken --create --write
```

Inspect local auth loading without printing secrets:

```bash
feishu-md-sync doctor auth --format json
```

## Profiles

Omit `--profile` or use `--profile none` for general Markdown sync.

Use `--profile zilliz` when local Markdown uses Milvus wording but the Feishu document is a Zilliz Cloud publishing draft. Use `--profile milvus` mainly when pulling or merging that content back into the local Milvus-shaped source.

## Safety Model

- Remote writes require `publish --write`.
- The first write to an existing untracked document also requires `--confirm-untracked-remote`.
- Block-patch updates or deletions that may affect comments, anchors, or block identity require `--confirm-collaboration-risk`.
- Whole-document replacement requires `--strategy document-replace --confirm-destructive`.
- `status` and `diff` are read-only; `merge` writes only local files and supports `--abort`.

## Development

From a repository checkout:

```bash
npm install
npm run build
npm run typecheck
npm test
npm run test:package
```

Generated outputs such as `dist/` and `coverage/` should not be committed.
