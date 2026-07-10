# Feishu Markdown Sync

Feishu Markdown Sync is a dry-run-first sync bridge between local Markdown and Feishu/Lark online documents. The official `lark-cli` owns Feishu authentication and document IO; `feishu-md-sync` adds local profiles, receipts, safety gates, status, diff, pull, merge, and publish UX.

The primary product surface is the `feishu-md-sync` CLI: `publish`, `pull`, `status`, `diff`, and `merge`.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Quickstart

Install and authenticate the official [`lark-cli`](https://github.com/larksuite/cli):

```bash
npx @larksuite/cli@latest install
lark-cli auth login --domain docs,wiki,drive
lark-cli auth status
```

Install dependencies and build this CLI:

```bash
npm install
npm run build
```

Inside a repo checkout, run commands through `npm exec -- feishu-md-sync`. The selected `lark-cli` identity must have access to the target document, Drive folder, or Wiki parent.

Preview a publish plan:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <docx-url-or-token>
```

Write to an existing remote document for the first time after reviewing the plan:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write --confirm-untracked-remote
```

Handle remote edits before publishing:

```bash
npm exec -- feishu-md-sync status ./doc.md --target <docx-url-or-token>
npm exec -- feishu-md-sync diff ./doc.md --target <docx-url-or-token>
npm exec -- feishu-md-sync pull --target <docx-url-or-token> --output doc.remote.md --write-receipt
npm exec -- feishu-md-sync merge ./doc.md --target <docx-url-or-token>
npm exec -- feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write
```

When the merge already makes the local publish draft match the remote document, the final `publish --write` is a no-op remote write: it refreshes the local receipt and merge base snapshot without changing Feishu content.

Preview creating a new document under a Drive folder or Wiki parent:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <wiki-parent-url> --create
```

Execute guarded whole-document replacement only when you intentionally accept the risk:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write --strategy document-replace --confirm-destructive
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

MIT. See [`packages/cli/LICENSE`](./packages/cli/LICENSE) and [`packages/cli/NOTICE`](./packages/cli/NOTICE).
