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

## Agent Skill

Install the Agent Skill from the release tag matching the CLI version:

```bash
npm install --global feishu-md-sync@0.3.0
npx skills add 'liyun95/feishu-md-sync#v0.3.0' --skill feishu-md-sync --global --yes
```

Invoke it explicitly during dogfood:

```text
Use $feishu-md-sync to inspect and publish ./doc.md to this Feishu document. Start with status, diff, and dry-run.
```

The Skill uses the CLI's JSON plans and error contract. It never automatically enables destructive replacement, Whiteboard sync, or confirmation flags.

## Main Commands

| Need | Command |
| --- | --- |
| Publish local Markdown to Feishu | `feishu-md-sync publish` |
| Create a new Feishu document from Markdown | `feishu-md-sync publish --create` |
| Pull a remote Markdown snapshot | `feishu-md-sync pull` |
| Check local/remote state | `feishu-md-sync status` |
| Inspect publish diff | `feishu-md-sync diff` |
| Merge remote edits into local Markdown | `feishu-md-sync merge` |
| Establish an explicit local-only publish baseline | `feishu-md-sync baseline adopt` |

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

To adopt intentional history that predates the receipt, review an explicit L0/L1/R0 baseline without writing Feishu:

```bash
feishu-md-sync baseline adopt ./doc.md --target DocToken --git-ref HEAD --format json
```

Then use the exact reviewed fingerprint to atomically write only local receipt files:

```bash
feishu-md-sync baseline adopt ./doc.md --target DocToken --git-ref HEAD \
  --apply --confirm-baseline-adoption <fingerprint> --format json
```

The command accepts `--local-baseline <file>` instead of `--git-ref <ref>`. It never writes Feishu or Base.

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
- Local baseline adoption requires exactly one explicit L0 source plus `--apply --confirm-baseline-adoption <fingerprint>`.
- The first write to an existing untracked document also requires `--confirm-untracked-remote`.
- Block-patch updates or deletions that may affect comments, anchors, or block identity require `--confirm-collaboration-risk`.
- Reconstructable HTML tables support row additions and updates keyed by a unique first column. The first implementation replaces only the matched table block and uses the same collaboration-risk confirmation.
- `--sync-whiteboards` opt-in syncs a standalone PNG reference from Markdown to a same-name local SVG source and preserves the remote Whiteboard token across updates.
- A remotely changed Whiteboard fails closed until that exact asset key is confirmed with `--confirm-remote-whiteboard-overwrite <asset-key>`.
- Unsupported or conflicting scoped changes return `strategy: blocked`; `auto` never falls back to whole-document replacement.
- Whole-document replacement requires `--strategy document-replace --confirm-destructive`.
- `status` and `diff` are read-only; `merge` writes only local files and supports `--abort`.
- Publish receipt and sidecar hashes are integrity checked; do not edit them manually.

## Editable Whiteboard Assets

Use a portable PNG reference in Markdown and keep its editable SVG source beside it:

```text
article.md -> ![Architecture](./assets/architecture.png)
assets/architecture.png
assets/architecture.svg
```

Only a standalone image line is eligible. The remote document must already contain exactly one image or Whiteboard block at the corresponding position.

```bash
feishu-md-sync status article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync diff article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync publish article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync publish article.md --target "$TARGET" --profile none --sync-whiteboards \
  --write --confirm-untracked-remote --confirm-collaboration-risk
```

The CLI validates and imports the SVG; it does not render or upload PNG bytes. Images without a sibling SVG are untouched. `--sync-whiteboards` is not supported with `--create` or `--strategy document-replace`. See the docs site for the supported SVG subset and remote-conflict workflow.

## Development

From a repository checkout:

```bash
npm install
npm run build
npm run typecheck
npm test
npm run test:package
npm run test:skill
```

Generated outputs such as `dist/` and `coverage/` should not be committed.
