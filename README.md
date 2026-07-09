# Feishu Markdown Sync

Feishu Markdown Sync is a sync bridge between local Markdown and Feishu/Lark online documents. The new core focuses on product documentation publishing: local Markdown is transformed into a Feishu/Lark publish draft, planned as a dry run, and written only when explicit safety gates are satisfied.

The first new-core slice supports publishing local Markdown to an existing Feishu/Lark online document with the `zilliz` profile. Historical workflow automation remains in the repository during migration, but the primary product surface is `feishu-md-sync publish`.

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

This protects comments, anchors, block identity, and teammate edits from accidental replacement. Fine-grained block and section writes are planned follow-up work for the new core.

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
