# feishu-md-sync

`feishu-md-sync` is a Markdown sync bridge for local authoring and Feishu/Lark online documents. It uses the official `lark-cli` for Feishu document IO and keeps project-specific behavior in a small workflow layer.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Main Commands

| Need | Command |
| --- | --- |
| Publish local Markdown to Feishu | `feishu-md-sync publish` |
| Create a new Feishu document from Markdown | `feishu-md-sync publish --create` |
| Pull a remote Markdown snapshot | `feishu-md-sync pull` |
| Check local/remote state | `feishu-md-sync status` |
| Inspect publish diff | `feishu-md-sync diff` |
| Merge remote edits into local Markdown | `feishu-md-sync merge` |

The CLI is dry-run-first for remote writes. `publish` writes to Feishu only with `--write`; destructive replacement also requires `--strategy document-replace --confirm-destructive`.

## Setup

Install dependencies and build:

```bash
npm install
npm run build
```

Authenticate `lark-cli` and make sure your Feishu app or user has access to the target document:

```bash
lark-cli auth status
```

Inspect local auth loading without printing secrets:

```bash
npm exec -- feishu-md-sync doctor auth --format json
```

## Common Flow

Check status:

```bash
npm exec -- feishu-md-sync status ./doc.md --target DocToken --profile zilliz
```

Inspect what publish would change:

```bash
npm exec -- feishu-md-sync diff ./doc.md --target DocToken --profile zilliz
```

Merge remote edits back into the local Milvus-shaped authoring file:

```bash
npm exec -- feishu-md-sync merge ./doc.md --target DocToken --profile milvus
```

Dry-run a publish:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz
```

Write after reviewing the plan:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz --write --confirm-collaboration-risk
```

Create a new document under a Drive folder or Wiki parent:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target FolderOrWikiToken --create --profile zilliz --write
```

Pull a profile-filtered remote snapshot:

```bash
npm exec -- feishu-md-sync pull --target DocToken --output doc.remote.md --profile milvus
```

Abort an in-place merge:

```bash
npm exec -- feishu-md-sync merge ./doc.md --abort --profile milvus
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Generated outputs such as `dist/` and `coverage/` should not be committed.
