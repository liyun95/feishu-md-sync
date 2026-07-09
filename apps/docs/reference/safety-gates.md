# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `publish`, `publish-new`, `push`, `sync`, `code-blocks apply`, `multisdk apply`, `reference apply`, `release apply` | Prevent accidental Feishu writes. |
| `--write` plus confirmation | Feishu and local docs writes | Requires explicit user intent. |
| Pull overwrite gate | `pull --target` | Prevent a remote snapshot from replacing an existing local file without `--overwrite`. |
| Receipt conflict check | `publish` block-patch and whole-document `sync` | Prevent overwriting remote edits. |
| Heading scope uniqueness | `push --scope heading:"..."` | Prevent ambiguous scoped writes. |
| Replace-all gate | `push --strategy document-replace --replace-all` | Prevent silent full-document replacement. |
| Docs v2 overwrite gate | `push --write-backend docx-v2-overwrite --replace-all` | Keep native Markdown table rendering and local media upload behind explicit whole-document approval. |
| Validation evidence | `multisdk apply --write` | Prevent untested snippets from reaching Feishu. |
| Report hash approval | `release apply --write` | Prevent stale audit approvals. |
| Human release trigger | `sdk-reference-web-content-release` | Prevent authoring tasks from touching `web-content` prematurely. |
| Readback audit | `publish`, `publish-new`, `sync`, `multisdk`, `reference` | Prove remote state matches the plan. |
| Visual inspection | `publish`, `publish-new`, `push` | Catch rendered formatting or edit-history issues that hash verification cannot show. |

## Publish gates

`publish` is the new local Markdown to Feishu/Lark online document path. It defaults to dry-run and prints the planned strategy before any write:

- `no-op` means the remote already matches the desired published draft.
- `block-patch` creates, updates, or deletes supported Markdown blocks without replacing the whole document.
- `document-replace` is a guarded fallback for unsafe block structures or explicit overwrite workflows.
- `create-document` creates a new doc under a Drive folder or Wiki parent.

`publish --write` refuses unsafe writes unless the matching confirmation flag is present:

- Existing remote without a receipt requires `--confirm-untracked-remote`.
- Updating or deleting existing blocks requires `--confirm-collaboration-risk`.
- Whole-document replacement requires `--strategy document-replace --confirm-destructive`.
- Remote changes since the last publish receipt refuse auto/block-patch writes. Review or pull the remote changes before retrying, or explicitly choose guarded `document-replace`.

Create-only block patches do not require collaboration-risk confirmation because they do not replace existing block identities. Update and delete operations require the confirmation because comments, anchors, or block identity can be affected.

## Pull gates

`pull --target` writes a local remote snapshot. It does not write to Feishu, does not merge, and does not replace the canonical local source by default.

- `--output` is required.
- Existing output files are refused unless `--overwrite` is present.
- `--write-receipt` writes an independent pull snapshot receipt under `.sync/feishu-md-sync/pulls/`.
- Pull receipts do not affect publish receipts.

## Status gates

`status --target` is read-only. It reads the local Markdown file, the publish receipt, and the current remote Markdown export. It does not write local files, write receipts, fetch blocks, or plan a block patch. Use `publish` dry-run for the detailed write plan.

## Push strategy gates

Push dry-run chooses the write strategy before any Feishu write:

- `block-patch` is low risk and updates, creates, or deletes small block ranges when safe.
- `section-replace` is medium risk and must name the heading section and block counts before approval.
- `document-replace` is high risk and is refused unless `--replace-all` is explicit.

Push refuses or escalates unsafe block-level writes when:

- A requested heading scope is missing or duplicated locally.
- A requested heading scope is missing or duplicated remotely.
- The desired scoped content expands far beyond the current remote scope.
- Local rendering sees raw escaped Feishu Markdown that should have been normalized during pull.
- A block type or nested structure cannot be updated in place and the fallback range is too large for an automatic block write.

Scoped push writes can pass readback verification without updating the whole-document receipt. If a later `status` reports `diverged`, inspect the scoped write output and readback evidence before treating it as a failed push.

Docs v2 overwrite is a whole-document backend. Use it only after the dry-run plan is reviewed and the user approves `--replace-all`; then check the table and media readback counts printed by the CLI.
