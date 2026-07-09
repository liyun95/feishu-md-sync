# Non-Destructive Publish Patch Strategy

Status: accepted

Feishu Markdown Sync should prefer non-destructive updates for existing remote documents. Whole-document replacement remains available, but it is not the default path for normal publishing because it can destroy comments, anchors, block identity, and other collaboration context.

The first non-destructive publish patch strategy is `block-patch`.

## Decision

`block-patch` updates the smallest stable Feishu block that the planner can identify. It may patch nested blocks inside containers such as callouts, tables, and grid columns when those child blocks are addressable and structurally comparable.

`block-patch` does not implement inline text patching in this version. If a sentence changes inside a paragraph, the paragraph block is the patch unit. Inline text patching may be added later as a narrower `text-patch` fast path.

The `auto` strategy may choose `block-patch` when the plan is safe enough. `auto` must never choose `document-replace` for a write.

## Safety Gates

- `--write` is required for all remote writes.
- Insert-only `block-patch` writes require only `--write`.
- Replacing or deleting an existing block requires collaboration-risk confirmation.
- In an interactive terminal, the CLI may show the changed block list and ask for confirmation.
- In non-interactive contexts, replacing or deleting an existing block requires `--confirm-collaboration-risk`.
- Existing remote documents with no publish receipt are untracked. A write to an untracked remote requires `--confirm-untracked-remote`.
- If a publish receipt exists but the current remote hash differs from the receipt's `remoteSnapshotHash`, `block-patch --write` is refused. That case belongs to future pull/review/merge workflows.
- `document-replace` continues to require explicit `--strategy document-replace --confirm-destructive --write`.

## Supported Patch Shape

The first implementation should support block-level planning for:

- headings
- paragraphs
- bullet and ordered list items
- code blocks
- nested text-like children inside supported containers

The planner may recognize and preserve unchanged containers, including callouts, tables, grids, and whiteboards. It should not replace an existing whiteboard in this version.

When the planner cannot safely address the changed child block, it must refuse `block-patch` write and fall back to a dry-run recommendation. It must not silently widen the operation to a container or document replacement.

## Comment Awareness

This version does not depend on comment detection. The current Lark CLI document fetch path exposes block ids, style attributes, and reference metadata, but not a reliable comment inventory mapped to block ids.

Therefore collaboration-risk confirmation is based on operation type, not detected comments. Replacing or deleting an existing block is treated as potentially affecting comments or block identity even when comments are not known to exist.

## Future Work

Future versions may add:

- inline text patching with unique scoped matching and post-write verification
- comment-aware planning if Feishu exposes reliable comment-to-block metadata
- three-way merge using a base snapshot in receipts
- non-overlap remote drift detection after pull/review support exists
