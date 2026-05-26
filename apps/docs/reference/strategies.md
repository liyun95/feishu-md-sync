# Sync Strategies

## `fail`

Default strategy.

If Feishu changed since the last successful receipt, sync refuses to write.

## `local-wins`

Explicit overwrite strategy.

Use only when the local Markdown should replace the current Feishu document, or when publishing a resolved `.merged.md`.

## `merge`

Safe automated merge strategy.

If Feishu changed:

- clean merge: update Feishu and local Markdown after verification
- conflicted merge: write `.merged.md`, refuse Feishu write, exit non-zero

`merge` requires a previous receipt with a source snapshot.
