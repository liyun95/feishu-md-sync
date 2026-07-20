---
name: feishu-md-sync
description: Use when local Markdown is the source of truth and an agent needs to synchronize it with Feishu/Lark through status, diff, dry-run publish, scoped publish, document creation, pull, merge, receipt-aware conflict handling, or explicit SVG-to-Whiteboard synchronization. Do not use for ad hoc remote-only document editing or for creating diagram source assets.
---

# Feishu Markdown Sync

Use `feishu-md-sync` as the execution engine. This Skill supplies routing, sequencing, compatibility checks, and safety policy; it does not recreate sync logic.

## Route The Task

- Use this Skill when local Markdown is the source of truth for an existing or new Feishu document.
- Use `$lark-doc` for ad hoc reading or editing that exists only in the remote Feishu document.
- Use `$lark-shared` for login, user/bot identity, missing scopes, app configuration, and permission repair.
- Keep diagram authoring and SVG generation outside this Skill. Synchronize an existing PNG/SVG pair only when the user explicitly requests Whiteboard sync.

## Discover The Destination Role

Before selecting a source or command, determine the Feishu destination role:

- A presentation target is read-only output; channel transforms may omit source-only metadata.
- An authoring archive will be read again by a downstream publishing workflow; required authoring tokens and resource identity must survive.
- A bidirectional collaboration source may contain valid remote edits; use receipt-aware status, pull, and manual reconciliation rather than assuming local overwrite authority.

When the canonical Zdoc source is published to a Feishu authoring archive, use `--dialect zdoc-authoring` with that canonical source. Do not create or maintain a hidden publish view as a second source of truth.

Inspect `zdocRoundTrip` in status, diff, and publish dry-run output. Stop when `safeToPublish` is false, a Procedures boundary is invalid, or a Supademo resource is missing, ambiguous, changed, or locally removed after adoption. A proposed Supademo adoption records and protects the existing ISV block; it does not recreate or replace it. A Procedures move requires review of the affected block ID and collaboration-risk confirmation.

Also inspect receipt-recorded round-trip loss items. A repairable local-only table may plan an anchored native `table-create`, and a repairable remote-only duplicate paragraph may plan a delete. Review both operations and require collaboration-risk confirmation for the delete. After a partial write, an already-created native table may be preserved only when its locator, complete semantic content, and both baseline anchors still match exactly; this does not authorize another table creation. Any local drift, remote drift, ambiguous baseline divergence, or changed table anchor blocks the publish.

When a previous scoped create failed readback without writing a receipt, accept recovery only when the dry-run explicitly reports the exact completed-create prefix, an exact flattened desired-tree preorder plus the unchanged baseline suffix, an exact staged direct-create prefix, or one or more exact structured malformed-create groups plus that unchanged suffix. The malformed signature must include every created root and descendant block ID; it covers Markdown or composite XML insertion merging leading child paragraphs into list text, retaining nested list children, and omitting later paragraphs. Nested recovery writes must use explicit Docx child-block creation under returned parent IDs, with deterministic idempotency tokens and batch readback; do not review or authorize another composite Markdown/XML tree insertion. Review every partial/malformed/flat/suffix root scheduled for deletion. Confirm that resolved Feishu links are present in the desired child-block payload, and retain collaboration-risk and asset-specific Whiteboard confirmations. Any extra remote block, changed content/order/parent/child identity, local drift, or preflight anchor drift blocks recovery.

## Resolve The CLI

Treat the executable as one path, never as a shell fragment.

```bash
if [ -n "${FEISHU_MD_SYNC_BIN:-}" ]; then
  FMS="$FEISHU_MD_SYNC_BIN"
else
  FMS="$(command -v feishu-md-sync)"
fi
test -n "$FMS" && test -x "$FMS"
"$FMS" --version
command -v lark-cli
```

When the user supplies an external read-only sync config, set `FEISHU_MD_SYNC_CONFIG` to that exact file before every related status, diff, baseline, and publish command. Do not copy the config into the source repository or silently substitute another config.

For PATH-based stable use, require `feishu-md-sync >=0.4.0 <0.5.0`. Stop and give the matching npm upgrade command when the version is outside this range or cannot be parsed.

`FEISHU_MD_SYNC_BIN` explicitly selects an unreleased development build. If its package version is outside the stable range, continue only when all of these probes succeed:

