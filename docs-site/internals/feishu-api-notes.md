# Feishu API Notes

These notes capture implementation details that matter for maintainers.

## Document Blocks

The client reads document blocks and identifies the page block before comparing or replacing direct children.

## Smart Patch

The current patch implementation uses no-op detection and replace-all fallback. After write, it reads the document again and verifies the resulting hash.

## Hashing

Hashing normalizes Feishu block state so equivalent formatting noise does not create false remote-change conflicts.

Examples:

- default wrap style fields are ignored
- adjacent equivalent text runs are merged
- table `merge_info` is ignored for hashes

## Feishu To Markdown Export

Pull, diff, and merge depend on best-effort export from Feishu blocks to Markdown. Unsupported block types are omitted with an HTML comment.

## Auth And Errors

The token layer reports Feishu auth errors. The client reports malformed JSON, API errors, and rate-limit failures with explicit error messages.
