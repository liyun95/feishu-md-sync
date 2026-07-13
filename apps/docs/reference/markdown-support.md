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

`publish` uses `lark-cli docs +update/+create` for remote writes. In `auto`, it attempts a scoped block patch when every local change can be matched and verified safely. Unsafe or unsupported changes produce a `blocked` plan; `auto` never falls back to whole-document replacement.

## Scoped HTML Tables

`publish` can parse local HTML parameter tables, show row-level additions and updates, and replace only the matched Feishu table block.

| Structure | First slice |
|---|---|
| Fixed columns and a header row | Supported |
| Paragraphs and `<br>` in cells | Supported |
| Inline code, bold, italic, and absolute links | Supported |
| One-level `ul` / `ol` | Supported |
| Merged cells | Blocked |
| Nested lists | Blocked |
| Images, resources, or nested tables | Blocked |
| Row deletion or reorder | Blocked |

The first column must contain a unique, non-empty key for every data row. The CLI reports a row-level diff, but the first implementation writes by replacing that one table block. This requires `--confirm-collaboration-risk` because comments or anchors inside the table may be affected.

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types may not round-trip through Markdown.
- Local image upload is not part of the new-core publish surface yet.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
