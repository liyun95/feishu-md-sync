# Publish Strategies

`publish` plans one of these strategies before writing:

## `no-op`

The current remote Markdown already matches the desired publish draft. No write is needed.

## `block-patch`

The CLI can update the document through supported block-level operations.

`block-patch` may create, update, or delete supported Markdown blocks. Updating or deleting existing blocks requires `--confirm-collaboration-risk` because comments, anchors, or block identity can be affected.

It can also include `table-replace` operations. Table plans identify the section, table ordinal, added row keys, and updated cells before replacing only the matched table block.

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

Text, Callout, Code, table, and Whiteboard operations are planned together. Any blocker makes the complete publish `blocked`; the CLI does not silently publish only the other scopes.

Write order is text/Callout child/Code updates, creates, Code moves or placement, table replacement, Whiteboards, then deletes. Every Code write is followed by a fresh block read because replacement and deletion invalidate block IDs. Section reconcile creates, replaces, and moves desired blocks before deleting obsolete blocks.

## `blocked`

`auto` returns `blocked` when any local change is unsupported, ambiguous, or conflicts with a remote edit in the same managed scope. Supported operations may still be shown for review, but no write starts until every blocker is resolved.

`blocked` does not fall back to `document-replace` automatically.

Whiteboard blockers include missing or invalid local assets, ambiguous remote placement, an unavailable tracked Whiteboard, unsupported SVG constructs, and remote edits without an asset-specific overwrite confirmation.

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

## `create-document`

The target is a Drive folder or Wiki parent and `publish --create` is requested. The CLI creates a new Feishu document under that parent.

For `zdoc-authoring`, the dry-run reports the Callout and Procedures completion required after initial creation. A write then plans and applies only supported post-create mutations, verifies the final document structure, and records the receipt last. If creation succeeds but a later step fails, the command returns a partial-write error with the created document identity instead of presenting the operation as an ordinary failure.

Whiteboard sync is not supported during document creation in the first version. Create the document and its image/Whiteboard slot first, then run a separate publish with `--sync-whiteboards`.
