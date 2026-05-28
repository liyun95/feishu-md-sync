# Safety Gates

| Gate | Applies to | Why |
| --- | --- | --- |
| Dry-run default | `sync`, `code-blocks apply`, `multisdk apply`, `reference apply`, `release apply` | Prevent accidental writes. |
| `--write` plus confirmation | Feishu and local docs writes | Requires explicit user intent. |
| Receipt conflict check | whole-document `sync` | Prevent overwriting remote edits. |
| Section uniqueness | `sync --section` | Prevent ambiguous partial writes. |
| Validation evidence | `multisdk apply --write` | Prevent untested snippets from reaching Feishu. |
| Report hash approval | `release apply --write` | Prevent stale audit approvals. |
| Human release trigger | `sdk-reference-web-content-release` | Prevent authoring tasks from touching `web-content` prematurely. |
| Readback audit | `sync`, `multisdk`, `reference` | Prove remote state matches the plan. |
