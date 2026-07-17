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

Current publishes write version 4 receipts for ordinary documents and version 5 receipts when protected Zdoc resources are present. Version 4 records the selected source dialect, dialect dependencies, stable document-link mappings, tracked Whiteboard assets, and an exact sidecar snapshot of the final publish draft. Version 5 adds protected Supademo component identity, ISV block identity and shape, and placement fingerprints. Older versions remain readable; versions 1 through 3 are interpreted as `gfm`.

The exact publish-draft snapshot matters when the local source depends on `Variables.json`, fragments, profile transformation, or a changing Base mapping. Later scoped planning compares against what was actually published rather than trying to reconstruct the old draft from current dependencies.

Stored data includes:

- target kind and token
- profile
- dialect and dialect draft hash
- dialect dependency fingerprints
- resolved document links and their link-resolution fingerprint
- local source hash
- publish draft hash
- remote snapshot hash
- remote revision when available
- local base snapshot path and hash
- resolved Docx document ID
- remote semantic snapshot path and hash
- exact publish-draft snapshot path and hash
- Whiteboard asset entries
- protected Supademo entries in version 5
- update timestamp

Each Whiteboard entry records:

- normalized PNG asset key and sibling SVG path
- local SVG hash
- Feishu Whiteboard token and document block ID
- normalized remote raw-state hash
- placement fingerprint for the semantic image position

These values let later runs distinguish a local SVG update from a remote Whiteboard edit and verify that updates retain the same remote identity. Whiteboard entries are persisted only after raw-state and document-block readback succeeds.

For a tracked `zdoc-authoring` direct SVG reference, the receipt keeps its existing normalized PNG `assetKey`; the recorded `svgPath` identifies the canonical direct SVG. Protection requires both paths plus the remote block ID and Whiteboard token to match exactly. This compatibility mapping does not create a new SVG asset-key format.

Callout and Code block baselines live in the remote semantic snapshot. The Code baseline records exact content, canonical language, caption, section, and order. The local base snapshot retains the authoring fence alias, while comparisons use the resolved language. Execution-only block IDs are fetched again during writes rather than treated as durable semantic identity.

The Callout baseline records the Callout type and body children while treating the Feishu title, emoji, colors, and container presentation as remote-managed. This also lets a tracked Callout keep a customized remote title without losing its `note` or `warning` identity.

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

Scoped planning also compares the local and remote semantic baselines with each other. This detects loss that was already recorded by an older receipt, such as a local table omitted from the remote snapshot or an extra duplicate remote paragraph. A repair is eligible only while the affected current local and remote scopes still match their respective baselines. Later local edits, remote edits, or ambiguous baseline correspondence block the repair.

The first repairable shapes are intentionally narrow: an anchored native table create for a receipt-recorded local-only table, and deletion of a receipt-recorded remote-only duplicate text block. The delete still requires collaboration-risk confirmation. Other cross-kind or ambiguous baseline divergence remains blocked.

If a scoped create was written but failed readback before a new receipt could be recorded, the next publish may recover without a journal only when the remote section is exactly the desired created prefix followed by the unchanged receipt baseline suffix. Harmless representation differences may be adopted, while a lost resolved Feishu link is repaired explicitly. Every suffix block, block ID, and adjacent section anchor must still match; an extra remote block or any changed suffix content blocks recovery.

Version 4 also stores the exact prior publish draft:

```text
.sync/feishu-md-sync/bases/<target-kind>-<target-token>-publish.md
```

Execution-only Feishu block IDs are removed from the general semantic snapshot before it is written. Whiteboard block IDs remain separate because safe Whiteboard updates must retain that exact identity. A legacy version 1 receipt is upgraded only when its recorded remote raw hash still matches the current remote document.

Scoped writes stop after the first failed operation. The CLI does not roll back already verified operations and does not write a new receipt for a partial write. Inspect the remote result and rerun the same publish; the next plan uses the actual remote state and skips Callout children or Code operations that already converged. A receipt-recorded native `table-create` is also preserved when the desired and remote tables match exactly and the table remains between the unchanged semantic anchors recorded by the baseline. Table content, marks, position, or anchor drift keeps recovery blocked.

For `zdoc-authoring`, removing a locally tracked Supademo placeholder is blocked and its version 5 mapping remains protected. Document creation also writes no receipt until post-create Callout and Procedures completion passes final readback. If the document was created but a later step fails, structured partial-write output includes the created document ID and URL for recovery.

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
