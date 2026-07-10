# Configuration

`feishu-md-sync` uses the official `lark-cli` for Feishu IO. Authenticate `lark-cli` first, then use `.env` only for repository-local CLI defaults.

## Create `.env`

From the repository root:

```bash
cp .env.example .env
```

Set the identity only when you need to force bot or user mode:

```bash
FEISHU_MD_SYNC_LARK_AS=bot
```

Leave `FEISHU_MD_SYNC_LARK_AS` unset to use `lark-cli`'s default identity.

`.env` is ignored by git. Do not commit real credentials.

## Loading Order

The CLI loads `.env` files from:

1. `--env-file <file>`, when provided.
2. The current working directory.
3. The CLI package checkout and its workspace root, when detectable.

This means commands such as `npm --prefix /path/to/feishu-md-sync exec -- feishu-md-sync ...` can still load `/path/to/feishu-md-sync/.env` even when invoked from another directory.

Use `doctor auth` to confirm what was loaded and which `lark-cli` identity will be requested:

```bash
npm exec -- feishu-md-sync doctor auth --format json
```

## Authenticate `lark-cli`

Check the official CLI directly:

```bash
lark-cli auth status
```

If you use a bot identity, make sure `lark-cli` is configured for that app and that the app has access to the target document or parent location.

## Permissions

For normal pull, status, diff, merge, and publish workflows, request these Feishu app API permissions. This list assumes the official Markdown path and write-capable publish workflows.

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
