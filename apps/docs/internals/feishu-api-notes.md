# Feishu API Notes

These notes capture implementation details that matter for maintainers.

## Document Blocks

The client reads document blocks and identifies the page block before comparing or replacing direct children.

## Smart Patch

The current patch planner uses no-op detection, named-section replacement, contiguous block replacement for small explainable edits, and whole-document replacement as the conservative fallback. After write, it reads the document again and verifies the resulting hash.

## Hashing

Hashing normalizes Feishu block state so equivalent formatting noise does not create false remote-change conflicts.

Examples:

- default wrap style fields are ignored
- adjacent equivalent text runs are merged
- table `merge_info` is ignored for hashes

## Feishu To Markdown Export

Pull, diff, and merge depend on best-effort export from Feishu blocks to Markdown. Unsupported block types are omitted with an HTML comment.

## Official Markdown API Smoke Checklist

- Export a reviewed doc with `--markdown-engine official`.
- Compare against local block export with `md2feishu diff`.
- Confirm code fences retain language labels for Python, Java, JavaScript, Go, and REST.
- Confirm tables are usable for docs authoring.
- Confirm images either round-trip or produce an explicit warning.
- Convert the same Markdown through official block convert and local convert.
- Dry-run section sync with official import blocks.
- Write only to a disposable Feishu doc before treating official output as proven for a new document family.

## Auth And Errors

The token layer reports Feishu auth errors. The client reports malformed JSON, API errors, and rate-limit failures with explicit error messages.
