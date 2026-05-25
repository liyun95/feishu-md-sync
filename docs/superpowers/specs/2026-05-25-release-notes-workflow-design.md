# Release Notes Workflow Design

Date: 2026-05-25

## Context

Milvus release documentation updates currently require a manual chain of work:

- Pull release notes text from a Feishu document.
- Check the target release line, such as `2.6.x` or `3.0.x`.
- Scan SDK source tags to determine the correct SDK versions for that release line.
- Compare those SDK versions with `site/en/Variables.json`.
- Insert or update the matching section in `site/en/release_notes.md`.
- Pull or sync any newly documented user-guide content from Feishu.
- Add links from release note bullets to the relevant user-guide sections.
- Validate the Markdown and JSON changes before review.

The first release workflow should make this process durable and auditable without making automatic writes the default. The operator should get a concrete report first, review it, approve it, and only then choose whether to apply file changes.

## Goals

- Add a release workflow that is task-based, resumable, and reviewable.
- Pull Feishu release notes into a task snapshot.
- Scan SDK source tags for the target release line and write a version matrix.
- Audit `site/en/Variables.json` against the scanned SDK versions.
- Audit `site/en/release_notes.md` for the target version section and proposed insertion point.
- Audit release-note feature bullets for user-documentation links.
- Verify linked local user docs and heading anchors exist.
- Require explicit approval before `apply --write` can modify the Milvus docs repo.
- Generate compact `report.md` and structured `report.json` outputs for review.

## Non-Goals

- The first version does not publish to Feishu or GitHub.
- The first version does not commit or push Milvus docs changes.
- The first version does not infer technical wording for release-note bullets from SDK source.
- The first version does not automatically create missing user-guide documents.
- The first version does not replace the existing `pull`, `sync`, `code-blocks`, or `multisdk` commands.
- The first version does not manage SDK reference publishing or Bitable release audit tables.

## CLI and Skill Boundary

The release workflow should ship as both a CLI command group and an agent Skill.

The CLI is the deterministic engine. It owns durable task state, Feishu pulls, SDK tag scans, audits, approval hash checks, dry-run diffs, and gated local file writes. Anything that needs repeatability, test coverage, or file-system safety belongs in the CLI.

The Skill is the operator playbook. It tells the agent when to use the release workflow, how to collect inputs from the user, which commands to run in what order, how to interpret the report, when to stop for user approval, and how to combine this workflow with existing Feishu Markdown sync or code-block workflows.

This keeps the Skill concise and stable: it should not reimplement SDK tag scanning, Markdown diffing, anchor detection, or approval logic in prose. It should call the CLI for those operations and use the generated report as the decision surface.

## Command Model

Add a new CLI group:

```bash
md2feishu release <command>
```

The V1 command surface is:

```bash
md2feishu release init \
  --release-line 2.6.x \
  --version 2.6.17 \
  --release-doc <feishu-doc-or-wiki-url> \
  --milvus-docs ~/milvus-docs \
  --out runs/releases/2.6.17

md2feishu release pull runs/releases/2.6.17
md2feishu release scan-sdk-tags runs/releases/2.6.17
md2feishu release audit runs/releases/2.6.17
md2feishu release approve runs/releases/2.6.17 --by <name>
md2feishu release apply runs/releases/2.6.17
md2feishu release apply runs/releases/2.6.17 --write
md2feishu release status runs/releases/2.6.17
```

`apply` defaults to dry-run. `apply --write` modifies local Milvus docs files only after the current report has been approved.

`init` may also accept repeated user-doc mappings and a link map:

```bash
md2feishu release init ... \
  --user-doc site/en/userGuide/insert-and-delete/upsert-entities.md=https://zilliverse.feishu.cn/wiki/example \
  --link-map release-links.json
```

`--user-doc` declares Feishu user-doc URLs that should be checked against local targets. `--link-map` is a JSON file that maps release-note keywords or bullet identifiers to local user-doc anchors. Inferred links are allowed in the report, but `apply --write` may only insert links that came from an explicit `--user-doc` or `--link-map` target and passed file and anchor validation.

## Task Directory

Each release gets one task directory:

```text
runs/releases/<version>/
  task.json
  feishu/
    release-notes.remote.md
  sdk/
    tags.json
    matrix.md
  audit/
    variables.diff.md
    release-notes.diff.md
    links.json
  report.json
  report.md
  approvals.json
  handoff.md
```

