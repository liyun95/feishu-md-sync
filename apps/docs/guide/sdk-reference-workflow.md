# SDK Reference Workflow

Use `reference` when an SDK release changes API reference content that must be published to Feishu Drive, tracked in Bitable/Base, and then exported into `web-content` for a site PR.

This workflow has two publish stages:

1. Feishu stage: update SDK reference docs and tracking records.
2. Web content stage: export the audited Feishu docs into a fork checkout and review the Markdown diff.

The CLI does not stage, commit, push, or open pull requests.

## Prerequisites

- A local checkout of the official SDK repository, such as `~/sdk-doc-sync/repos/milvus-sdk-java`.
- A local checkout or worktree of `milvus-io/web-content` that pushes to a fork.
- Feishu app credentials with access to the SDK reference docs, SDK reference Bitable, and release audit Base.
- A `web-content/scripts/config.json` entry for the target manual, such as `java-v3.0.x`.

On macOS, use a case-sensitive `web-content` checkout or worktree. The `web-content` repository can contain paths that differ only by case, and a case-insensitive filesystem can make generated SDK reference diffs unreliable. `reference export` fails closed when it detects that risk.

## Done Definition

SDK reference work is complete when:

- source changes are checked against the official SDK tags;
- Feishu write has been dry-run and then applied only after review;
- `reference audit` passes;
- `reference export` produces a reviewed `web-content` diff;
- a fork PR is created when site content changed.

## 1. Check Source Freshness

Run preflight before trusting a previous scan-state or accepting a no-action result.

```bash
md2feishu reference preflight \
  --sdk java \
  --repo ~/sdk-doc-sync/repos/milvus-sdk-java \
  --version-line v3.0.x \
  --scan-state ~/sdk-doc-sync/.claude/skills/sdk-doc-sync/scan-state.json \
  --source-path sdk-core/src/main/java \
  --format json
```

The command fetches tags unless `--skip-fetch` is set, finds the latest tag matching the version line, and reports changed source paths between the baseline tag and latest tag.

Use `--fail-on-stale` in automation when a newer tag should block the run.

## 2. Create Impact Matrix

The impact matrix is the reviewed decision record for what changed and what should happen to reference docs.

```json
{
  "kind": "sdk-reference-impact-matrix",
  "sdk": "java",
  "versionRange": "v3.0.0 -> v3.0.1",
  "source": {
    "sdk": "java",
    "repository": "https://github.com/milvus-io/milvus-sdk-java",
    "versionLine": "v3.0.x",
    "baselineTag": "v3.0.0",
    "latestTag": "v3.0.1",
    "diffRange": "v3.0.0..v3.0.1",
    "changedPaths": [
      "sdk-core/src/main/java/io/milvus/v2/service/collection/CollectionService.java"
    ]
  },
  "targets": {
    "driveRootFolderToken": "folder-token",
    "sdkReferenceBitableToken": "sdk-reference-base-token",
    "releaseAuditBaseToken": "release-audit-base-token",
    "releaseAuditTableName": "Java SDK v3.0.x"
  },
  "items": [
    {
      "id": "update-add-collection-field",
      "action": "UPDATE",
      "title": "addCollectionField()",
      "markdownFile": "reference/java/addCollectionField.md",
      "documentId": "doc-token",
      "recordId": "record-id",
      "evidence": "v3.0.1 requires added vector fields to set isNullable(true)."
    }
  ]
}
```

Action meanings:

- `CREATE`: create a new Feishu doc from `markdownFile`.
- `UPDATE`: replace an existing Feishu doc with `markdownFile`.
- `DEPRECATE`: mark an existing reference record as deprecated.
- `NO ACTION`: record that source was checked and no reference change is needed.

`NO ACTION` matrices must include source freshness evidence. If `latestTag` differs from `baselineTag`, include `diffRange` or `changedPaths`, plus item-level evidence explaining why no doc update is needed.

Tracker rows require `targets.releaseAuditBaseToken`. The CLI can create rows in an existing shared Base, but it does not create a new Base.

## 3. Plan Feishu Changes

Convert the impact matrix into a manifest.

```bash
md2feishu reference plan \
  --impact impact.json \
  --out reference-manifest.json \
  --format json
```

Review the manifest before writing. The manifest must not write the SDK reference Bitable `Slug` field.

## 4. Apply And Audit Feishu

Run a dry-run first:

```bash
md2feishu reference apply \
  --manifest reference-manifest.json \
  --format json
```

After review, write to Feishu:

```bash
md2feishu reference apply \
  --manifest reference-manifest.json \
  --write -y \
  --format json
```

Then read back the published resources:

```bash
md2feishu reference audit \
  --manifest reference-manifest.json \
  --format json
```

Do not continue to `web-content` export until the audit passes.

## 5. Export To Web Content

Export the audited Feishu docs into a `web-content` checkout.

```bash
md2feishu reference export \
  --manifest reference-manifest.json \
  --web-content-repo /Volumes/web-content-cs/web-content-java-v30 \
  --manual java-v3.0.x \
  --config scripts/config.json \
  --scope changed \
  --skip-image-down \
  --out runs/reference/java-v3.0.x/web-content-export.json \
  --format json
```

`reference export` wraps `web-content/scripts/lark-docs/index.js`.

- `--scope changed` exports only changed manifest doc actions by title.
- `--scope all` rebuilds the full manual.
- `--skip-image-down` is the default for SDK reference updates unless the reference page changed images.
- `--out` writes a handoff report with commands run, source Base, output directory, changed files, untracked files, unrelated dirty files, and suggested staging paths.

Review the report before staging. Generated files under the target output directory are not always relevant; stage only the files that belong to the source change.

## 6. Create The Fork PR

The CLI stops before git publishing. After reviewing the export diff, use the fork workflow for `web-content`:

```bash
git status --short
git diff -- API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md
git add API_Reference/milvus-sdk-java/v3.0.x/v2/Collections/addCollectionField.md
git commit -m "Update Java v3.0.x addCollectionField reference"
git push origin java-v30-reference-publish
gh pr create --repo milvus-io/web-content --base master --head liyun95:java-v30-reference-publish
```

Never push SDK reference updates directly to `upstream`.
