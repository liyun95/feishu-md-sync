# Publish Strategies

`publish` plans one of these strategies before writing:

## `no-op`

The current remote Markdown already matches the desired publish draft. No write is needed.

## `block-patch`

The CLI can update the document through supported block-level operations.

`block-patch` may create, update, or delete supported Markdown blocks. Updating or deleting existing blocks requires `--confirm-collaboration-risk` because comments, anchors, or block identity can be affected.

It can also include `table-replace` operations. Table plans identify the section, table ordinal, added row keys, and updated cells before replacing only the matched table block.

A `table-create` operation is limited to a receipt-recorded round-trip loss where the local baseline contains the table and the remote semantic baseline omitted it. The operation records the stable preceding and following remote block IDs, checks that they are still adjacent immediately before the write, inserts native table XML between them, and verifies table content and placement by readback. It is not a general table insertion or cross-kind replacement primitive.

Callout plans create or delete a complete Callout and update, insert, or delete supported body children. Existing presentation and container identity are preserved. Type changes and overlapping local/remote edits to the same child are blocked.

Code plans use these operation kinds:

- `code-update` - replace one Code block through XML while preserving its remote caption.
- `code-create` - insert a new captionless Code block after a resolved semantic anchor.
- `code-move` - move an existing block with `block_move_after` while preserving identity.
- `code-delete` - delete a tracked, remotely unchanged Code block.
- `code-section-reconcile` - reproduce only the Code ordering/content in affected heading scopes when stable one-to-one correspondence is unavailable.

With `--sync-whiteboards`, the same plan may also contain:

- `whiteboard-create` - replace one corresponding remote image block with a Whiteboard.
- `whiteboard-adopt` - adopt and verify one existing corresponding Whiteboard.
- `whiteboard-update` - overwrite the SVG content of the already tracked Whiteboard while retaining its token and block identity.

Without `--sync-whiteboards`, `zdoc-authoring` still reports receipt-tracked Whiteboards as protected assets. `preserve tracked whiteboard` is a verified no-op, not a write operation. A changed direct SVG, missing receipt, source-path mismatch, block/token mismatch, or placement mismatch blocks the complete publish. Direct SVG updates require both Whiteboard sync intent and exact asset-specific confirmation.

Tracked Whiteboard updates use a stable idempotency token. The Lark CLI adapter preserves the upstream numeric OpenAPI code as `providerCode`; both the update call and its readback use bounded retries when `providerCode=4003101` reports that the document is applying. After a successful update, the adapter also reports a success envelope whose raw node state is not populated yet as the structured transient subtype `whiteboard_raw_not_ready`; this includes an explicitly empty `nodes` array or an empty top-level raw array. Only post-update readback orchestration retries that subtype. Ordinary queries still fail on the first not-ready result, and raw data with a missing or non-array `nodes` field or invalid embedded JSON remains malformed and is not retried. Other provider codes fail immediately even if their message uses similar wording. Exhausting either bounded retry returns a partial-write result before any pending deletes execute.

Text, Callout, Code, table, and Whiteboard operations are planned together. Any blocker makes the complete publish `blocked`; the CLI does not silently publish only the other scopes.

For a tracked text sequence whose block count changes, block patch may replace only the gap between unique unchanged anchors, such as stable section headings. The desired gap is inserted after the preceding verified anchor before the obsolete remote block IDs are deleted. A single changed block may still be updated in place. Duplicate, reordered, missing, or otherwise ambiguous anchors fail closed instead of mapping blocks by array position. Any update or delete in this plan still requires `--confirm-collaboration-risk`.

