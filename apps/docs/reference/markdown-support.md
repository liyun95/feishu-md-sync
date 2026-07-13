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

## Editable Whiteboard Assets

Whiteboard sync uses a PNG/SVG sibling convention:

```text
article.md -> ![Architecture](./assets/architecture.png)
assets/architecture.png
assets/architecture.svg
```

Run `status`, `diff`, or `publish` with `--sync-whiteboards`. The PNG reference must be a standalone Markdown block; an image embedded in prose is blocked when a same-name SVG exists. Remote HTTP images, data URLs, and non-PNG references are not candidates.

The first publish requires exactly one corresponding image or Whiteboard block in the existing remote document. To avoid guessing between interchangeable positions, the first version blocks a section containing multiple untracked asset slots; place them under separate headings or establish receipts one at a time. Neighboring text must also match during initial adoption, so adopt the asset before making adjacent text changes. An image block is replaced by a Whiteboard; an existing Whiteboard is adopted. Later publishes update the same Whiteboard token.

The supported editable SVG subset includes:

- shapes: `rect`, `circle`, `ellipse`, and `polygon`
- lines and paths: `line`, `polyline`, and `path`
- text: `text` and `tspan`
- grouping and reusable local symbols: `g`, `a`, `defs`, `symbol`, and `use`
- basic `translate`, `rotate`, and `scale` transforms

The SVG must be well-formed, self-contained, and declare a `viewBox`. Dry-run blocks scripts, `foreignObject`, embedded images, external references, filters, patterns, clipping, masks, radial gradients, unknown graphical elements, and `matrix`/skew transforms.

The CLI does not create SVGs, render SVG to PNG, or upload PNG bytes. Ordinary images without a same-name SVG stay untouched. Feishu imports supported SVG elements as editable nodes, but native smart-connector binding is not guaranteed.

## Known Limitations

- Feishu to Markdown export is best-effort.
- Unsupported Feishu block types may not round-trip through Markdown.
- PNG rendering and upload are outside the Whiteboard sync feature.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