The task directory is an operator workspace. It is not committed by default unless the maintainer explicitly wants to preserve a release run.

## Task State

`task.json` is the source of truth for workflow state:

```json
{
  "kind": "feishu-release-task",
  "version": 1,
  "releaseLine": "2.6.x",
  "releaseVersion": "2.6.17",
  "releaseDoc": "https://zilliverse.feishu.cn/docx/example",
  "documentId": "doc-id",
  "milvusDocsPath": "/Users/liyun/milvus-docs",
  "taskDir": "runs/releases/2.6.17",
  "userDocs": [
    {
      "localPath": "site/en/userGuide/insert-and-delete/upsert-entities.md",
      "feishuDoc": "https://zilliverse.feishu.cn/wiki/example"
    }
  ],
  "linkMapPath": "release-links.json",
  "status": "initialized",
  "steps": {
    "pulledReleaseNotes": false,
    "scannedSdkTags": false,
    "audited": false,
    "approved": false,
    "dryRunPassed": false,
    "writePassed": false
  },
  "reportHash": null,
  "approval": null
}
```

Task statuses are:

- `initialized`: metadata exists, but no remote content has been pulled.
- `pulled`: release note Markdown snapshot exists.
- `scanned`: SDK tag matrix exists.
- `audited`: report files exist.
- `approved`: a user has approved the current report hash.
- `dry-run-passed`: apply dry-run produced a clean patch plan.
- `written`: local Milvus docs files were modified.
- `blocked`: manual intervention is required.

## SDK Tag Scanning

`scan-sdk-tags` records source-truth SDK versions for the release line. Published Milvus docs are not the source of truth for SDK version support.

The scanner writes `sdk/tags.json` and `sdk/matrix.md` with:

- SDK name.
- Source repository.
- Release-line selector.
- Matched tag or commit.
- Version value expected in `Variables.json`.
- Evidence URL or local command output summary.
- Result status.

The V1 source map is:

| SDK | Source |
| --- | --- |
| Python | `pymilvus` |
| Java | `milvus-io/milvus-sdk-java` |
| Node.js | `milvus-io/milvus-sdk-node` |
| Go | Milvus monorepo `client/` |
| REST/server | Milvus OpenAPI, server route, or server test source |

The scanner should prefer local checkouts when configured and fall back to remote Git metadata when available. If a source cannot be scanned, the SDK row is marked `blocked` with a reason; `audit` may still run, but the final report is not passable until blocked SDK rows are resolved or explicitly waived in the task.

## Audit Rules

`audit` reads the Feishu release-note snapshot, SDK matrix, and local Milvus docs repo. It writes `report.json`, `report.md`, and focused audit artifacts.

### Variables Audit

The variables audit compares SDK matrix values against `site/en/Variables.json`.

It reports:

- variables that already match the source tag matrix;
- variables that should change;
- variables that are expected for the release line but missing;
- variables that exist locally but have no source evidence in the matrix.

The audit does not write `Variables.json`.

### Release Notes Audit

The release notes audit checks `site/en/release_notes.md`.

It reports:

- whether the target version heading exists;
- where a new version section should be inserted;
- whether the Feishu snapshot has content that is missing locally;
- whether local release-note text differs from the Feishu snapshot;
- a proposed Markdown patch for the release section.

The audit treats the Feishu release-note document as the content source for the release section.

### Link Audit

The link audit checks release-note bullets that mention user-facing features or behavior changes.

It reports:

- bullets that already link to user docs;
- bullets that appear to need a user-doc link;
- configured or inferred local target paths;
- whether each linked file exists;
- whether each linked heading anchor exists.

The first version should not invent user-doc content. If a feature needs a doc page but no local target exists, the report marks it as an action item.

### Feishu User-Doc Sync Check

When the task includes user-doc URLs, `audit` verifies that each URL has a corresponding local target path and records whether the local file appears to contain the pulled content. Whole-document sync remains delegated to existing `pull` and `sync` primitives.

## Approval Gate

`approve` records that the user reviewed the current report:

```json
{
  "reportHash": "sha256:...",
  "approvedBy": "name",
  "approvedAt": "2026-05-25T00:00:00.000Z"
}
```