Document-body list items preserve indented child paragraphs and nested ordered or unordered list items as Feishu child blocks. Semantic comparison includes that parent/child structure, so an equivalent-looking flat root sequence does not count as synchronized. Nested updates and deletes retain the reviewed parent block ID. Nested creates use the Docx child-block API: the CLI creates root list blocks at the reviewed sibling index, then creates each ordered child sequence under the returned root block IDs. Markdown and composite XML insertion are not used for this path because both may merge child paragraphs into parent text or omit paragraphs after a nested list. Every batch uses a deterministic idempotency token and verifies the returned IDs, parent, order, content, and final complete tree before any reviewed deletion runs.

When a previous scoped create recorded a flat list sequence, `block-patch` can recover only an exact stable prefix + complete desired-tree preorder + unchanged receipt baseline suffix shape. It recreates the intended nested tree, then deletes the reviewed flat partial sequence and obsolete suffix. Before any write, the CLI rechecks every expected block, its order, and surrounding anchors. Resolved Feishu links remain part of the desired tree. Additional local or remote drift keeps the plan blocked.

If earlier Markdown or composite XML creates produced malformed roots, recovery recognizes only the exact observed normalization: leading child paragraphs concatenated into their parent list text, nested list children retained under that parent, trailing paragraphs omitted, followed by the complete unchanged flat baseline sequence. Multiple consecutive malformed attempts are consumed as exact groups before locator correspondence. A staged direct create that stopped after an exact prefix is also recoverable only when its roots, completed children, order, and surrounding anchors match precisely. The dry-run reports every partial or malformed root, descendant block ID, baseline block ID, and surrounding anchor. A rerun creates and verifies the correct direct child tree before deleting those reviewed roots. Any changed child identity, content, order, parent relationship, or anchor blocks the recovery before writing.

If a verified `table-create` completed before a later operation failed, a rerun preserves that native table instead of creating a duplicate. This recovery requires an exact locator and full table semantic match, including headers, rows, inline marks, and unsupported-content state. The unchanged preceding and following baseline anchors must still be adjacent around the table and have current remote block IDs. Any content, placement, or anchor drift remains a blocker.

Write order is text/Callout child/Code updates, creates, Code moves or placement, table replacement, Whiteboards, then deletes. Every Code write is followed by a fresh block read because replacement and deletion invalidate block IDs. Section reconcile creates, replaces, and moves desired blocks before deleting obsolete blocks.

## `blocked`

`auto` returns `blocked` when any local change is unsupported, ambiguous, or conflicts with a remote edit in the same managed scope. Supported operations may still be shown for review, but no write starts until every blocker is resolved.

`blocked` does not fall back to `document-replace` automatically.

Whiteboard blockers include missing or invalid local assets, ambiguous remote placement, missing or mismatched tracked identity, an unavailable tracked Whiteboard, unsupported SVG constructs, protected direct SVG changes without explicit intent and confirmation, and remote edits without an asset-specific overwrite confirmation.

## `document-replace`

The CLI would replace the whole document body. This is an explicit escape hatch, not an automatic fallback.

This strategy is intentionally gated:

```bash
feishu-md-sync publish ./doc.md \
  --target DocToken \
  --strategy document-replace \
  --write \
  --confirm-destructive
```

Use it only after reviewing the dry-run and accepting the collaboration risk.

`--sync-whiteboards` is intentionally rejected with `document-replace`; Whiteboard identity is managed only through scoped operations.

For `zdoc-authoring`, any receipt-tracked Whiteboard also blocks explicit document replacement because replacement cannot preserve its block and token identity.

## `create-document`

The target is a Drive folder or Wiki parent and `publish --create` is requested. The CLI creates a new Feishu document under that parent.

For `zdoc-authoring`, the dry-run reports the Callout and Procedures completion required after initial creation. A write then plans and applies only supported post-create mutations, verifies the final document structure, and records the receipt last. If creation succeeds but a later step fails, the command returns a partial-write error with the created document identity instead of presenting the operation as an ordinary failure.

Whiteboard sync is not supported during document creation in the first version. Create the document and its image/Whiteboard slot first, then run a separate publish with `--sync-whiteboards`.
