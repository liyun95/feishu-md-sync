# Markdown Support

`feishu-md-sync` supports a practical subset of Markdown through Feishu's official Markdown import/export and a small local conversion layer for block patch planning.

## Supported Blocks

- Headings `#` through `######`
- Paragraphs
- Unordered lists
- Ordered lists
- Fenced code blocks
- Tables
- Tables through Feishu Markdown import/export

## Supported Inline Formatting

- Links
- Inline code
- Bold text
- `==highlight==` markers

## Official Feishu Markdown Export

`pull`, `status`, `diff`, and `merge --target` use `lark-cli docs +fetch --doc-format markdown`.

`publish` uses `lark-cli docs +update/+create` for remote writes. In `auto`, it attempts a safe block patch when the document shape is supported, otherwise it falls back to a guarded `document-replace` plan.

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types may not round-trip through Markdown.
- Local image upload is not part of the new-core publish surface yet.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
