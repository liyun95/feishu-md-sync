# Configuration

`md2feishu` reads Feishu credentials from environment variables.

## Required Variables

```bash
APP_ID=...
APP_SECRET=...
FEISHU_HOST=https://open.feishu.cn
```

`FEISHU_HOST` defaults to `https://open.feishu.cn` when omitted.

## Local `.env`

The CLI loads `.env` files from:

1. `--env-file <file>`, when provided.
2. The current working directory.
3. The CLI package checkout and its workspace root, when detectable.

This means commands such as `npm --prefix /path/to/feishu-md-sync exec -- md2feishu ...` can still load `/path/to/feishu-md-sync/.env` even when invoked from another directory.

```bash
APP_ID=cli_xxx
APP_SECRET=xxx
FEISHU_HOST=https://open.feishu.cn
```

`.env` is ignored by git.

Use `doctor auth` to confirm what was loaded without printing secrets:

```bash
md2feishu doctor auth --format json
```

## Permissions

The Feishu app must be allowed to read and write the target docx document. If the target is a wiki URL, the app also needs permission to resolve the wiki node to a docx token.
