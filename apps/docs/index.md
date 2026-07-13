---
layout: home

hero:
  name: feishu-md-sync
  text: Local Markdown and Feishu docs in one loop
  tagline: Publish, pull, inspect, and merge Feishu/Lark document changes with dry-run-first CLI commands.
  actions:
    - theme: brand
      text: Start with Quickstart
      link: /guide/quickstart
    - theme: alt
      text: Command Reference
      link: /reference/commands

features:
  - title: Official Feishu IO
    details: Uses lark-cli for document fetch, update, create, and block operations.
  - title: Dry-run-first writes
    details: Preview publish plans before remote writes, then cross explicit gates for untracked, collaboration-risk, or destructive changes.
  - title: Collaboration aware
    details: Status, diff, merge, receipts, and explicit write gates make remote edits visible before publishing.
---

## Install

Requires Node.js 20 or newer:

```bash
npm install --global feishu-md-sync@latest
feishu-md-sync --help
```

## Main Loop

```bash
feishu-md-sync status ./doc.md --target DocToken
feishu-md-sync diff ./doc.md --target DocToken
feishu-md-sync publish ./doc.md --target DocToken
feishu-md-sync publish ./doc.md --target DocToken --write --confirm-untracked-remote
```

The first command with `publish` is a dry-run. The second writes after review and confirms that the current working directory is adopting an existing remote document for the first time.

## Commands

| Command | Purpose |
| --- | --- |
| `publish` | Dry-run or write local Markdown to Feishu. |
| `pull` | Save a remote Markdown snapshot locally. |
| `status` | Check local, remote, and receipt state. |
| `diff` | Compare current remote content to the local publish draft. |
| `merge` | Merge remote edits into the local Markdown file. |

## Safety Model

- Remote writes are opt-in through `publish --write`.
- Whole-document replacement requires `--strategy document-replace --confirm-destructive`.
- Block updates that may affect collaboration context require `--confirm-collaboration-risk`.
- Existing untracked remote documents require `--confirm-untracked-remote`.
- `merge` writes only local files and supports `--abort`.
