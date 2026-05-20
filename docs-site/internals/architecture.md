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
- route to sync, status, pull, diff, and merge operations

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
