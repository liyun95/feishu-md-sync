# Configuration

`md2feishu` reads Feishu credentials from environment variables or a local `.env` file.

## Create `.env`

From the repository root:

```bash
cp .env.example .env
```

Fill in the Feishu app credentials:

```bash
APP_ID=cli_xxx
APP_SECRET=xxx
FEISHU_HOST=https://open.feishu.cn
```

`APP_ID` and `APP_SECRET` are required. `FEISHU_HOST` is optional and defaults to `https://open.feishu.cn`.

`.env` is ignored by git. Do not commit real credentials.

## Loading Order

The CLI loads `.env` files from:

1. `--env-file <file>`, when provided.
2. The current working directory.
3. The CLI package checkout and its workspace root, when detectable.

This means commands such as `npm --prefix /path/to/feishu-md-sync exec -- md2feishu ...` can still load `/path/to/feishu-md-sync/.env` even when invoked from another directory.

Use `doctor auth` to confirm what was loaded without printing secrets:

```bash
npm exec -- md2feishu doctor auth --format json
```

## Permissions

For normal pull and push workflows, request these Feishu app API permissions. This list assumes the default official Markdown path and write-capable workflows.

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
| Read or write SDK reference Bitable audit records | `查看、评论、编辑和管理多维表格` |
| List docs in a Drive folder | `获取云空间文件夹下的云文档清单` |
| Create folders for SDK reference outputs | `创建云空间文件夹` |
| Copy reference documents | `复制云文档` |
| Move reference documents or folders | `移动云空间文件夹和云文档` |

API permissions are not enough by themselves. The app also needs resource access:

- For a docx target, add the app as a collaborator on the document. Use read access for pull-only workflows and edit access for write workflows.
- For a wiki target, the app needs node read access to resolve the wiki node, plus edit access to the underlying docx document when writing.
- For Drive folder operations, the app needs access to the folder. Creating, copying, or moving files requires edit access to the target folder.
- After changing app API permissions, publish or reinstall the app as required by the Feishu developer console so the new permissions take effect.
