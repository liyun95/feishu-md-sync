# Feishu Push

Feishu push writes local Markdown changes to an existing Feishu document. It is the default local-to-Feishu Markdown write workflow.

Use this page when you need to understand the workflow. Use `md2feishu workflow show push` when you need the exact command recipe from the installed CLI.

## Use this when

- You edited local Markdown and want to write the changes back to Feishu.
- You want the CLI to choose whether the write should be block-level, section-level, or whole-document.
- You need a dry-run plan before approving a Feishu write.

## Do not use this when

- You only need to refresh local Markdown from Feishu. Use [Baseline Sync](/guide/baseline-sync).
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

## Dry-run first

```bash
md2feishu push doc.md '<feishu-doc>'
```

The dry-run prints:

- selected strategy: `block-patch`, `section-replace`, or `document-replace`;
- scope;
- risk;
- update, create, and delete counts;
- fallback reason when the planner could not use a smaller patch;
- the approval requirement.

## Optional heading scope

Use a heading scope as a guard when only one named section should be considered:

```bash
md2feishu push doc.md '<feishu-doc>' --scope heading:"FAQ"
```

The scope does not mean the user has chosen section replacement. The planner can still use block-level updates inside that section when safe.

## Write after review

```bash
md2feishu push doc.md '<feishu-doc>' --write
```

Use `--yes` only when the dry-run has already been reviewed:

```bash
md2feishu push doc.md '<feishu-doc>' --write --yes
```

## Whole-document replacement

If the dry-run selects `document-replace`, the write is refused unless full replacement is explicit:

```bash
md2feishu push doc.md '<feishu-doc>' --strategy document-replace --replace-all --write --yes
```

Use this only when replacing the existing Feishu document is intentional.

## Completion check

The workflow is complete when:

- the dry-run plan was reviewed;
- any required approval gate was satisfied;
- the write passed readback verification;
- rendered Feishu content was visually inspected when document content changed.

## Related reference

- [Choose a Workflow](/guide/workflows)
- [Baseline Sync](/guide/baseline-sync)
- [Safety Gates](/reference/safety-gates)
- [Commands](/reference/commands)
