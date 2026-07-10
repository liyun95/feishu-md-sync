# Quickstart

`feishu-md-sync` is a CLI for syncing local Markdown with Feishu/Lark online documents. It uses the official [`lark-cli`](https://github.com/larksuite/cli) for Feishu IO and keeps custom behavior in the local workflow layer.

The important setup rule is:

- `lark-cli` owns Feishu authentication and API access.
- `feishu-md-sync` owns Markdown/profile transforms, receipts, safety checks, status, diff, pull, publish, and merge UX.

## Set Up Official `lark-cli`

Install the official Lark CLI first:

```bash
npx @larksuite/cli@latest install
```

Authenticate through the official CLI:

```bash
lark-cli auth login --domain docs,wiki,drive
```

Check the official CLI directly:

```bash
lark-cli auth status
```

## Install `feishu-md-sync`

Clone this repo and install from its root:

```bash
git clone https://github.com/liyun95/feishu-md-sync.git
cd feishu-md-sync
npm install
npm run build
```

Inside a repo checkout, run commands through `npm exec -- feishu-md-sync`. After global installation or `npm link`, you can use `feishu-md-sync` directly.

## Prepare Test Documents

This quickstart uses a disposable test document and intentionally writes one line to Feishu.

Create a Feishu document with this initial content:

```md
# lark-cli-test

Milvus stores vector data.
```

Then create a local `doc.md` with one extra line:

```bash
cat > doc.md <<'EOF'
# lark-cli-test

Milvus stores vector data.

This line was written locally.
EOF
```

The app or user selected by `lark-cli` must be able to access the target Feishu resources.

- Use read access for `status`, `diff`, `pull`, and `merge --target`.
- Use edit access for `publish --write`.
- If you use an app or bot identity, add that app to the test document as a collaborator before running the commands below.

API permissions alone are not enough; the selected identity also needs resource access. For more details, see Feishu's collaborator guide and app permission FAQ:

- [Document and folder collaborators](https://www.feishu.cn/hc/en-US/articles/064037224266-introduction-to-document-and-folder-collaborators)
- [Add permissions to an app](https://open.feishu.cn/document/faq/trouble-shooting/how-to-add-permissions-to-app)

Use the test document URL or doc token as `<target>` in the commands below.

The commands below omit `--profile`, so the default profile is used. In a fresh checkout, that default is `none`.

Run one final auth check:

```bash
lark-cli auth status --verify
```

For bot identity, CI, App ID, App Secret, and repository-local `.env` defaults, see [Configuration](/guide/configuration).

## Check The Current State

Start with a read-only status check:

```bash
npm exec -- feishu-md-sync status ./doc.md --target <target>
```

Expected result: first run usually reports `untracked`, because this local checkout has no receipt for the remote document yet.

Inspect the content difference:

```bash
npm exec -- feishu-md-sync diff ./doc.md --target <target>
```

Expected result: the diff shows `This line was written locally.` as an added line.

## Preview And Write

Preview the publish plan. This does not write to Feishu:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <target>
```

Expected result: output shows `mode: dry-run`; the Feishu document does not change.

Write after reviewing the plan:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <target> --write --confirm-untracked-remote
```

Expected result: output shows `mode: write`; the Feishu document now contains `This line was written locally.`

The first write to an existing remote document requires `--confirm-untracked-remote` because there is no local receipt yet.

Check status again:

```bash
npm exec -- feishu-md-sync status ./doc.md --target <target>
```

Expected result: `clean`.

## If The Remote Changed

If teammates edited the Feishu document after your last publish, `status` reports `remote-changed`. Pull a reviewable remote snapshot:

```bash
npm exec -- feishu-md-sync pull --target <target> --output doc.remote.md --write-receipt
```

Merge Feishu edits back into your local authoring file:

```bash
npm exec -- feishu-md-sync merge ./doc.md --target <target>
```

After a successful merge, run `status` again. If the local publish draft already matches the remote but the receipt is stale, close the loop with a no-op publish write:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <target> --write
```

This refreshes the local publish receipt and merge base snapshot without changing Feishu content.

If a merge writes conflict markers, resolve them locally, then run `status`, `diff`, and `publish` again.

Abort the last in-place merge:

```bash
npm exec -- feishu-md-sync merge ./doc.md --abort
```

## Use The Zilliz Profile

Use `--profile zilliz` when your local Markdown is authored in Milvus wording but the Feishu document is for Zilliz Cloud publishing:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <target> --profile zilliz
```

If you do not want product-name transforms, omit `--profile` or use `--profile none`.

## Create A New Document Later

Create under a Drive folder or Wiki parent:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target <folder-or-wiki-parent> --create --write
```

## Pull A Remote Snapshot

Save a reviewable remote snapshot without changing the local source file:

```bash
npm exec -- feishu-md-sync pull --target <target> --output doc.remote.md
```

## Supported Targets

Use any of these forms:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken
npm exec -- feishu-md-sync publish ./doc.md --target https://example.feishu.cn/docx/DocToken
npm exec -- feishu-md-sync publish ./doc.md --target 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```
