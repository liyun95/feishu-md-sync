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

## Section sync block-level gates

Section sync refuses unsafe block-level writes when:

- The local section heading is missing or duplicated.
- The remote section heading is missing or duplicated.
- The desired section expands far beyond the current remote section.
- Local rendering sees raw escaped Feishu Markdown that should have been normalized during pull.
- A block type or nested structure cannot be updated in place and the fallback range is too large for an automatic write.
- A dry-run block-level fallback is marked unsafe for write. Narrow the edit before writing.
