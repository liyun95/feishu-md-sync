# Agent Usage

`feishu-md-sync` ships a thin Agent Skill for workflows where local Markdown is the source of truth. The Skill calls the installed CLI, interprets its JSON plan, and enforces the same dry-run and confirmation gates a careful human operator would use.

## Install Matching Versions

Install the CLI and Skill from the same release:

```bash
npm install --global feishu-md-sync@0.4.0
npx skills add 'liyun95/feishu-md-sync#v0.4.0' \
  --skill feishu-md-sync \
  --global \
  --yes
```

The `v0.4.x` Skill requires `feishu-md-sync >=0.4.0 <0.5.0`. Stable users should install from a release tag, not `main`, because `main` may describe unreleased CLI behavior.

## Invoke The Skill

Use the Skill explicitly while dogfooding:

```text
Use $feishu-md-sync to synchronize ./doc.md with https://example.feishu.cn/docx/DocToken. Review the dry-run first and do not bypass any safety gate.
```

For a new document:

```text
Use $feishu-md-sync to create a Feishu document from ./doc.md under this Wiki parent. Show me the dry-run plan before writing.
```

An explicit request to publish, synchronize, or create authorizes a safe write after the dry-run. The Agent must stop again when the plan requires untracked-remote, collaboration-risk, Whiteboard-overwrite, or destructive-replacement confirmation.

## Workflow

For an existing document, the Skill runs:

```text
status -> diff -> publish dry-run -> decision -> optional write -> status
```

It never chooses `document-replace`, enables `--sync-whiteboards`, or appends a `--confirm-*` flag without the matching user intent and approval. Blocked plans and overlapping remote changes stop the write.

Pull writes an independent snapshot by default. Merge begins with `merge --check`, and a conflict stops before publish.

For a canonical Zdoc source whose Feishu document is read by a downstream publisher, use one consistent authoring dialect across status, diff, and publish:

```bash
feishu-md-sync status article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz --format json
feishu-md-sync diff article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz --format json
feishu-md-sync publish article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz --format json
```

Agents should first determine whether Feishu is a presentation target, an authoring archive, or a bidirectional collaboration source. For Zdoc authoring archives, use the canonical source rather than a hidden publish view and inspect `zdocRoundTrip`; `safeToPublish: false` stops the write. Verify Procedures boundaries, Supademo block identity, and native Admonition Callouts during readback.

Agents should also branch on `dialectBlockers`, `dialectDiagnostics`, and `linkResolution`. A dialect blocker means the source must be fixed; confirmation flags cannot bypass it. `linkResolution` identifies Feishu mappings, cache use, public-site fallbacks, and unresolved links without requiring the Agent to parse warning text.

Do not run automatic merge for `zdoc-authoring` or `milvus-authoring`. Pull a separate review snapshot and reconcile the canonical source manually.

## Routing With Official Lark Skills

- `$feishu-md-sync`: local Markdown status, diff, pull, merge, create, and publish.
- `$lark-doc`: ad hoc remote-only document reading or editing.
- `$lark-shared`: login, user/bot identity, missing scopes, app configuration, and permission repair.

The Skill does not store App credentials. Authentication and Feishu IO remain owned by the official `lark-cli`.

## Development Builds

Install the Skill from a local checkout to get a development copy:

```bash
npx skills add /path/to/feishu-md-sync \
  --skill feishu-md-sync \
  --global \
  --yes
```

The installer copies the Skill into the Agent's global Skill directory. Reinstall it after changing `skills/feishu-md-sync/`; edits in the worktree do not automatically update the installed copy.

Build the CLI, then point the Skill at the executable from one worktree:

```bash
npm run build
export FEISHU_MD_SYNC_BIN='/path/to/worktree/packages/cli/dist/cli/index.js'
```

`FEISHU_MD_SYNC_BIN` must be one absolute executable path, not a shell command. An unreleased build outside the published version range is accepted only when its help exposes every command and safety option required by the Skill. Without this explicit override, the Skill uses `feishu-md-sync` from `PATH` and enforces the stable version range.

## Upgrade

Upgrade the CLI and reinstall the Skill from the same new tag:

```bash
npm install --global feishu-md-sync@0.4.0
npx skills add 'liyun95/feishu-md-sync#v0.4.0' --skill feishu-md-sync --global --yes
```

Do not update the Skill independently to `main` while keeping an older npm CLI.
