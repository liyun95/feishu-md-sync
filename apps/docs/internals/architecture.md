# Architecture

`md2feishu` is a TypeScript CLI with focused modules.

## CLI Layer

File:

```text
packages/cli/src/cli/index.ts
```

Responsibilities:

- parse commands and options
- resolve docx or wiki targets
- print user-facing output
- route to sync, status, pull, diff, and merge operations

## Feishu Client

Files:

```text
packages/cli/src/feishu/client.ts
packages/cli/src/feishu/token.ts
packages/cli/src/feishu/types.ts
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
packages/cli/src/markdown/blocks.ts
packages/cli/src/markdown/from-blocks.ts
```

Responsibilities:

- convert Markdown to Feishu block payloads
- export supported Feishu blocks back to best-effort Markdown

## Sync Core

Files:

```text
packages/cli/src/sync/run-sync.ts
packages/cli/src/sync/conflict.ts
packages/cli/src/sync/patch.ts
packages/cli/src/sync/status.ts
packages/cli/src/sync/diff.ts
packages/cli/src/sync/pull.ts
packages/cli/src/sync/merge.ts
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
packages/cli/src/receipts/receipt.ts
```

Receipts are the safety boundary between local Markdown and current Feishu state.
