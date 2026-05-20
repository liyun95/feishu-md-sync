# First Baseline Sync

A baseline sync creates the receipt that later protects the Feishu document from accidental overwrites.

## Dry-Run First

```bash
npm exec -- md2feishu sync ./doc.md DocToken
```

The output shows the planned operation, source block count, Feishu block count, and desired hash.

## First Write

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes
```

After a successful write, the CLI stores a receipt under:

```text
.sync/feishu/
```

Receipts are ignored by git.

## Non-Empty Remote Protection

If the Feishu document already has content and no receipt exists, the CLI refuses the initial write:

```text
Initial write would replace existing Feishu content.
```

Only bypass this when the replacement is intentional:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes --force-initial-overwrite
```
