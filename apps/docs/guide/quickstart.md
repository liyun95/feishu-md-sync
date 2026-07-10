# Quickstart

`feishu-md-sync` is a CLI for syncing local Markdown with Feishu/Lark online documents. It uses the official `lark-cli` for Feishu IO and keeps custom behavior in the local workflow layer.

## Install

Clone the repo and install from its root:

```bash
git clone https://github.com/liyun95/feishu-md-sync.git
cd feishu-md-sync
npm install
npm run build
```

## Configure Feishu Access

Authenticate `lark-cli` and make sure the selected identity can access the target document:

```bash
lark-cli auth status
```

If you use a bot identity, configure it in the same environment where commands run:

```bash
export FEISHU_MD_SYNC_LARK_AS=bot
```

Confirm local auth configuration without printing secrets:

```bash
npm exec -- feishu-md-sync doctor auth --format json
```

## Publish Existing Markdown

Dry-run first:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz
```

Write after reviewing the plan:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz --write --confirm-collaboration-risk
```

Use guarded whole-document replacement only when intentional:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz --strategy document-replace --write --confirm-destructive
```

## Create A New Feishu Document

Create under a Drive folder or Wiki parent:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target FolderOrWikiToken --create --profile zilliz --write
```

## Inspect Remote Drift

Check current state:

```bash
npm exec -- feishu-md-sync status ./doc.md --target DocToken --profile zilliz
```

Inspect what publish would change:

```bash
npm exec -- feishu-md-sync diff ./doc.md --target DocToken --profile zilliz
```

## Merge Remote Edits

Merge Feishu edits back into your local authoring file:

```bash
npm exec -- feishu-md-sync merge ./doc.md --target DocToken --profile milvus
```

If a merge writes conflict markers, resolve them locally, then run `status`, `diff`, and `publish` again.

Abort the last in-place merge:

```bash
npm exec -- feishu-md-sync merge ./doc.md --abort --profile milvus
```

## Pull A Remote Snapshot

Save a reviewable remote snapshot without changing the local source file:

```bash
npm exec -- feishu-md-sync pull --target DocToken --output doc.remote.md --profile milvus
```

## Supported Targets

Use any of these forms:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken
npm exec -- feishu-md-sync publish ./doc.md --target https://example.feishu.cn/docx/DocToken
npm exec -- feishu-md-sync publish ./doc.md --target 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```
