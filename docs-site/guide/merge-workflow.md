# Merge Workflow

Use merge when both local Markdown and Feishu changed.

## Manual Merge

```bash
npm exec -- md2feishu merge ./doc.md DocToken
```

The command writes:

```text
./doc.merged.md
```

If there are conflicts, resolve them directly in the merged file:

```md
<<<<<<< LOCAL
local version
||||||| BASE
last synced base version
=======
feishu version
>>>>>>> FEISHU
```

Then publish the resolved file:

```bash
npm exec -- md2feishu sync ./doc.merged.md DocToken --write --yes --strategy local-wins
```

When `doc.merged.md` was generated from `doc.md`, the CLI reuses the original `doc.md` receipt. After Feishu write verification succeeds, it also updates `doc.md` to the resolved merged content.

## Automated Clean Merge

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

Behavior:

- If Feishu did not change, sync runs normally.
- If Feishu changed and the merge is clean, the CLI writes merged content to Feishu and updates the local file after verification.
- If conflicts remain, the CLI writes `doc.merged.md`, refuses the Feishu write, and exits non-zero.

The merge algorithm is deterministic and line-based. It does not use AI or semantic Markdown rewriting.
