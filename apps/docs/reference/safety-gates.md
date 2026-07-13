# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `publish` | Prevent accidental Feishu writes. |
| `--write` | `publish` | Requires explicit remote write intent. |
| Destructive confirmation | `publish --strategy document-replace` | Prevent silent whole-document replacement. |
| Collaboration-risk confirmation | `publish` block updates/deletes | Make comment, anchor, and block identity risk explicit. |
| Untracked-remote confirmation | `publish` against an existing remote without receipt | Prevent accidental adoption or overwrite of a document the CLI has not tracked before. |
| Pull overwrite gate | `pull` | Prevent a remote snapshot from replacing an existing local file without `--overwrite`. |
| Merge abort state | `merge` | Allow local recovery after in-place merge writes. |
| Readback verification | `publish` writes | Prove Feishu content matches the intended publish draft after writing. |

## Publish Gates

`publish` defaults to dry-run and prints the planned strategy before any write:

- `no-op` means the remote already matches the desired published draft.
- `block-patch` creates, updates, or deletes supported Markdown blocks without replacing the whole document.
- `blocked` means scoped planning found an unsupported, ambiguous, or conflicting change.
- `document-replace` is available only as an explicit overwrite workflow.
- `create-document` creates a new doc under a Drive folder or Wiki parent.

`publish --write` refuses unsafe writes unless the matching confirmation flag is present:

- Existing remote without a receipt requires `--confirm-untracked-remote`.
- Updating or deleting existing blocks requires `--confirm-collaboration-risk`.
- Whole-document replacement requires `--strategy document-replace --confirm-destructive`.
- A remote change inside the same managed text or table scope blocks the write.
- A remote change outside locally changed scopes produces a warning but does not block the disjoint scoped write.

## Pull Gates

`pull` writes a local remote snapshot. It does not write to Feishu, does not merge, and does not replace the canonical local source by default.

- `--output` is required.
- Existing output files are refused unless `--overwrite` is present.
- `--write-receipt` writes an independent pull snapshot receipt under `.sync/feishu-md-sync/pulls/`.
- Pull receipts do not affect publish receipts.

## Status And Diff Gates

`status` and `diff` are read-only. For HTML tables and semantic receipts, they also fetch Docx blocks to report scope-aware conflicts and row-level changes. They never write files, remote content, or receipts.

Use `publish` dry-run for the detailed write plan.

## Merge Gates

`merge` writes only local files.

- It refuses to run when the local file already contains unresolved conflict markers.
- It refuses to start a new in-place merge when a merge state already exists for the file.
- It writes abort state before modifying the local file.
- `merge --abort` restores the pre-merge local file and removes that abort state.
- Conflicts exit with code `1` and write standard `LOCAL/REMOTE` conflict markers.
