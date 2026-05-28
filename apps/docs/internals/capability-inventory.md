# Capability Inventory

This inventory reflects the current `md2feishu` command surface and should be updated when commands are added, renamed, or removed.

## Implemented Workflows

| Workflow | Commands | Primary artifacts | Write targets |
| --- | --- | --- | --- |
| Baseline sync | `pull`, `status`, `diff`, `merge`, `sync` | `.sync/feishu/*.json`, `.merged.md` | Feishu docx |
| Section sync | `sync --section <heading>` | dry-run/write receipt output; whole-document receipt intentionally unchanged | Feishu docx section blocks |
| Code blocks | `code-blocks inspect/plan/export/apply/audit/update` | manifest JSON, snippet files | Feishu code blocks |
| Multi-SDK examples | `multisdk init/status/export/profile/verify/diff/apply/audit/land-docs/finalize` | `task.json`, `manifest.json`, snippets, evidence, trace, handoff | Feishu code blocks, optional local docs repo |
| SDK reference authoring | `reference preflight/plan/apply/audit` | impact matrix, publish manifest, Feishu apply report, Feishu audit report | Feishu Drive, Bitable |
| SDK reference web-content release | `reference export`, `reference web-content`, `reference release run` | audited manifest, web-content export report, PR handoff report | external web-content checkout |
| Release notes | `release init/pull/scan-sdk-tags/audit/approve/apply/status` | release task dir, SDK tag matrix, audit report, approval hash | local Milvus docs checkout |
| Harness | `harness env/tools/grade` | `environment.json`, `trace/events.jsonl`, `grade.json`, `grade.md` | local task dirs |

## Known Gaps

- Official Feishu Markdown API support is selectable through `--markdown-engine`, but it still needs the live smoke checklist before treating official output as proven for every docs-team document shape.
- Non-`multisdk` harness graders are conservative adapters and currently report `incomplete` until workflow-specific artifact readers can prove a pass state.
- `FeishuClient` remains the compatibility facade while the lower-level API gateway modules mature.
- General sync now plans `noop`, `replace-section`, `replace-contiguous-blocks`, or `replace-document`; block-level planning should stay conservative until more reviewed-doc fixtures exist.
