# Non-Interactive Usage

Agents should use explicit commands that either inspect state or write with explicit authorization.

Before choosing low-level commands, inspect the workflow recipe:

```bash
npm exec -- md2feishu workflow list
npm exec -- md2feishu workflow show <workflow-id> --format json
```

Use the returned steps as the allowed sequence unless the user explicitly asks for a lower-level operation.

## Workflow Skills

Each first-class workflow has a matching agent skill. The skill is responsible for choosing the workflow, loading `md2feishu workflow show <workflow-id> --format json`, preserving safety gates, and stopping at human approval boundaries.

The CLI remains the source of truth for execution. Skills must not duplicate command sequences manually when `workflow show` can provide them.

Legacy operation-specific skills should redirect to workflow skills. Keep legacy pages only as compatibility aliases until external agent installations have migrated.

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
