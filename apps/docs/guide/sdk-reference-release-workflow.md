# SDK Reference Release Workflow

Use this workflow when an SDK reference update needs to move from source diff to Feishu docs, Feishu Bitable tracking, `web-content` export, and PR handoff.

## Repository Boundary

`feishu-md-sync` owns the workflow and CLI contract. It defines the release config, Feishu publish manifest, audit rules, external export command, and PR handoff report.

`web-content` remains an external publication repository because it is the production content source, not a package in this npm workspace. Do not add it as `packages/web-content` or include it in the root `workspaces` list.

## Config

Create a workflow config for each release batch:

```json
{
  "kind": "sdk-reference-release-workflow",
  "sdk": "java",
  "versionRange": "v2.6.19 -> v3.0.0",
  "manifest": "reference-manifest.json",
  "reportsDir": "reports",
  "webContent": {
    "repo": "/Users/liyun/web-content",
    "config": "scripts/config.json",
    "manual": "java-v2.6.x",
    "mode": "pull",
    "doc": "describeCollection()"
  },
  "pr": {
    "base": "master",
    "branch": "docs/java-v2.6.19-reference",
    "title": "Update Java SDK reference for v2.6.19"
  }
}
```

`webContent.repo` must point to an external checkout. Relative paths are resolved from the config file location, but they should still identify a repo outside this monorepo.

## Phases

1. Build or review the source impact matrix from the official SDK repository tag diff.
2. Convert the impact matrix into a Feishu publish manifest.
3. Dry-run Feishu apply.
4. Write Feishu changes after review.
5. Audit Feishu readback.
6. Wait for Feishu content to be ready for export.
7. Pull into the external `web-content` checkout.
8. Review the `web-content` git diff.
9. Prepare the PR body and command.

## Commands

Generate a manifest from an approved impact matrix:

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
```

Dry-run and then write Feishu changes:

```bash
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
```

Check the external publication repo before pulling Feishu content:

```bash
md2feishu reference web-content check --repo /Users/liyun/web-content --manual java-v2.6.x --format json
```

After Feishu sync is ready, pull one document or the whole manual:

```bash
md2feishu reference web-content pull --repo /Users/liyun/web-content --manual java-v2.6.x --doc "describeCollection()" --format json
md2feishu reference web-content pull --repo /Users/liyun/web-content --manual java-v2.6.x --all --format json
```

Run the workflow orchestrator from the config file:

```bash
md2feishu reference release run --config reference-release.json --format json
md2feishu reference release run --config reference-release.json --write --format json
md2feishu reference release run --config reference-release.json --write --pull-web-content --format json
```

## Safety Rules

- Do not put `web-content` under `packages/`.
- Do not write the SDK reference Bitable `Slug` field.
- Run Feishu apply without `--write` before any write.
- Run Feishu audit before pulling into `web-content`.
- Review the external `web-content` diff before creating a PR.

## PR Handoff

The release workflow prepares the PR branch, body, risks, and command for the external publication repo. Review the generated report and the `web-content` git diff before running the PR command or enabling PR creation.
