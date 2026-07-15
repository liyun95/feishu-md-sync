# Troubleshooting

## Machine-readable failures

When automating the CLI, add `--format json`. Failures are written to stderr as `{ "ok": false, "error": ... }`. Use the process exit code and stable `error.type` or `error.subtype` fields for recovery decisions.

- `validation`: fix the command or local input before retrying.
- `authentication` or `authorization`: run `feishu-md-sync doctor auth --format json`, then verify the official `lark-cli` login, identity, scopes, and resource access.
- `config`: install or configure `lark-cli`, or fix the reported workspace configuration.
- `network`: retry only when `error.retryable` is `true`.
- `confirmation_required`: show the dry-run risk to the user and wait for explicit approval. Do not append `requiredFlags` automatically.
- `conflict`: inspect status and diff, then resolve or merge the overlapping change.
- `verification`: inspect the remote document before retrying; the CLI did not accept the write as verified.
- `internal`: preserve the command inputs and report the failure if it is reproducible.

The official `lark-cli` error subtype, hint, missing scopes, and developer-console URL are preserved when available.

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

Common Callout blockers include `callout-type-change`, unsupported changed body content, and `remote-callout-conflict` when local and remote changed the same child block. Keep the canonical `<div class="alert note|warning">` wrapper, resolve the overlapping body edit, or move unsupported content outside the Callout before rerunning the dry-run.

Common Code blockers include `unsupported-code-language`, `unsupported-code-info-string`, `remote-code-conflict`, `remote-code-scope-changed`, `code-correspondence-ambiguous`, and `caption-correspondence-ambiguous`. Configure a language alias, remove unsupported fence attributes, or resolve the overlapping remote edit before rerunning. The CLI does not automatically replace the whole document around a Code blocker.

Resolve the local or remote conflict and rerun the dry-run. Whole-document replacement remains available only when you deliberately select `--strategy document-replace --confirm-destructive`.

## `Cannot identify remote Callout type from title ...`

The official Markdown export contains a Callout title that is neither a configured title nor an English default. Standalone `pull` and target-based `merge` have no publish semantic baseline, so they refuse to flatten or guess the wrapper.

Add the exact localized titles to `feishu-md-sync.config.json`, then rerun:

```json
{
  "callouts": {
    "noteTitle": "说明",
    "warningTitle": "警告"
  }
}
```

A tracked publish can continue to recognize a later customized remote title from its semantic receipt while preserving that title during body updates.

## Partial scoped write

The write stopped after one operation failed. Operations already verified in Feishu are not rolled back, and no new publish receipt is written.

Inspect the remote document, then rerun the same dry-run and publish. The planner reads current Feishu state and skips children that already match. Do not switch to whole-document replacement merely to clear the partial state.

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

Feishu may keep a newly created or recently updated Whiteboard in an asynchronous apply window. After one Whiteboard update, the CLI retries only the readback with bounded backoff; it does not repeat the update during that publish. A receipt is written only after the Whiteboard content and block identity can be verified.

If the apply window outlasts the retry budget, the CLI fails closed and does not write a receipt. Inspect the remote document, wait for Feishu to finish applying the change, and then rerun the publish. Do not launch overlapping publish attempts for the same Whiteboard.

## Auth Or API Errors

Check:

- `lark-cli auth status`
- `FEISHU_MD_SYNC_LARK_AS`, when set
- Feishu app permissions
- whether the app can access the target docx or wiki document
