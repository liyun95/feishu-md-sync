# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `publish` | Prevent accidental Feishu writes. |
| `--write` | `publish` | Requires explicit remote write intent. |
| Destructive confirmation | `publish --strategy document-replace` | Prevent silent whole-document replacement. |
| Collaboration-risk confirmation | `publish` block updates/deletes | Make comment, anchor, and block identity risk explicit. |
| Untracked-remote confirmation | `publish` against an existing remote without receipt | Prevent accidental adoption or overwrite of a document the CLI has not tracked before. |
| Whiteboard remote-overwrite confirmation | `publish --sync-whiteboards` after remote board edits | Require confirmation for the exact asset key instead of overwriting a teammate's board edit. |
| Tracked Whiteboard protection | ordinary `zdoc-authoring` status, diff, and publish | Preserve receipt-matched block/token identity without granting Whiteboard write permission. |
| Pull overwrite gate | `pull` | Prevent a remote snapshot from replacing an existing local file without `--overwrite`. |
| Merge abort state | `merge` | Allow local recovery after in-place merge writes. |
| Readback verification | `publish` writes | Prove Feishu content matches the intended publish draft after writing. |
| Partial-write recovery checkpoint | tracked version 4/5 block-patch writes | Keep every verified operation resumable without treating the tool's own completed prefix as unrelated remote drift. |
| Baseline adoption fingerprint | `baseline adopt --apply` | Bind local receipt creation to the exact reviewed L0, L1, R0, transforms, resolver results, and scoped plan. |

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
- Creating or adopting an untracked Whiteboard requires both `--confirm-untracked-remote` and `--confirm-collaboration-risk`.
- Any Whiteboard write requires `--confirm-collaboration-risk` because the image block or board content changes.
- Updating or deleting existing Callout body blocks requires `--confirm-collaboration-risk`; deleting the complete Callout is allowed only when it is tracked and unchanged remotely.
- Updating, moving, deleting, or reconciling Code blocks requires `--confirm-collaboration-risk`. Pure Code creation does not independently require it.
- A remotely changed Whiteboard blocks the complete publish unless its normalized PNG key is explicitly passed with `--confirm-remote-whiteboard-overwrite <asset-key>`.
- A changed tracked direct SVG also requires `--sync-whiteboards` plus `--confirm-remote-whiteboard-overwrite <asset-key>`; ordinary publish protection never implies board overwrite authority.
- Missing or mismatched tracked Whiteboard receipt identity blocks scoped publish and document replacement instead of degrading the board to an image.
- A remote change inside the same managed text, Callout child, Code field/scope, or table scope blocks the write.
- A remote change outside locally changed scopes produces a warning but does not block the disjoint scoped write.

## Pull Gates

`pull` writes a local remote snapshot. It does not write to Feishu, does not merge, and does not replace the canonical local source by default.

- `--output` is required.
- Existing output files are refused unless `--overwrite` is present.
- `--write-receipt` writes an independent pull snapshot receipt under `.sync/feishu-md-sync/pulls/`.
- Pull receipts do not affect publish receipts.

## Status And Diff Gates

`status` and `diff` are read-only. For Code blocks, Callouts, HTML tables, semantic receipts, tracked `zdoc-authoring` Whiteboards, and `--sync-whiteboards`, they also fetch Docx blocks to report scope-aware conflicts, field/child/row-level changes, movement, reconcile summaries, and per-asset Whiteboard state. They never write files, remote content, or receipts.

Use `publish` dry-run for the detailed write plan.

Block IDs are re-resolved from stable semantic locators immediately before dependent creates, because a preceding block replacement may invalidate the ID captured during planning. Table mutations are never repeated merely because immediate readback is stale; the CLI waits through an extended stabilization window, requires the mutation revision to be visible when the adapter reports one, retries readback only, then checkpoints the verified remote state.

When a write returns `verification/partial_write`:

- inspect `completedOperations`, `failedOperation`, `pendingOperations`, and the structured underlying `cause`;
- when `recoveryCheckpointWritten=true`, rerun planning against the checkpointed revision and review only the remaining operations;
- when no checkpoint was written, do not retry automatically—inspect the remote and use explicit baseline repair only when the remote changes can be proven to be the command's own completed writes;
- obtain a new collaboration-risk or other required confirmation before any remaining remote write.

## Baseline Adoption Gates

`baseline adopt` is a local-only repair path for intentional history that predates the receipt. It requires exactly one explicit L0 source: `--local-baseline <file>` or `--git-ref <ref>`.

- Dry-run is the default and writes no local or remote state.
- `--apply` writes only a version 4/5 publish receipt and content-addressed local, publish, and remote-semantic sidecars.
- `--apply` requires `--confirm-baseline-adoption <fingerprint>` from the exact reviewed dry-run.
- A changed L0, L1, R0 revision/hash, dialect/profile result, resolver result, protected resource, Whiteboard state, or scoped plan invalidates the fingerprint or blocks adoption.
- Public-site link fallback is blocked for baseline adoption because it would make the adopted publish draft depend on an unresolved authoring destination.
- Sidecars are written before the receipt; the receipt rename is the commit marker. A failed local transaction leaves the previous receipt pointing to its previous immutable sidecars.
- The command never calls Feishu block replace/create/move/delete APIs, document replacement, Whiteboard mutation, document creation, or Base writes.
- Later `publish` keeps all remote drift, overlap, correspondence, Callout, Code, table, Whiteboard, protected-resource, collaboration-risk, and document-replace protections.

Receipt JSON and sidecars are integrity checked. Editing them manually is not a supported recovery path.

## Merge Gates

`merge` writes only local files.

- It refuses to run when the local file already contains unresolved conflict markers.
- It refuses to start a new in-place merge when a merge state already exists for the file.
- It writes abort state before modifying the local file.
- `merge --abort` restores the pre-merge local file and removes that abort state.
- Conflicts exit with code `1` and write standard `LOCAL/REMOTE` conflict markers.
