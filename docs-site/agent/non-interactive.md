# Non-Interactive Usage

Agents should use explicit commands that either inspect state or write with explicit authorization.

## Read-Only Commands

```bash
npm exec -- md2feishu status ./doc.md DocToken
npm exec -- md2feishu diff ./doc.md DocToken
npm exec -- md2feishu pull DocToken --output feishu.remote.md
npm exec -- md2feishu merge ./doc.md DocToken
```

## Authorized Write Commands

Only use these when the caller authorized writes:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --strategy merge
npm exec -- md2feishu sync ./doc.merged.md DocToken --write --yes --strategy local-wins
```

Agents should not depend on interactive confirmation prompts.
