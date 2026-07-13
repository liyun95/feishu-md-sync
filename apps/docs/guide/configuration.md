# Configuration

`feishu-md-sync` uses the official `lark-cli` for Feishu IO. Authenticate `lark-cli` first, then use `.env` only for repository-local CLI defaults.

## Default Local Setup

For local interactive use, let the official CLI handle authentication:

```bash
npx @larksuite/cli@latest install
lark-cli auth login --domain docs,wiki,drive
lark-cli auth status --verify
```

In this mode, leave `FEISHU_MD_SYNC_LARK_AS` unset. `feishu-md-sync` will let `lark-cli` use its default identity.

## Bot Setup

Use bot mode when commands should run as a Feishu app instead of an interactive user. This is common for CI and agent-driven workflows.

First configure the app credentials in `lark-cli`:

```bash
export LARK_APP_ID='<your-app-id>'
read -rsp 'LARK_APP_SECRET: ' LARK_APP_SECRET; echo
printf "%s" "$LARK_APP_SECRET" | lark-cli config init --app-id "$LARK_APP_ID" --app-secret-stdin --brand feishu
unset LARK_APP_SECRET
```

Then force `feishu-md-sync` to request the bot identity:

```bash
export FEISHU_MD_SYNC_LARK_AS=bot
```

`FEISHU_MD_SYNC_LARK_AS` is an identity selector passed to `lark-cli`; it is not an App ID.

API permissions are not enough by themselves. Add the app or bot to the target Feishu resource:

- For an existing docx target, add the app as a collaborator on the document.
- For a wiki target, make sure the app can resolve the wiki node and edit the underlying document when writing.
- For a Drive folder or Wiki parent used with `publish --create`, grant edit access to the parent location.

Check both layers:

```bash
lark-cli auth status --verify
feishu-md-sync doctor auth --format json
```

## Repository `.env`

Use `.env` only for local defaults such as the identity selector. Do not put App Secrets in this project's `.env`; App ID and App Secret belong to `lark-cli`.

From the repository root:

```bash
cp .env.example .env
```

Example:

```bash
FEISHU_MD_SYNC_LARK_AS=bot
```

`.env` is ignored by git. Do not commit real credentials.

## Loading Order

The CLI loads `.env` files from:

1. `--env-file <file>`, when provided.
2. The current working directory.
3. The CLI package checkout and its workspace root, when detectable.

This means commands such as `npm --prefix /path/to/feishu-md-sync exec -- feishu-md-sync ...` can still load `/path/to/feishu-md-sync/.env` even when invoked from another directory.

Use `doctor auth` to confirm what was loaded and which `lark-cli` identity will be requested:

```bash
feishu-md-sync doctor auth --format json
```

## GitHub Actions Setup

Use a dedicated test bot for live CI. Do not reuse production app credentials for tests.

Recommended repository secrets:

```text
LARK_TEST_APP_ID
LARK_TEST_APP_SECRET
FEISHU_MD_SYNC_TEST_DOC
```

In the workflow, map the test secrets to the environment variable names expected by `lark-cli` only inside the credential setup step:

```yaml
- name: Configure lark-cli bot credentials
  env:
    LARK_APP_ID: ${{ secrets.LARK_TEST_APP_ID }}
    LARK_APP_SECRET: ${{ secrets.LARK_TEST_APP_SECRET }}
  run: |
    printf "%s" "$LARK_APP_SECRET" | lark-cli config init --app-id "$LARK_APP_ID" --app-secret-stdin --brand feishu
```

Set `FEISHU_MD_SYNC_LARK_AS=bot` for live Feishu tests.

Avoid generic repository secrets such as `LARK_APP_SECRET`; they make it too easy to mix test and production identities.

If you later add production automation, use separate names such as `LARK_PROD_APP_ID` and `LARK_PROD_APP_SECRET`, ideally behind a protected GitHub environment. This project does not currently ship a production auto-publish workflow.

## Permissions

For normal pull, status, diff, merge, and publish workflows, request these Feishu app API permissions. This list assumes the official Markdown path and write-capable publish workflows.

Scope-aware status, diff, and table publishing read Docx blocks. Wiki targets are resolved to their underlying Docx object before those block operations.

| Permission name in Feishu | Needed for |
| --- | --- |
| `创建及编辑新版文档` | Read document blocks and create, update, or delete docx blocks during approved writes. |
| `查看云文档内容` | Use the official Markdown export API for docx documents. |
| `文本内容转换为云文档块` | Use the official Markdown-to-docx-block conversion API before writing Markdown back. |
| `查看知识空间节点信息` | Resolve a wiki URL to the underlying docx token. Required only when targets use `/wiki/...` links. |

For a pull-only setup that never writes back to Feishu, `查看新版文档` can replace `创建及编辑新版文档`.

Workflow-specific features may need additional permissions:

| Workflow need | Additional permission |
| --- | --- |
| List docs in a Drive folder | `获取云空间文件夹下的云文档清单` |
| Publish a new docx into a Drive folder | `创建及编辑新版文档`, plus folder edit access |
| Move a newly created docx into wiki | Wiki node management permission for moving cloud docs into wiki |

API permissions are not enough by themselves. The app also needs resource access:

- For a docx target, add the app as a collaborator on the document. Use read access for pull-only workflows and edit access for write workflows.
- For a wiki target, the app needs node read access to resolve the wiki node, plus edit access to the underlying docx document when writing.
- For Drive folder operations, the app needs access to the folder. Creating, copying, or moving files requires edit access to the target folder.
- For first publication, pass `publish --create --target <folder-or-wiki-parent>`.
- After changing app API permissions, publish or reinstall the app as required by the Feishu developer console so the new permissions take effect.
