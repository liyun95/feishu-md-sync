# Command Reference

Examples use the installed `feishu-md-sync` binary. When developing from source, use `npm run dev -- <command> ...`.

## `publish`

```bash
feishu-md-sync publish <markdown-file> --target <docx-or-wiki-or-folder> [options]
```

Options:

- `--target <url-or-token>` - existing docx URL/token, Wiki node URL/token, or Drive folder token.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--write` - write to Feishu. Omitted means dry-run.
- `--create` - create a new document under a Drive folder or Wiki parent target.
- `--strategy <strategy>` - `auto`, `block-patch`, or `document-replace`. Defaults to `auto`.
- `--confirm-destructive` - required with `--strategy document-replace --write`.
- `--confirm-collaboration-risk` - required when replacing or deleting existing blocks.
- `--confirm-untracked-remote` - required before adopting an existing remote document without a publish receipt.
- `--sync-whiteboards` - include eligible same-name local SVG assets in planning and publishing.
- `--confirm-remote-whiteboard-overwrite <asset-key>` - allow overwriting one remotely changed Whiteboard after review. Repeat for multiple assets.
- `--format <format>` - `pretty` or `json`.

`auto` may return `blocked`; it does not select `document-replace` automatically. A block-patch plan can contain ordinary text operations and table replacements in the same publish.

`--sync-whiteboards` works only for existing docx or Wiki documents with `auto` or `block-patch`. It is rejected with `--create` and `document-replace`.

Dry-run an existing document update:

```bash
feishu-md-sync publish ./doc.md --target DocToken --format json
```

Write to an existing document for the first time after reviewing the dry-run:

```bash
feishu-md-sync publish ./doc.md --target DocToken --write --confirm-untracked-remote
```

Create a new document under a Drive folder or Wiki parent:

```bash
feishu-md-sync publish ./doc.md --target FolderOrWikiToken --create --write
```

Allow whole-document replacement only when intentional:

```bash
feishu-md-sync publish ./doc.md --target DocToken --strategy document-replace --write --confirm-destructive
```

Preview and publish eligible Whiteboard assets:

```bash
feishu-md-sync publish ./article.md --target DocToken --profile none --sync-whiteboards
feishu-md-sync publish ./article.md --target DocToken --profile none --sync-whiteboards \
  --write --confirm-untracked-remote --confirm-collaboration-risk
```

When the plan reports `remote-whiteboard-changed`, review the remote board and confirm only the intended asset:

```bash
feishu-md-sync publish ./article.md --target DocToken --profile none --sync-whiteboards \
  --write --confirm-collaboration-risk \
  --confirm-remote-whiteboard-overwrite assets/architecture.png
```

## Profiles

Omit `--profile` to use the configured default. In a fresh setup, the default profile is `none`.

The `zilliz` profile transforms local Milvus-oriented Markdown for Zilliz Cloud publishing, including the shared product-name wrapper:

```html
<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>
```

Use `--profile milvus` mainly when pulling or merging Feishu content back into Milvus-shaped local Markdown.

## `pull`

```bash
feishu-md-sync pull --target <docx-or-wiki> --output <file.md> [options]
```

Options:

- `--target <url-or-token>` - existing docx or Wiki node URL/token.
- `--output <file>` - local remote snapshot file.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--overwrite` - allow replacing an existing output file.
- `--write-receipt` - write an independent pull snapshot receipt.
- `--format <format>` - `pretty` or `json`.

Pull a reviewable remote snapshot:

```bash
feishu-md-sync pull --target DocToken --output doc.remote.md
```

`pull` uses `lark-cli docs +fetch --doc-format markdown` for the remote export. The custom layer handles target parsing, profile filtering, overwrite protection, local write verification, and optional receipt writing.

## `status`

```bash
feishu-md-sync status <markdown-file> --target <docx-or-wiki> [options]
```

Options:

- `--target <url-or-token>` - existing docx or Wiki node URL/token.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--sync-whiteboards` - include per-asset Whiteboard state using local SVG and receipt baselines.
- `--format <format>` - `pretty` or `json`.

States:

- `untracked` - no publish receipt exists for this target.
- `clean` - local publish draft and remote match the last receipt.
- `local-changed` - local source changed while remote still matches the receipt.
- `remote-changed` - remote changed while local still matches the receipt.
- `diverged` - local and remote both changed since the receipt.

## `diff`

```bash
feishu-md-sync diff <markdown-file> --target <docx-or-wiki> [options]
```

Options:

- `--target <url-or-token>` - existing docx or Wiki node URL/token.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--sync-whiteboards` - include per-asset Whiteboard state and planned action.
- `--format <format>` - `pretty` or `json`.

`diff` compares current remote Markdown to the local publish draft after applying the selected publish profile.

For supported HTML tables, JSON and pretty output also include table identity, added row keys, updated row keys, and changed column indexes.

With `--sync-whiteboards`, output includes each asset key, state (`clean`, `local-changed`, `remote-changed`, `conflict`, `untracked`, or `missing`), and recommended action.

## `merge`

```bash
feishu-md-sync merge <markdown-file> --target <docx-or-wiki>
feishu-md-sync merge <markdown-file> --remote <remote.md>
feishu-md-sync merge <markdown-file> --abort
```

Options:

- `--target <url-or-token>` - fetch remote Markdown from an existing docx or Wiki target.
- `--remote <file>` - use an existing remote snapshot Markdown file.
- `--base <file>` - explicit three-way merge base.
- `--profile <profile>` - local authoring profile: `milvus`, `zilliz`, or `none`.
- `--check` - report whether merge would be clean, merged, or conflicted without writing.
- `--dry-run` - print merge metadata without writing.
- `--abort` - restore the local file from the previous merge state.
- `--save-remote <file>` - save the fetched remote snapshot when using `--target`.
- `--format <format>` - `pretty` or `json`.

`merge` writes only local files. If a conflict is produced, it writes standard conflict markers and exits `1`:

```md
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
```

## `doctor auth`

```bash
feishu-md-sync doctor auth --format json
```

Reports which `.env` files were checked or loaded and which `lark-cli` identity will be requested. It never prints secrets.
