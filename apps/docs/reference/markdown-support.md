# Markdown Support

`md2feishu` supports a practical subset of Markdown.

## Supported Blocks

- Headings `#` through `######`
- Paragraphs
- Unordered lists
- Ordered lists
- Fenced code blocks
- Tables
- Feishu callouts on pull, rendered as `:::note` admonitions

## Supported Inline Formatting

- Links
- Inline code
- Bold text
- `==highlight==` markers

## Official Feishu Markdown export

When `--markdown-engine auto` can use Feishu's official Markdown export, `pull` normalizes Feishu's escaped Markdown before writing the local file. This prevents raw sequences such as `\.` or `\&\#39;` from being written back as visible text when the local renderer is used as a fallback.

For `push --scope heading:"..."`, `auto` keeps official export/readback but uses the local renderer for scoped desired blocks when stable block-level planning is needed. This avoids unsafe block ordering from Markdown convert while still writing through Feishu's native Docx block APIs.

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types are omitted with an HTML comment.
- `:::note` admonitions are currently emitted by pull only; Markdown-to-Feishu callout creation is not yet implemented.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
