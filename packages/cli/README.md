# feishu-md-sync

Standalone TypeScript CLI for syncing one local Markdown file to one existing Feishu docx document.

The command defaults to dry-run. A write requires `--write` plus either confirmation or `--yes`.

## Workflow-First Usage

Start from workflow recipes instead of memorizing command combinations:

```bash
npm exec -- md2feishu workflow list
npm exec -- md2feishu workflow show baseline-sync
npm exec -- md2feishu workflow show reviewed-section-sync
npm exec -- md2feishu workflow show multisdk-examples
npm exec -- md2feishu workflow show sdk-reference-authoring
npm exec -- md2feishu workflow show sdk-reference-web-content-release
npm exec -- md2feishu workflow show release-notes
```

SDK reference authoring stops after Feishu write and audit. Moving audited reference docs into `web-content` is a separate human-triggered release workflow.

## Codex Skill Setup

For team usage, install the workflow skills and let Codex call the CLI recipes:

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

The skills live in `skills/<skill-name>/SKILL.md` and map one-to-one to first-class workflows. Team members can ask Codex to use `feishu-reviewed-section-sync`, `feishu-sdk-reference-authoring`, or another workflow skill without memorizing CLI commands.

Use `scripts/install-codex-skills.sh --remove-legacy` only when migrating a machine that previously installed the old alias skills.

## Documentation

Local docs:

```bash
npm run docs:dev
```

Build docs:

```bash
npm run docs:build
```

The documentation site lives in `apps/docs/` and includes:

- CLI quickstart and conflict workflows
- Shared workflow recipes
- Agent Guide for non-interactive use
- Command and strategy reference
- Maintainer architecture notes

## Usage

From the repository root, the command works without a global install by using `npm exec`:

```bash
npm install
npm run build
npm exec -- md2feishu ./doc.md https://example.feishu.cn/docx/DocToken
npm exec -- md2feishu ./doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
npm exec -- md2feishu ./doc.md DocToken --write --yes
npm exec -- md2feishu status ./doc.md DocToken
npm exec -- md2feishu diff ./doc.md DocToken
npm exec -- md2feishu pull DocToken --output feishu.remote.md
npm exec -- md2feishu merge ./doc.md DocToken
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
npm exec -- md2feishu sync ./doc.md DocToken --section "Index type overview" --write --yes
npm exec -- md2feishu doctor auth --format json
```

To use `md2feishu` directly from any directory while developing this workspace, link the CLI package after building it:

```bash
cd packages/cli
npm link
md2feishu --help
```

Required environment variables for real Feishu calls:

```bash
APP_ID=...
APP_SECRET=...
FEISHU_HOST=https://open.feishu.cn
```

The CLI checks `.env` in the current directory and in the workspace checkout when detectable. Use `md2feishu --env-file /path/to/.env ...` to choose a credentials file explicitly.

Receipts are written only after successful writes under `.sync/feishu/`, which is ignored by git.

## Milvus / Zilliz Cloud Publishing

For Milvus docs that are published to Feishu before being shared with Zilliz Cloud, use the Milvus publish profile:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --publish-profile milvus
npm exec -- md2feishu diff ./doc.md DocToken --publish-profile milvus
npm exec -- md2feishu sync ./doc.md DocToken --publish-profile milvus --write --yes
```

The profile removes frontmatter, drops a duplicate first H1 that matches the frontmatter title, rewrites standalone `Milvus` product names to Milvus/Zilliz include tags, and wraps versioned names such as `Milvus 3.0` in Milvus-only include tags.

## Commands

```bash
# Backward-compatible shorthand for `sync`
npm exec -- md2feishu ./doc.md DocToken

# Explicit sync command
npm exec -- md2feishu sync ./doc.md DocToken
npm exec -- md2feishu sync ./doc.md DocToken --write --yes
npm exec -- md2feishu sync ./doc.md DocToken --section "Heading text"

# Inspect local/remote state without writing
npm exec -- md2feishu status ./doc.md DocToken

# Compare local Markdown to a best-effort Markdown export of Feishu
npm exec -- md2feishu diff ./doc.md DocToken

# Export current Feishu content as best-effort Markdown
npm exec -- md2feishu pull DocToken --output feishu.remote.md

