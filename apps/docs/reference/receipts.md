# Receipts

Receipts are written only after successful remote writes or explicit pull snapshot requests. They are ignored by git.

New-core receipt locations:

```text
.sync/feishu-md-sync/
.sync/feishu-md-sync/pulls/
.sync/feishu-md-sync/bases/
```

## Publish Receipts

`publish` receipts are target-oriented. They record the last successful local Markdown to Feishu write and are used to detect remote drift before later block-patch writes.

Version 2 receipts also record the resolved Docx identity and a verified remote semantic snapshot. This lets the planner distinguish a conflicting edit inside a managed table or Callout from an unrelated remote edit elsewhere in the document.

Version 3 extends that semantic baseline with tracked Whiteboard assets. It is written when `publish --sync-whiteboards --write` completes verification.

Stored data includes:

- target kind and token
- profile
- local source hash
- publish draft hash
- remote snapshot hash
- remote revision when available
- local base snapshot path and hash
- resolved Docx document ID
- remote semantic snapshot path and hash
- Whiteboard asset entries in version 3
- update timestamp

Each version 3 Whiteboard entry records:

- normalized PNG asset key and sibling SVG path
- local SVG hash
- Feishu Whiteboard token and document block ID
- normalized remote raw-state hash
- placement fingerprint for the semantic image position

These values let later runs distinguish a local SVG update from a remote Whiteboard edit and verify that updates retain the same remote identity. Whiteboard entries are persisted only after raw-state and document-block readback succeeds.

Callout baselines live in the existing remote semantic snapshot; Callout support does not introduce a new receipt version. The baseline records the Callout type and body children while treating the Feishu title, emoji, colors, and container presentation as remote-managed. This also lets a tracked Callout keep a customized remote title without losing its `note` or `warning` identity.

## Local Base Snapshots

After a successful `publish --write`, the CLI stores the local source Markdown used for that publish under:

```text
.sync/feishu-md-sync/bases/<target-kind>-<target-token>-local.md
```

The publish receipt stores only the snapshot path and hash:

```json
{
  "localBaseSnapshot": {
    "path": ".sync/feishu-md-sync/bases/docx-DocToken-local.md",
    "hash": "..."
  }
}
```

`merge` uses this local authoring snapshot as the three-way merge base when available:

```text
base:   last successfully published local source
local:  current local Markdown file
remote: current Feishu Markdown after pull-side profile filtering
```

If the base snapshot file is missing, `merge` falls back to conservative conflict regions. `merge` itself never updates the base snapshot; the next successful `publish --write` updates it.

The remote semantic baseline is stored alongside the local base:

```text
.sync/feishu-md-sync/bases/<target-kind>-<target-token>-remote-semantic.json
```

Execution-only Feishu block IDs are removed from the general semantic snapshot before it is written. Version 3 stores the Whiteboard block IDs separately because safe Whiteboard updates must retain that exact identity. A legacy version 1 receipt is upgraded only when its recorded remote raw hash still matches the current remote document.

Scoped writes stop after the first failed operation. The CLI does not roll back already verified operations and does not write a new receipt for a partial write. Inspect the remote result and rerun the same publish; the next plan uses the actual remote state and skips Callout children that already converged.

To adopt an existing document that is already synchronized, use a confirmed no-op publish:

```bash
feishu-md-sync publish ./doc.md --target <wiki-or-docx-url>
feishu-md-sync publish ./doc.md --target <wiki-or-docx-url> --write --confirm-untracked-remote
```

## Pull Receipts

Pull snapshot receipts are output-oriented. They record that one local `*.remote.md` snapshot came from one remote document revision.

Stored data includes:

- `kind: "pull-snapshot"`
- target docx or Wiki token
- output path
- profile
- remote revision when available
- raw official Markdown export hash
- profile-filtered output hash
- pull timestamp

Pull receipts do not mean the canonical local source file is synchronized, and they do not affect publish remote drift checks.