```bash
"$FMS" --help
"$FMS" publish --help
"$FMS" status --help
"$FMS" diff --help
"$FMS" pull --help
"$FMS" merge --help
"$FMS" baseline adopt --help
"$FMS" doctor auth --help
```

Require the top-level commands `publish`, `status`, `diff`, `pull`, `merge`, `baseline`, and `doctor`. Require every option used by this Skill: publish `--target`, `--profile`, `--dialect`, `--write`, `--create`, `--strategy`, `--confirm-destructive`, `--confirm-collaboration-risk`, `--confirm-untracked-remote`, `--sync-whiteboards`, `--confirm-remote-whiteboard-overwrite`, and `--format`; baseline adopt `--target`, `--profile`, `--dialect`, `--local-baseline`, `--git-ref`, `--apply`, `--confirm-baseline-adoption`, and `--format`; status and diff `--target`, `--profile`, `--dialect`, `--sync-whiteboards`, and `--format`; pull `--target`, `--output`, `--profile`, `--overwrite`, and `--format`; merge `--target`, `--profile`, `--dialect`, `--check`, `--abort`, and `--format`; doctor auth `--format`. Do not search arbitrary worktrees or guess another build.

## Check Authentication

When Feishu IO fails with `authentication`, `authorization`, or `config`:

```bash
"$FMS" doctor auth --format json
```

Then invoke `$lark-shared` when available. Preserve the reported subtype, hint, missing scopes, and console URL. Never request, print, store, or move an App Secret into this project. Do not run a user login to repair bot permissions.

## Resolve The Source Dialect

When the user explicitly supplies `gfm`, `zdoc-authoring`, or `milvus-authoring`, use that dialect. Otherwise, run the first status without `--dialect`, read `result.dialect`, and then reuse that selected dialect explicitly for diff, publish, merge, and final status. This preserves the workspace default or the CLI's `gfm` fallback without agent-side guessing.

When `dialectDiagnostics` contains `dialect-suggestion`, explain the suggested dialect and ask the user before selecting it. Never infer and silently switch dialects from file contents, repository names, or warning text.

## Handle Dialect And Link Diagnostics

Inspect `dialectBlockers`, `dialectDiagnostics`, `linkResolution`, and resolved link details before any write.

- Any `dialectBlockers` stop the workflow. Confirmation flags cannot bypass dialect or link blockers.
- Report stale Base cache diagnostics. A stale cache remains usable when the affected links still resolve to Feishu.
- Ambiguous or unresolved links stop the workflow.
- A `link-resolver-unavailable` diagnostic with public fallback, or `linkResolution.resolvedToPublicSite > 0`, requires showing every public-site fallback URL and waiting for explicit user acceptance before writing.
- Do not parse warning message prose when a structured diagnostic code or count is available.

## Publish An Existing Document

Use JSON for every planning command:

```bash
"$FMS" status <markdown-file> --target <target> --dialect <dialect> --profile <profile> --format json
"$FMS" diff <markdown-file> --target <target> --dialect <dialect> --profile <profile> --format json
"$FMS" publish <markdown-file> --target <target> --dialect <dialect> --profile <profile> --format json
```

Use profile `none` unless the user or workspace configuration requires `milvus` or `zilliz`.

Interpret the dry-run plan before writing:

- `no-op`: report that no remote write is needed.
- A safe plan with no additional confirmation requirement: an explicit user request to publish or sync authorizes `--write`.
- `requiresUntrackedRemoteConfirmation`: explain that the workspace is adopting an existing untracked document and wait for explicit confirmation.
- `requiresCollaborationRiskConfirmation`: summarize the affected blocks and collaboration risk, then wait for explicit confirmation.
- `requiredRemoteWhiteboardOverwrites`: show each exact asset key and wait for asset-specific confirmation.
- A mixed text sequence may be reported as anchored creates plus deletes when unique unchanged section anchors bound the replacement. Show the affected blocks and require `--confirm-collaboration-risk`; duplicate or reordered anchors remain blockers.
- `blocked`, an overlapping scope conflict, or a remote change in the same managed scope: do not write. Recommend conflict resolution or pull/merge.
- `document-replace`: never select it automatically. Run it only after a document-replace dry-run and separate explicit approval.

After approval, repeat the reviewed publish command with `--write` and only the confirmation flags the user approved. Never add a `--confirm-*` flag merely because a failed command lists it.

