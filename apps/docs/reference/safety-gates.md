# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `publish-new`, `push`, `sync`, `code-blocks apply`, `multisdk apply`, `reference apply`, `release apply` | Prevent accidental writes. |
| `--write` plus confirmation | Feishu and local docs writes | Requires explicit user intent. |
| Receipt conflict check | whole-document `sync` | Prevent overwriting remote edits. |
| Heading scope uniqueness | `push --scope heading:"..."` | Prevent ambiguous scoped writes. |
| Replace-all gate | `push --strategy document-replace --replace-all` | Prevent silent full-document replacement. |
| Validation evidence | `multisdk apply --write` | Prevent untested snippets from reaching Feishu. |
| Report hash approval | `release apply --write` | Prevent stale audit approvals. |
| Human release trigger | `sdk-reference-web-content-release` | Prevent authoring tasks from touching `web-content` prematurely. |
| Readback audit | `publish-new`, `sync`, `multisdk`, `reference` | Prove remote state matches the plan. |
| Visual inspection | `publish-new`, `push` | Catch rendered formatting or edit-history issues that hash verification cannot show. |

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
