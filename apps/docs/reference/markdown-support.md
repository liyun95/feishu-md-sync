# Markdown Support

`md2feishu` supports a practical subset of Markdown.

## Supported Blocks

- Headings `#` through `######`
- Paragraphs
- Unordered lists
- Ordered lists
- Fenced code blocks
- Tables
- Local images/SVGs through the docs v2 overwrite backend
- Feishu callouts on pull, rendered as `:::note` admonitions

## Supported Inline Formatting

- Links
- Inline code
- Bold text
- `==highlight==` markers

## Official Feishu Markdown export

When `--markdown-engine auto` can use Feishu's official Markdown export, `pull` normalizes Feishu's escaped Markdown before writing the local file. This prevents raw sequences such as `\.` or `\&\#39;` from being written back as visible text when the local renderer is used as a fallback.

For `push --scope heading:"..."`, `auto` keeps official export/readback but uses the local renderer for scoped desired blocks when stable block-level planning is needed. This avoids unsafe block ordering from Markdown convert while still writing through Feishu's native Docx block APIs.

## Docs v2 overwrite backend

`--write-backend docx-v2-overwrite` is a whole-document backend for Markdown that needs Feishu's native table rendering or exact local image/SVG uploads.

This backend:

- strips YAML frontmatter before writing
- keeps Markdown tables in the body for Feishu docs v2 Markdown overwrite
- removes local `![alt](path)` image syntax from the body
- uploads local images separately and binds them to Feishu image blocks
- verifies table and media block counts from readback

Use `--image-root-dir` for site-style paths such as `/img/diagram.svg`. Use `--image-size /img/diagram.svg=900x393` when dimensions are not available or when a specific display size is required.

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types are omitted with an HTML comment.
- The default block-patch backend does not import local Markdown images as Feishu image blocks; use `--write-backend docx-v2-overwrite` for local images/SVGs.
- `:::note` admonitions are currently emitted by pull only; Markdown-to-Feishu callout creation is not yet implemented.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