## Adopt An Intentional Existing Baseline

Use this workflow only when the user explicitly identifies an L0 source and wants to allow known L0/R0 history while publishing only the later L0 to L1 change. Never infer L0, use L1 as the baseline, or edit receipt/sidecar files manually.

Run one JSON dry-run using either an explicit file or Git ref:

```bash
"$FMS" baseline adopt <markdown-file> --target <target> \
  --git-ref <ref> --dialect <dialect> --profile <profile> --format json

"$FMS" baseline adopt <markdown-file> --target <target> \
  --local-baseline <baseline-file> --dialect <dialect> --profile <profile> --format json
```

Inspect all of the following:

- L0 and L1 source, dialect-draft, and publish-draft hashes;
- R0 document ID, revision, Markdown hash, and semantic hash;
- the existing L0/R0 divergence summary;
- the prospective L0 to L1 scoped operations and blockers;
- protected Supademo mappings and tracked Whiteboards;
- `safeToAdopt` and the exact `confirmationFingerprint`.

Stop when `safeToAdopt` is false. Baseline adoption does not allow public-site fallback, unresolved or ambiguous links, missing remote Code metadata, ambiguous correspondence, changed protected resources, or unverifiable/changed tracked Whiteboards. No confirmation can bypass these blockers.

After presenting the reviewed state, wait for explicit approval. Then repeat only the reviewed command with:

```bash
--apply --confirm-baseline-adoption <exact-fingerprint>
```

This is a local receipt transaction, not a Feishu write. Do not add `--write`, `--confirm-untracked-remote`, `--confirm-collaboration-risk`, or `--confirm-destructive`. The command must refetch R0 before committing and fail if its revision or hash changed. After a successful adoption, run ordinary status, diff, and publish dry-run to verify that the plan contains only the intended L0 to L1 delta. Never proceed to `publish --write` without the normal publish review and user authorization.

## Create A Document

For a Drive folder or Wiki parent target:

```bash
"$FMS" publish <markdown-file> --target <folder-or-wiki-parent> --create --dialect <dialect> --profile <profile> --format json
```

Review the dry-run. If the user explicitly requested creation and the plan is safe, repeat with `--write`. Do not combine `--create` with `--sync-whiteboards`.

After creation, read the write result and run status against the returned `document.url` or `document.documentId`, not the original folder or Wiki parent:

```bash
"$FMS" status <markdown-file> --target <created-document-target> --dialect <dialect> --profile <profile> --format json
```

## Synchronize Whiteboards

Do not infer Whiteboard intent from a sibling SVG. Enable it only when the user explicitly asks to synchronize diagram assets:

```bash
"$FMS" status <markdown-file> --target <target> --dialect <dialect> --profile <profile> --sync-whiteboards --format json
"$FMS" diff <markdown-file> --target <target> --dialect <dialect> --profile <profile> --sync-whiteboards --format json
"$FMS" publish <markdown-file> --target <target> --dialect <dialect> --profile <profile> --sync-whiteboards --format json
```

A remotely changed Whiteboard must stop the workflow until the user approves the exact normalized PNG asset key. Never substitute a broad confirmation for asset-specific review.

During a confirmed Whiteboard update, the CLI may retry Feishu's structured `providerCode=4003101` document-applying error with the same idempotency token. The Lark CLI adapter preserves this upstream code separately from the process exit code. Post-update readback may also retry the structured `whiteboard_raw_not_ready` subtype when a successful query envelope arrives before raw nodes are populated, including an explicitly empty `nodes` array or empty top-level raw array. Ordinary status/query calls do not retry it. A missing or non-array `nodes` field, invalid embedded JSON, and other malformed raw data are not treated as transient. Retries are bounded. Any other provider code, message-only error, malformed result, or retry exhaustion is a partial-write stop; do not assume pending deletes ran and do not retry by adding new confirmation flags.

Tracked `zdoc-authoring` Whiteboard protection is not content synchronization. Without `--sync-whiteboards`, inspect the Whiteboard plan for `preserve tracked whiteboard`; require the receipt SVG path, normalized PNG asset key, block ID, token, and canonical placement to match. This protection may allow surrounding scoped text or structure writes, but it never grants board overwrite authority. A changed direct SVG, missing receipt, or identity mismatch blocks. To update a tracked direct SVG, require both explicit `--sync-whiteboards` intent and `--confirm-remote-whiteboard-overwrite <exact-asset-key>` after review.

