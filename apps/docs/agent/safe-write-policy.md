# Safe Write Policy

Agents must treat Feishu writes as user-authorized side effects.

## Rules

- Start with `status` or a dry-run before writing.
- Do not use `--force-initial-overwrite` unless the human explicitly says the first overwrite is intentional.
- Do not use `--strategy local-wins` unless the human explicitly chose overwrite or the agent is publishing a resolved `.merged.md`.
- Prefer `--strategy merge` for unattended sync.
- Stop and ask the human to resolve conflicts when `.merged.md` contains conflict markers.

## Safe Default

```bash
npm exec -- md2feishu sync ./doc.md DocToken
```

This does not write Feishu.

## Safer Automated Write

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
```

This writes only when merge is conflict-free.
