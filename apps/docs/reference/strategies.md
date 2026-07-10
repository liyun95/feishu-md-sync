# Publish Strategies

`publish` plans one of these strategies before writing:

## `no-op`

The current remote Markdown already matches the desired publish draft. No write is needed.

## `block-patch`

The CLI can update the document through supported block-level operations.

`block-patch` may create, update, or delete supported Markdown blocks. Updating or deleting existing blocks requires `--confirm-collaboration-risk` because comments, anchors, or block identity can be affected.

## `document-replace`

The CLI would replace the whole document body.

This strategy is intentionally gated:

```bash
feishu-md-sync publish ./doc.md \
  --target DocToken \
  --profile zilliz \
  --strategy document-replace \
  --write \
  --confirm-destructive
```

Use it only after reviewing the dry-run and accepting the collaboration risk.

## `create-document`

The target is a Drive folder or Wiki parent and `publish --create` is requested. The CLI creates a new Feishu document under that parent.