After a Whiteboard write, preserve the opt-in during final Whiteboard-aware status verification:

```bash
"$FMS" status <markdown-file> --target <target> --dialect <dialect> --profile <profile> --sync-whiteboards --format json
```

## Pull Remote Content

Pull to an independent snapshot unless the user explicitly requested an overwrite:

```bash
"$FMS" pull --target <target> --output <remote-snapshot.md> --profile <profile> --format json
```

Do not replace canonical local Markdown by default. Use `--overwrite` only for an output path the user has approved. A pull receipt is independent of the publish receipt.

Inspect pull `warnings` for Callout compatibility normalization. A paragraph-wrapped Feishu Callout export may be normalized when its title and body boundaries are structurally unambiguous. For an unrecognized custom title, the CLI may use native Docx Callout metadata; if neither the configured title nor block metadata identifies the type, keep the failure closed and do not invent a note or warning type.

Pull reconstructs native nested list child paragraphs from the Docx block tree instead of trusting the official Markdown renderer for that hierarchy. If pull reports that the native tree cannot be uniquely matched to the fetched Markdown, stop and review the remote structure; do not copy the lossy snapshot over canonical source or bypass the blocker.

## Merge Remote Changes

Automatic merge is available only for `gfm`. Zdoc and Milvus authoring sources contain source-only syntax that Feishu cannot reconstruct completely; for `zdoc-authoring` and `milvus-authoring`, pull an independent snapshot and reconcile the canonical source manually.

Check before writing the local file:

```bash
"$FMS" merge <markdown-file> --target <target> --dialect <dialect> --profile <profile> --check --format json
```

If the user requested a merge and the check is safe, run the same merge without `--check`. Treat a conflict result as a valid stop state: report the local conflict markers and do not publish. Use `merge --abort` only when the user asks to restore the pre-merge file.

## Handle Machine Errors

With `--format json`, failures are one JSON object on stderr:

```json
{
  "ok": false,
  "error": {
    "type": "confirmation_required",
    "subtype": "collaboration_risk",
    "message": "...",
    "hint": "...",
    "requiredFlags": ["--confirm-collaboration-risk"],
    "retryable": false
  }
}
```

Branch on exit code plus `error.type`, `error.subtype`, `retryable`, and declared extension fields. Never branch on human-readable `message` text.

- Exit `2`: fix validation or arguments.
- Exit `3`: route authentication, authorization, or configuration through `$lark-shared`.
- Exit `4`: retry only when `retryable` is true.
- Exit `5`: inspect verification or internal failure; do not claim success.
- Exit `10`: present the risk and wait for explicit approval. Never automatically retry with `requiredFlags`.
- Exit `1` with a complete stdout result: handle a blocked plan or merge conflict as a domain outcome.

For `verification/partial_write`, inspect `partialWrite.completedOperations`, `failedOperation`, `pendingOperations`, the structured underlying `cause`, and the recovery-checkpoint fields. Never retry the failed write automatically. When `recoveryCheckpointWritten` is true, rerun status, diff, and publish dry-run against `recoveryCheckpointRevision`; the receipt preserves the original local delta baseline while advancing only the verified remote prefix. Treat `recoveryCheckpointRevision` as meaningful only when `recoveryCheckpointWritten=true`; an older receipt revision is not a recovery checkpoint. When no checkpoint exists, keep the workflow stopped and use explicit local-only baseline repair only after proving that every remote change belongs to the failed command. A recovered remainder still requires fresh review and every normal confirmation gate.

## Verify Completion

After every remote write, run:

```bash
"$FMS" status <markdown-file> --target <target> --dialect <dialect> --profile <profile> --format json
```

Use the returned document target after `--create`, and preserve `--sync-whiteboards` after a Whiteboard write. Report success only when the write passed readback verification and the final status matches the intended synchronized state. Explain any residual state, warnings, or unrelated remote changes. When rendered document structure changed, ask the user to inspect the Feishu document visually.

For `zdoc-authoring`, readback verification must also confirm the canonical Procedures boundaries, the recorded Supademo block IDs and shapes, and native Admonition Callout titles. Manual block surgery outside the CLI leaves the remote untracked until an explicit CLI adoption writes a receipt.