# Merge local changes with current Feishu content into ./doc.merged.md
npm exec -- md2feishu merge ./doc.md DocToken
npm exec -- md2feishu merge ./doc.md DocToken --output ./doc.merged.md
```

## Conflict behavior

`md2feishu` is fail-closed. If the Feishu document changed since the last successful receipt, writes are refused by default and nothing is written.

Use these commands to inspect and resolve the conflict manually:

```bash
npm exec -- md2feishu status ./doc.md DocToken
npm exec -- md2feishu diff ./doc.md DocToken
npm exec -- md2feishu merge ./doc.md DocToken
npm exec -- md2feishu pull DocToken --output feishu.remote.md
```

For the normal merge workflow, generate one merged file:

```bash
npm exec -- md2feishu merge ./doc.md DocToken
```

If the merge is clean, the command writes `./doc.merged.md` and prints the sync command to publish it. If the merge has conflicts, resolve the conflict markers directly inside `./doc.merged.md`:

```markdown
<<<<<<< LOCAL
local version
||||||| BASE
last synced base version
=======
feishu version
>>>>>>> FEISHU
```

Then publish the resolved merged file:

```bash
npm exec -- md2feishu sync ./doc.merged.md DocToken --write --yes --strategy local-wins
```

When `./doc.merged.md` was generated from `./doc.md`, the sync command reuses the original `./doc.md` receipt. After Feishu write verification succeeds, it also updates `./doc.md` to the resolved merged content so the next sync starts from the new baseline.

For unattended safe sync, use the merge strategy:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

This writes to Feishu only when the three-way merge is conflict-free. If conflicts remain, it writes `./doc.merged.md`, refuses the Feishu write, and exits non-zero.

To intentionally overwrite Feishu with the local Markdown, pass an explicit strategy:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --strategy local-wins --yes
```

The first write to a non-empty existing Feishu document also requires:

```bash
--force-initial-overwrite
```

This protects the common dangerous case: the remote document already has content, but no local receipt exists yet.

If a matching active `multisdk` task exists under `runs/`, whole-document `sync --write` is also refused unless `--force-whole-document-sync` is provided. Prefer `md2feishu multisdk diff` and `md2feishu multisdk apply` for language-scoped code-block changes.

## Section-level sync

Use section-level sync when a reviewed Feishu document should receive only one local Markdown heading section:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --section "Index type overview"
npm exec -- md2feishu sync ./doc.md DocToken --section "Index type overview" --write --yes
```

The section title must match exactly after whitespace normalization. The CLI replaces the matching heading block and its section body, ending before the next same-level or higher-level heading. Blocks outside that section remain unchanged in Feishu.

Section writes use the current Feishu document as the base and do not update the whole-document receipt. This keeps later whole-document `status` checks honest when local Markdown and Feishu still differ outside the synced section.

Section sync fails before writing if the heading is missing, duplicated locally or remotely, or the generated replacement section contains unsupported Feishu block data such as local-only link URLs.

After a language lane has been written, reviewed, and audited in Feishu, use `multisdk land-docs` to patch only that language's reviewed code blocks into a downstream docs repo:

```bash
npm exec -- md2feishu multisdk land-docs runs/<doc-token> \
  --language java \
  --repo ~/milvus-docs \
  --target site/en/userGuide/schema/nullable-and-default.md \
  --base upstream/v3.0.x
```

The command defaults to dry-run. With `--write`, it saves the reviewed Feishu pull under `inputs/feishu.reviewed-baseline.md`, updates the target Markdown file, verifies block equality, and refuses base-named branches such as `v3.0.x` when `--base upstream/v3.0.x` is supplied.

## Three-way merge

Receipts store local and best-effort remote Markdown snapshots to support three-way merge:

- base: last successful local Markdown snapshot
- local: current local Markdown
- remote: current Feishu document exported to Markdown

The merge is deterministic and line-based. It does not use AI or semantic Markdown rewriting.

## V1 Scope

- One local Markdown file to one existing Feishu docx document.
- Dry-run-first behavior.
- Conflict detection from the last receipt.
- Smart patch planning with no-op detection and replace-all fallback.
- Read-only `status`, `diff`, `pull`, and `merge` commands for conflict diagnosis and resolution.
- Safe `--strategy merge` for conflict-free three-way sync.
- Markdown support for headings, paragraphs, unordered and ordered lists, tables, fenced code blocks, links, inline code, bold text, and `==highlight==` markers.

This project is independent from `sdk-doc-sync`; that repo was used only as reference material for Feishu API and block-shape conventions.
