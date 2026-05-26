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

The CLI loads `dotenv/config`, so a local `.env` file works during development:

```bash
APP_ID=cli_xxx
APP_SECRET=xxx
FEISHU_HOST=https://open.feishu.cn
```

`.env` is ignored by git.

## Permissions

The Feishu app must be allowed to read and write the target docx document. If the target is a wiki URL, the app also needs permission to resolve the wiki node to a docx token.
