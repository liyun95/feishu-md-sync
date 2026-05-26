# feishu-md-sync

This repository is a lightweight npm workspaces monorepo for the `md2feishu` / `feishu-md-sync` CLI and its documentation site.

## Use the CLI

From the repository root:

```bash
npm install
npm run build
npm exec -- md2feishu --help
```

Detailed CLI usage lives in [`packages/cli/README.md`](./packages/cli/README.md).

## Develop the CLI

Root scripts delegate to the CLI workspace:

```bash
npm run dev -- <args>
npm run typecheck
npm test
npm run build
```

The CLI source, tests, and package metadata live in `packages/cli/`.

## Build Docs

The VitePress documentation site lives in `apps/docs/`:

```bash
npm run docs:dev
npm run docs:build
```

## Advanced Agent and Milvus Workflows

Advanced code-block, multi-SDK, SDK reference, and agent workflows remain documented in the docs site under `apps/docs/agent/`, `apps/docs/guide/`, and `apps/docs/reference/`.
