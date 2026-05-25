# Architecture

`md2feishu` is a TypeScript CLI with focused modules.

## CLI Layer

File:

```text
src/cli/index.ts
```

Responsibilities:

- parse commands and options
- resolve docx or wiki targets
- print user-facing output
- route to sync, code-block, multi-SDK, SDK reference, and release workflows

## Feishu Client

Files:

```text
src/feishu/client.ts
src/feishu/token.ts
src/feishu/types.ts
```

Responsibilities:

- authenticate with Feishu
- read document blocks
- create and delete child blocks
- resolve wiki nodes
- retry rate-limited requests where supported

## Markdown Conversion

Files:

```text
src/markdown/blocks.ts
src/markdown/from-blocks.ts
```

Responsibilities:

- convert Markdown to Feishu block payloads
- export supported Feishu blocks back to best-effort Markdown

## Sync Core

Files:

```text
src/sync/run-sync.ts
src/sync/conflict.ts
src/sync/patch.ts
src/sync/status.ts
src/sync/diff.ts
src/sync/pull.ts
src/sync/merge.ts
```

Responsibilities:

- detect remote changes from receipts
- plan patch operations
- apply and verify writes
- generate status and diff output
- create `.merged.md` files
- run safe merge strategy writes

## Receipts

File:

```text
src/receipts/receipt.ts
```

Receipts are the safety boundary between local Markdown and current Feishu state.

## Code Block Workflows

Files:

```text
src/sync/code-block-*.ts
src/multisdk/*.ts
```

Responsibilities:

- inspect Feishu code blocks and build inventories
- export snippets to local files
- plan mixed update/insert manifests
- require language verification evidence for multi-SDK writes
- audit language order, missing snippets, and placeholders

## SDK Reference Workflow

Files:

```text
src/reference/plan.ts
src/reference/apply.ts
src/reference/audit.ts
src/reference/freshness.ts
src/reference/export.ts
src/reference/manifest.ts
```

Responsibilities:

- check SDK source freshness against official release-line tags
- convert reviewed impact matrices into Feishu publish manifests
- apply SDK reference doc and Bitable/Base changes through explicit manifests
- audit published Drive docs, records, tracker schema, and links
- export audited Feishu docs into `web-content` and report the git handoff

`reference export` intentionally stops before git publishing. It reports suggested staging paths but does not stage, commit, push, or open pull requests.

## Release Workflow

Files:

```text
src/release/*.ts
```

Responsibilities:

- initialize resumable release-note task directories
- pull Feishu release-note source text
- scan SDK tags from official repositories
- audit Variables, release-note sections, and linked user-doc examples
- gate local docs writes on approval, dry-run state, and a passing report
