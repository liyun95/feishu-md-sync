# Markdown Support

`md2feishu` supports a practical subset of Markdown.

## Supported Blocks

- Headings `#` through `######`
- Paragraphs
- Unordered lists
- Ordered lists
- Fenced code blocks
- Tables

## Supported Inline Formatting

- Links
- Inline code
- Bold text
- `==highlight==` markers

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types are omitted with an HTML comment.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
