# Feishu Markdown Sync

Feishu Markdown Sync is a sync bridge between local Markdown and Feishu/Lark online documents. It focuses on product documentation workflows where local Markdown is authored in a Milvus-shaped source form, transformed for Zilliz Cloud publishing, reviewed as a dry run, and written only when explicit safety gates are satisfied.

The primary product surface is the `feishu-md-sync` CLI: `publish`, `pull`, `status`, `diff`, and `merge`.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Quickstart

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Install and authenticate the official Lark CLI:

```bash
npx @larksuite/cli@latest install
lark-cli auth status
```

Preview a publish plan:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --profile zilliz
```

Handle remote edits before publishing:

```bash
feishu-md-sync status ./doc.md --target <docx-url-or-token> --profile zilliz
feishu-md-sync diff ./doc.md --target <docx-url-or-token> --profile zilliz
feishu-md-sync pull --target <docx-url-or-token> --output doc.remote.md --profile milvus --write-receipt
feishu-md-sync merge ./doc.md --target <docx-url-or-token> --profile milvus
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --profile zilliz --write
```

When the merge already makes the local publish draft match the remote document, the final `publish --write` is a no-op remote write: it refreshes the local receipt and merge base snapshot without changing Feishu content.

Preview creating a new document under a Drive folder or Wiki parent:

```bash
feishu-md-sync publish ./doc.md --target <wiki-parent-url> --create --profile zilliz
```

Execute guarded whole-document replacement only when you intentionally accept the risk:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --profile zilliz --write --strategy document-replace --confirm-destructive
```

## Safety Model

Commands are dry-run by default. `--write` allows remote writes, but it does not allow destructive strategies by itself.

Existing-document whole replacement requires all of these gates:

- `--write`
- `--strategy document-replace`
- `--confirm-destructive`

This protects comments, anchors, block identity, and teammate edits from accidental replacement. When the document shape is safe, `publish` can use block-level patching instead of whole-document replacement.

## Develop

Root scripts delegate to the CLI and docs workspaces:

```bash
npm run dev -- <args>
npm run typecheck
npm test
npm run build
npm run docs:dev
npm run docs:build
```

Generated outputs such as `packages/cli/dist/`, `packages/cli/coverage/`, `apps/docs/.vitepress/dist/`, `.sync/`, `runs/`, and `dogfood/` should not be committed unless explicitly intended.

## License

MIT. See [`packages/cli/NOTICE`](./packages/cli/NOTICE).
