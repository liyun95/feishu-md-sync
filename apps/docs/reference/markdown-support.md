# Markdown Support

`feishu-md-sync` supports a practical subset of Markdown through Feishu's official Markdown import/export and a small local conversion layer for block patch planning.

## Source Dialect Model

Dialect describes source syntax; profile describes product-content transformation. They are selected independently.

| Source | Dialect | Profile |
| --- | --- | --- |
| Ordinary Markdown | `gfm` | `none` |
| Canonical Zdoc source | `zdoc-authoring` | `zilliz` |
| Milvus canonical source | `milvus-authoring` | `none` |
| Milvus source published with Zilliz wording | `milvus-authoring` | `zilliz` |

`gfm` is the default dialect. Zdoc authoring uses the canonical source, removes frontmatter/imports/heading anchors, converts supported Admonitions to native Callouts, preserves Procedures tokens, and maps Supademo components to protected existing ISV blocks. Milvus authoring supports ancestor `Variables.json` files, frontmatter overrides, recursive <code>&#123;&#123;fragments/...&#125;&#125;</code>, and <code>&#123;&#123;var.path&#125;&#125;</code> expansion.

Unknown body components, invalid Procedures pairs, unsupported Admonitions, missing Supademo correspondence, missing Milvus variables or fragments, fragment cycles, and unknown Milvus directives fail closed.

| Zdoc construct | Feishu representation | Round-trip policy |
| --- | --- | --- |
| Frontmatter/imports/heading anchors | Omitted | Informational `metadata-ignored`; no reconstruction promise |
| `Admonition` | Native Callout | Type, title, and body are managed |
| `Procedures` | Literal paragraph tokens | Exact canonical boundary is planned and verified |
| `Supademo` | Existing add-on/ISV block | Adopt and protect identity; creation is not supported |
| Unknown body component | None | Blocking `component-unsupported` report item |

`zdocRoundTrip` is the machine-readable preflight and readback report. Its item codes separate safe transforms from blockers; automation should use `safeToPublish` and structured codes rather than message text.

## Supported Blocks

- Headings `#` through `######`
- Paragraphs
- Unordered lists
- Ordered lists
- Fenced code blocks
- Tables
- Tables through Feishu Markdown import/export
- Milvus-style note and warning Callouts

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

## Scoped Code Blocks

Top-level CommonMark-style fenced Code blocks use the normal `publish` workflow:

````markdown
```python
client.create_index(...)
```
````

Backtick and tilde fences of length three or greater are supported. The first info-string token is the language; additional attributes are blocked in the first version. CRLF is normalized to LF. The one newline required to place the closing fence on its own line is structural; spaces, tabs, indentation, internal blank lines, and any additional trailing blank lines remain significant.

Local Markdown manages Code content and resolved language. Feishu manages the optional caption. Existing captions are preserved during updates and moves; new Code blocks have no caption. A caption-only remote edit does not conflict with local content or language changes.

Tracked Code blocks support creation, content or language updates, deletion, same-section and cross-section movement, and Code-only section reconcile for large rewrites. Content and language use field-level three-way comparison. Different local and remote edits to different fields merge; different edits to the same field block the complete publish.

Pure movement preserves block identity through `block_move_after`. When correspondence is no longer one-to-one, section reconcile reconstructs only Code blocks in the affected heading scopes. It does not rewrite prose, lists, tables, Callouts, images, or Whiteboards. Remote Code drift or an unmatched captioned block blocks reconcile instead of falling back to whole-document replacement.

The first version supports only body-level Code blocks. Fenced Code nested inside Callouts, table cells, or lists is outside this scope.

## Scoped Callouts

Use canonical local HTML without a presentation title:

```html
<div class="alert note">

Body content with **bold**, *italic*, `inline code`, and an [absolute link](https://milvus.io).

- First item
- Second item

</div>
```

Use `alert warning` for warnings. Supported body blocks are paragraphs, headings, one-level ordered or unordered lists, ordinary line breaks, bold, italic, inline code, and absolute HTTP(S) links.

The local file manages only body children. Existing Feishu title text, emoji, background, border, text color, and Callout container identity are preserved. New notes use `📘 Notes` with orange presentation; new warnings use `❗ Warning` with red presentation unless titles are configured for the workspace.

The first version blocks a changed Callout containing fenced code, tables, images or Whiteboards, nested Callouts or HTML containers, nested lists, checkboxes, blockquotes, dividers, relative links, or other unsupported blocks. An unchanged unsupported remote Callout remains opaque and is preserved. Changing between `note` and `warning` is blocked.

Tracked Callouts compare body children independently. Disjoint local and remote child edits can coexist; overlapping child edits conflict. Deleting a tracked Callout is supported only when that Callout is unchanged remotely and requires `--confirm-collaboration-risk`.

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
- Nested Code blocks are not first-class publish scopes in the first version.
- Pull may resolve an untracked custom Callout title from native Docx Callout metadata; target-based merge still requires a configured or otherwise recognizable presentation title. Pull accepts Feishu's paragraph-wrapped Callout export shape only when the complete payload is a sequence of top-level `<p>` elements; malformed or ambiguous payloads still fail closed.
- PNG rendering and upload are outside the Whiteboard sync feature.
- Paragraph wrapping may not round-trip byte-for-byte.
- The merge algorithm is deterministic and line-based, not semantic Markdown merge.
- `pull` does not reconstruct Zdoc frontmatter/imports/anchors, or Milvus variables and fragments.
- Automatic merge is blocked for `zdoc-authoring` and `milvus-authoring` sources.
- Direct SVG references do not initialize editable Whiteboards; Whiteboard sync still uses the PNG/SVG sibling convention and `--sync-whiteboards`.
- Complex nested-list canonicalization remains outside the scoped publish feature.
