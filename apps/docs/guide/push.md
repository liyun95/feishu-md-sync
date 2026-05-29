# Feishu Push

## What Feishu push does

Feishu push writes local Markdown changes back to an existing Feishu document. It is a local-to-remote workflow: it can write Feishu content, so every write starts with a dry-run strategy plan.

Use this page when you need to understand the workflow. Use `md2feishu workflow show push` when you need the exact command recipe from the installed CLI.

The user does not choose block-level, section-level, or whole-document writes up front. The CLI inspects the local Markdown and current Feishu document, then selects the safest strategy it can explain.

### Use this when

- You edited local Markdown and want to write the changes back to an existing Feishu document.
- You already have a Feishu docx or wiki URL for the target document.
- You need a dry-run plan before approving a Feishu write.
- You want an agent to choose the write strategy from the current local and remote state.

### Do not use this when

- You only need to refresh local Markdown from Feishu. Use [Baseline Sync](/guide/baseline-sync).
- Your local Markdown does not have a Feishu document yet. Use [Publish New](/guide/publish-new).
- You are updating verified SDK code blocks. Use [Multi-SDK Examples](/guide/multisdk-workflow).
- You are releasing audited SDK references to `web-content`. Use [SDK Reference Release](/guide/sdk-reference-release-workflow).

## Run the workflow

Ask Codex to use:

```text
feishu-push
```

Or inspect the CLI recipe directly:

```bash
md2feishu workflow show push
```

### Start with a dry-run

```bash
md2feishu push doc.md '<feishu-doc>'
```

Expected result:

```text
Intent: push local Markdown to Feishu
Selected strategy: block-patch
Scope: FAQ section
Risk: low

Planned Feishu changes:
- update 1 blocks
- create 0 blocks
- delete 0 blocks

Run with --write to apply this plan.
```

Before approving a write, check:

- `Selected strategy`: whether the CLI plans `block-patch`, `section-replace`, or `document-replace`.
- `Scope`: whether the planned write is bounded to the expected section or affects the entire document.
- `Risk`: low for small block patches, medium for section replacement, high for document replacement.
- Operation counts: whether update/create/delete counts match the review intent.
- Fallback reason: why the CLI could not use a smaller patch, if a fallback is selected.

### Limit the review to one heading

Use a heading scope as a guard when only one named section should be considered:

```bash
md2feishu push doc.md '<feishu-doc>' --scope heading:"FAQ"
```

The scope does not mean the user has chosen section replacement. The planner can still use block-level updates inside that section when safe.

### Write after review

```bash
md2feishu push doc.md '<feishu-doc>' --write
```

Use `--yes` only when the dry-run has already been reviewed:

```bash
md2feishu push doc.md '<feishu-doc>' --write --yes
```

Expected write result:

```text
Applied Feishu changes:
- update 1 blocks
- create 0 blocks
- delete 0 blocks
Readback verification: passed
```

### Replace the whole document only when intentional

If the dry-run selects `document-replace`, the write is refused unless full replacement is explicit:

```bash
md2feishu push doc.md '<feishu-doc>' --strategy document-replace --replace-all --write --yes
```

Use this only when replacing the existing Feishu document is intentional.

## How it works

### Decision flow

![Feishu push decision flow](/diagrams/push-how-it-works.png)

Feishu push starts with a dry-run strategy plan. The safest normal path is `block-patch`: the CLI updates, creates, or deletes only the small block ranges that match the local edit. If that is unsafe, the planner falls back to a larger strategy and makes the approval boundary explicit.

### Strategy meanings

| Strategy | What it writes | Risk | Approval expectation |
| --- | --- | --- | --- |
| `block-patch` | Small block updates, creates, or deletes when the local and remote structure can be matched safely. | Low | Review the dry-run counts and write after approval. |
| `section-replace` | Recreates one heading section when block-level patching is unsafe but the change is still bounded to a unique heading. | Medium | Confirm that replacing the whole section is intentional. |
| `document-replace` | Replaces the whole Feishu document content. | High | Requires `--replace-all` and explicit human intent. |

The strategy is selected by the dry-run. Do not force a larger strategy unless the dry-run explains why the smaller strategy is unsafe.

### Local artifacts and receipts

Feishu push can update the local `.sync/feishu/...json` receipt after a whole-document write. The receipt records the source hash, Feishu state hash, block counts, write result, and readback verification result.

Scoped push is different. When the write is limited to a heading scope, the CLI verifies readback but does not update the whole-document receipt. A later `md2feishu status` may report `diverged` even though the scoped write passed verification.

When this happens, inspect the write output and readback evidence before assuming the push failed.

### Safety boundary

Feishu push can write remote Feishu content. A dry-run never writes Feishu.

The default safe path is:

1. Run dry-run.
2. Review selected strategy, scope, risk, and operation counts.
3. Write only after the plan matches the intended change.
4. Verify readback.
5. Visually inspect the rendered Feishu document when content changed.

Do not use `--replace-all` unless replacing the whole document is intentional.

### Completion check

Feishu push is complete when:

- The dry-run plan was reviewed.
- Any required approval gate was satisfied.
- The write passed readback verification.
- Rendered Feishu content was visually inspected when document content changed.
- Any post-write `status` mismatch is explained before starting another write workflow.

## Troubleshooting

### `Requested push strategy ... does not match selected strategy ...`

The forced `--strategy` does not match the strategy selected by the dry-run.

Run without a forced strategy first:

```bash
md2feishu push doc.md '<feishu-doc>'
```

Use the selected strategy unless there is a specific reason to stop and choose a different workflow.

### `Refusing document-replace write without --replace-all`

The plan would replace the whole document. The CLI refuses this unless full replacement is explicit.

Review the dry-run. If full replacement is intentional:

```bash
md2feishu push doc.md '<feishu-doc>' --strategy document-replace --replace-all --write --yes
```

### `Feishu changed since the last receipt`

The remote document changed after the local receipt was written. For scoped push, the CLI can still write only the requested heading in the current remote document, but the warning should be reviewed.

If the remote edits are unexpected, stop and run:

```bash
md2feishu pull '<feishu-doc>' --output doc.remote.md
diff -u doc.md doc.remote.md
```

### `Scoped push does not update the whole-document receipt`

The scoped write passed readback verification, but the whole-document receipt was not updated. A later `status` may report `diverged`.

Use the push output and any independent readback pull to verify the scoped write:

```bash
md2feishu pull '<feishu-doc>' --output doc.readback.md --overwrite
diff -u doc.md doc.readback.md
```

### `Verification mismatch after write`

Readback did not match the expected block state after the write. Stop and inspect the Feishu document before retrying. Do not rerun with a larger strategy until the mismatch is understood.

### zsh rejects or changes a wiki URL

Quote the Feishu document URL:

```bash
md2feishu push doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Baseline Sync](/guide/baseline-sync)
- [Publish New](/guide/publish-new)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
- [Receipts](/reference/receipts)