`apply --write` fails unless:

- `audit` has completed;
- `report.md` and `report.json` still match the approved `reportHash`;
- there are no unwaived blocking audit findings;
- `apply` dry-run has already passed for the current task state.

If any input changes after approval, the workflow requires a fresh `audit` and fresh `approve`.

## Apply Behavior

`apply` computes local file changes from the approved audit artifacts.

V1 write targets are limited to:

- `site/en/release_notes.md`
- `site/en/Variables.json`

Optional link insertion in `release_notes.md` is allowed only when the audit has a concrete existing local user-doc target and anchor.

`apply` must not write user-guide documents in V1. User-guide sync remains an explicit separate step through the existing Feishu Markdown workflow.

`apply` writes no files without `--write`. The dry-run output includes the files that would change and the proposed diffs.

## Safety Rules

- Default commands are read-only except for task artifacts under the task directory.
- Local Milvus docs writes require `apply --write`.
- `apply --write` requires approval of the current report hash.
- `apply --write` requires a successful dry-run after the current approval.
- The workflow never commits, pushes, or opens a pull request.
- The workflow never treats published Milvus docs as SDK source truth.
- The workflow never fabricates SDK examples, user docs, or links without local targets.
- Existing local changes in the Milvus docs repo are detected and reported before write.

## Error Handling

Commands should fail with a phase-specific message and a suggested next command.

Examples:

- Missing Feishu credentials: tell the user to configure `APP_ID` and `APP_SECRET`.
- SDK source unavailable: mark the SDK row blocked and tell the user which source failed.
- Missing `Variables.json`: block variables audit and verify the `--milvus-docs` path.
- Missing release note insertion point: block release notes audit and ask for manual target section selection.
- Report hash mismatch: refuse `apply --write` and require `release audit` plus `release approve`.

Failures should update `task.json` to `blocked` only when they prevent meaningful progress. Recoverable warnings should stay in `report.json`.

## Testing

Unit tests should cover:

- task creation, loading, saving, and status summaries;
- report hash creation and approval validation;
- SDK tag matrix parsing from mocked source metadata;
- `Variables.json` diff generation;
- release-note insertion point detection;
- user-doc link and anchor detection;
- apply gating when approval or dry-run is missing;
- dry-run diff generation for `release_notes.md` and `Variables.json`.

Integration tests should use fixture Milvus docs directories and fake Feishu clients. Live Feishu testing remains manual and should use disposable task directories.

## Documentation

Update the docs site with:

- a release workflow guide;
- command reference entries for `release`;
- an agent skill page describing when to use this workflow;
- safety notes explaining that SDK source scanning feeds `Variables.json` audit.

## Skill Packaging

Add a dedicated Skill, tentatively named `milvus-release-notes-workflow`.

The Skill should trigger when the user asks to update Milvus release notes, update release variables, pull release-note content from Feishu, prepare a Milvus release docs PR, or check SDK versions for a release line.

The Skill body should stay small and include:

- required inputs: release line, release version, Feishu release-note URL, Milvus docs path, optional user-doc mappings, optional link map;
- command sequence: `release init`, `release pull`, `release scan-sdk-tags`, `release audit`, user review, `release approve`, dry-run `release apply`, optional `release apply --write`;
- stop points: pause after `audit` for user review, and pause before any `apply --write`;
- source-of-truth rules: Feishu is source for release-note text, SDK repos/tags are source for SDK versions, user-doc Feishu pages are source for user-guide content;
- composition rules: use existing Feishu Markdown sync for user-doc content updates, and existing code-block workflows for Feishu code-block edits.

The Skill may include a short reference file with example command invocations for `2.6.x` and `3.0.x`, but it should not duplicate the full CLI command reference.

## Rollout

Phase 1 adds the task model, `init`, `status`, approval hashing, and report rendering.

Phase 2 adds Feishu release-note pull and SDK tag scanning.

Phase 3 adds variables, release notes, and link audits.

Phase 4 adds dry-run apply and gated `apply --write` for `release_notes.md` and `Variables.json`.

Phase 5 adds the `milvus-release-notes-workflow` Skill and docs-site Skill page.

Phase 6 dogfoods the workflow on the next Milvus release update and adjusts audit rules based on real review feedback.
