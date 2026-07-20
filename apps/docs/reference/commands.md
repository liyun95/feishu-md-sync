# Command Reference

Examples use the installed `feishu-md-sync` binary. When developing from source, use `npm run dev -- <command> ...`.

## Global options

Print the installed package version:

```bash
feishu-md-sync --version
```

Commands that accept `--format json` write successful command results to stdout. Failures write one JSON object to stderr and use a categorized non-zero exit code:

```json
{
  "ok": false,
  "error": {
    "type": "confirmation_required",
    "subtype": "collaboration_risk",
    "message": "block-patch replacing or deleting existing blocks requires --confirm-collaboration-risk",
    "hint": "review the affected blocks and obtain explicit approval for the collaboration risk",
    "requiredFlags": ["--confirm-collaboration-risk"],
    "retryable": false
  }
}
```

Stable error categories and exits:

| Error type | Exit | Meaning |
| --- | ---: | --- |
| `validation` | 2 | Invalid command, option, target, profile, or local input. |
| `authentication` | 3 | No valid user login or token. |
| `authorization` | 3 | The selected user or bot lacks permission or scope. |
| `config` | 3 | Required local configuration or `lark-cli` is unavailable. |
| `network` | 4 | Transport failure that may be retryable. |
| `verification` | 5 | Post-write readback does not match the intended result. |
| `internal` | 5 | Unexpected CLI or adapter failure. |
| `conflict` | 1 | Local and remote changes cannot be reconciled safely. |
| `confirmation_required` | 10 | The reviewed write needs explicit human approval. |

Agents and scripts should branch on the exit code plus `error.type` and `error.subtype`, not on `error.message`. They must not automatically retry exit `10` with the listed confirmation flags. A blocked publish dry-run and a merge conflict remain complete domain results on stdout and exit `1` rather than becoming stderr error envelopes.

## `publish`

```bash
feishu-md-sync publish <markdown-file> --target <docx-or-wiki-or-folder> [options]
```

Options:

- `--target <url-or-token>` - existing docx URL/token, Wiki node URL/token, or Drive folder token.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--dialect <dialect>` - `gfm`, `zdoc-authoring`, or `milvus-authoring`.
- `--write` - write to Feishu. Omitted means dry-run.
- `--create` - create a new document under a Drive folder or Wiki parent target.
- `--strategy <strategy>` - `auto`, `block-patch`, or `document-replace`. Defaults to `auto`.
- `--confirm-destructive` - required with `--strategy document-replace --write`.
- `--confirm-collaboration-risk` - required when replacing or deleting existing blocks.
- `--confirm-untracked-remote` - required before adopting an existing remote document without a publish receipt.
- `--sync-whiteboards` - include eligible same-name local SVG assets in planning and publishing.
- `--confirm-remote-whiteboard-overwrite <asset-key>` - allow overwriting one remotely changed Whiteboard after review. Repeat for multiple assets.
- `--format <format>` - `pretty` or `json`.

`auto` may return `blocked`; it does not select `document-replace` automatically. A block-patch plan can contain ordinary text operations, Callout child operations, first-class Code operations, and table replacements in the same publish.

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

Publish a canonical note Callout through the same command:

```html
<div class="alert note">

Use load-time CPU adaptation.

</div>
```

Use `alert warning` for warnings. The body is locally managed; the existing remote title, emoji, colors, and Callout container are preserved. Creating a new Callout uses the configured title and the built-in note or warning presentation. Changing `note` to `warning`, or changing unsupported body content, returns a blocked plan.

## `baseline adopt`

```bash
feishu-md-sync baseline adopt <markdown-file> --target <docx-or-wiki> \
  (--local-baseline <file> | --git-ref <ref>) [options]
```

This command establishes a publish receipt for an existing, intentionally divergent local/remote pair without changing Feishu. It models:

- L0: the explicitly selected local file or the source file at the selected Git ref
- L1: the current workspace file
- R0: the current Feishu revision, Markdown snapshot, blocks, Code metadata, and semantic document

Options:

- `--target <url-or-token>` - existing docx or Wiki document.
- `--local-baseline <file>` - explicit L0 Markdown file.
- `--git-ref <ref>` - Git commit/ref containing the source file at L0.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--dialect <dialect>` - `gfm`, `zdoc-authoring`, or `milvus-authoring`.
- `--apply` - atomically write only the local receipt and sidecars.
- `--confirm-baseline-adoption <fingerprint>` - confirm the exact reviewed L0/L1/R0 state.
- `--format <format>` - `pretty` or `json`.

The default dry-run reports source and publish hashes for L0 and L1, R0 revision and hashes, an L0/R0 divergence summary, the prospective L0 to L1 scoped operations, protected resources, tracked Whiteboards, blockers, and `safeToAdopt`. Public-site link fallback, ambiguous correspondence, remote Code metadata gaps, changed protected resources, or changed tracked Whiteboards block adoption.

After review:

