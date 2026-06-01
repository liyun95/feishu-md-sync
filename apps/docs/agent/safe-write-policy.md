# Safe Write Policy

Agents must treat Feishu writes as user-authorized side effects.

## Rules

- Start with `status` or a dry-run before writing.
- Do not use `--force-initial-overwrite` unless the human explicitly says the first overwrite is intentional.
- Do not use `--force-whole-document-sync` when a `multisdk` task exists unless the human explicitly wants a whole-document write.
- Do not use `--strategy local-wins` unless the human explicitly chose overwrite or the agent is publishing a resolved `.merged.md`.
- Prefer `push --scope heading:"Heading text"` when only one Feishu section should be considered.
- Do not use `push --strategy document-replace --replace-all` unless the dry-run recommends full replacement and the human explicitly approves it.
- Prefer `--strategy merge` for unattended sync.
- Prefer `md2feishu multisdk diff` and `md2feishu multisdk apply` for language-scoped code-block tasks.
- Use `md2feishu multisdk land-docs` after audit when reviewed Feishu blocks need to land in a docs repo; pass `--base` so base-named branches are rejected before write.
- Stop and ask the human to resolve conflicts when `.merged.md` contains conflict markers.

## Safe Default

```bash
npm exec -- md2feishu sync ./doc.md DocToken
```

This does not write Feishu.

For the normal local-to-Feishu write workflow, prefer:

```bash
npm exec -- md2feishu push ./doc.md DocToken
```

## Safer Automated Write

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

This writes only when merge is conflict-free.
