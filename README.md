# feishu-md-sync

Standalone TypeScript CLI for syncing one local Markdown file to one existing Feishu docx document.

The command defaults to dry-run. A write requires `--write` plus either confirmation or `--yes`.

## Documentation

Local docs:

```bash
npm run docs:dev
```

Build docs:

```bash
npm run docs:build
```

The documentation site lives in `docs-site/` and includes:

- CLI quickstart and conflict workflows
- Agent Guide for non-interactive use
- Command and strategy reference
- Maintainer architecture notes

## Usage

```bash
npm install
npm run build
md2feishu ./doc.md https://example.feishu.cn/docx/DocToken
md2feishu ./doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
md2feishu ./doc.md DocToken --write --yes
md2feishu status ./doc.md DocToken
md2feishu diff ./doc.md DocToken
md2feishu pull DocToken --output feishu.remote.md
md2feishu merge ./doc.md DocToken
md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

Required environment variables for real Feishu calls:

```bash
APP_ID=...
APP_SECRET=...
FEISHU_HOST=https://open.feishu.cn
```

Receipts are written only after successful writes under `.sync/feishu/`, which is ignored by git.

## Commands

```bash
# Backward-compatible shorthand for `sync`
md2feishu ./doc.md DocToken

# Explicit sync command
md2feishu sync ./doc.md DocToken
md2feishu sync ./doc.md DocToken --write --yes

# Inspect local/remote state without writing
md2feishu status ./doc.md DocToken

# Compare local Markdown to a best-effort Markdown export of Feishu
md2feishu diff ./doc.md DocToken

# Export current Feishu content as best-effort Markdown
md2feishu pull DocToken --output feishu.remote.md

# Merge local changes with current Feishu content into ./doc.merged.md
md2feishu merge ./doc.md DocToken
md2feishu merge ./doc.md DocToken --output ./doc.merged.md
```

## Conflict behavior

`md2feishu` is fail-closed. If the Feishu document changed since the last successful receipt, writes are refused by default and nothing is written.

Use these commands to inspect and resolve the conflict manually:

```bash
md2feishu status ./doc.md DocToken
md2feishu diff ./doc.md DocToken
md2feishu merge ./doc.md DocToken
md2feishu pull DocToken --output feishu.remote.md
```

For the normal merge workflow, generate one merged file:

```bash
md2feishu merge ./doc.md DocToken
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
md2feishu sync ./doc.merged.md DocToken --write --yes --strategy local-wins
```

When `./doc.merged.md` was generated from `./doc.md`, the sync command reuses the original `./doc.md` receipt. After Feishu write verification succeeds, it also updates `./doc.md` to the resolved merged content so the next sync starts from the new baseline.

For unattended safe sync, use the merge strategy:

```bash
md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

This writes to Feishu only when the three-way merge is conflict-free. If conflicts remain, it writes `./doc.merged.md`, refuses the Feishu write, and exits non-zero.

To intentionally overwrite Feishu with the local Markdown, pass an explicit strategy:

```bash
md2feishu sync ./doc.md DocToken --write --strategy local-wins --yes
```

The first write to a non-empty existing Feishu document also requires:

```bash
--force-initial-overwrite
```

This protects the common dangerous case: the remote document already has content, but no local receipt exists yet.

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