```bash
feishu-md-sync baseline adopt ./doc.md --target DocToken --git-ref HEAD \
  --apply --confirm-baseline-adoption <fingerprint> --format json
```

`--apply` has no remote-write meaning. The command exposes no `--write`, destructive replacement, collaboration-risk, or untracked-remote confirmation option. Before committing the receipt, it refetches R0 and refuses the adoption if the revision or Markdown hash changed. Never create or edit receipt JSON or sidecars by hand.

## Profiles

Omit `--profile` to use the configured default. In a fresh setup, the default profile is `none`.

The `zilliz` profile transforms local Milvus-oriented Markdown for Zilliz Cloud publishing, including the shared product-name wrapper:

```html
<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>
```

Use `--profile milvus` mainly when pulling or merging Feishu content back into Milvus-shaped local Markdown.

## Source dialects

Omit `--dialect` to use `defaultDialect` from workspace configuration, then `gfm` as the final fallback. Dialect preprocessing runs before profile transformation.

- `gfm` preserves ordinary Markdown and warns when source-only syntax looks like another dialect.
- `zdoc-authoring` inventories Zdoc components, preserves Procedures boundaries, converts supported Admonitions, and protects adopted Supademo ISV blocks.
- `milvus-authoring` expands `Variables.json`, frontmatter overrides, and recursive `fragments/` references before publishing.

Unsupported source constructs produce `dialectBlockers` and block the complete plan, including create and document-replace strategies.

For `zdoc-authoring`, status, diff, and publish plans also expose `zdocRoundTrip`. Unknown components, invalid Procedures boundaries, or missing, ambiguous, changed, or locally removed tracked Supademo resources set `safeToPublish: false` and block writes.

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

`pull` uses `lark-cli docs +fetch --doc-format markdown` as the remote export and also reads the native Docx block tree when available. Native child paragraphs and nested list blocks are used to repair the known lossy list serialization in the Markdown export. The repair requires one exact correspondence between the native tree and either the correct or known lossy Markdown representation; ambiguous correspondence fails closed. Other Markdown, Callouts, and resource representations continue to come from the official export. The custom layer also handles target parsing, profile filtering, overwrite protection, local write verification, and optional receipt writing.

Recognized Feishu Callouts are written as canonical `<div class="alert note|warning">` HTML without the presentation title. The pull path also normalizes a Feishu export variant that wraps the title and body in consecutive `<p>` elements, and reports this compatibility normalization in `warnings`. If a custom title is not recognizable, pull may resolve its type from the native Docx Callout metadata; it still fails closed when neither the configured title nor block metadata identifies a type.

## `status`

```bash
feishu-md-sync status <markdown-file> --target <docx-or-wiki> [options]
```

Options:

- `--target <url-or-token>` - existing docx or Wiki node URL/token.
- `--profile <profile>` - `zilliz`, `milvus`, or `none`.
- `--dialect <dialect>` - `gfm`, `zdoc-authoring`, or `milvus-authoring`.
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
- `--dialect <dialect>` - `gfm`, `zdoc-authoring`, or `milvus-authoring`.
- `--sync-whiteboards` - include per-asset Whiteboard state and planned action.
- `--format <format>` - `pretty` or `json`.

`diff` compares current remote Markdown to the local publish draft after applying the selected publish profile.

For supported HTML tables, JSON and pretty output also include table identity, added row keys, updated row keys, and changed column indexes.

Callouts are reported as their own scoped category. For example:

```text
callout[note]: Build index [0]
  ~ paragraph 2
  + bullet 3
```

Child changes in the same Callout are compared independently. A teammate edit to a different child is reported as an unrelated remote change; an edit to the same child blocks publish.

Code blocks are reported under `scoped.codeBlocks` with content, language, movement, and section-reconcile summaries. Pretty output uses forms such as `code[python]: Build index [0]` and `code-section: Search [0] [reconcile]`.

With `--sync-whiteboards`, output includes each asset key, state (`clean`, `local-changed`, `remote-changed`, `conflict`, `untracked`, or `missing`), and recommended action. Ordinary `zdoc-authoring` status, diff, and publish output also includes receipt-tracked direct SVG assets with the action `preserve tracked whiteboard`, plus the protected block ID and Whiteboard token in JSON output.

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
- `--dialect <dialect>` - `gfm`, `zdoc-authoring`, or `milvus-authoring`.
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

Remote Callouts are canonicalized before the line merge. Target-based merge fails closed when an untracked custom presentation title cannot be recognized from workspace configuration, and it never infers a type from title substrings.

Automatic merge is supported only for `gfm`. With `zdoc-authoring` or `milvus-authoring`, `merge` returns `state: blocked` before fetching remote content or modifying the local source. `merge --abort` remains available regardless of the configured dialect.

## `doctor auth`

```bash
feishu-md-sync doctor auth --format json
```

Reports which `.env` files were checked or loaded and which `lark-cli` identity will be requested. It never prints secrets.
