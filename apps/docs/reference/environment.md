# Environment Variables

`feishu-md-sync` reads `.env` from the current directory and, when invoked from a checkout, from the CLI workspace root. The CLI uses the official `lark-cli` for Feishu IO, so authentication lives in `lark-cli`, not in this project's `.env`.

Do not put Feishu App ID or App Secret in this project's `.env`. Configure those credentials through `lark-cli`; use this project's environment only for local sync defaults such as identity selection.

For normal setup, copy `.env.example` to `.env`; see [Configuration](/guide/configuration). Run `feishu-md-sync doctor auth` to see which files were checked and which `lark-cli` identity will be requested.

## `FEISHU_MD_SYNC_LARK_AS`

Optional identity selector passed through to `lark-cli`.

Allowed values:

- `bot`
- `user`

When unset, `feishu-md-sync` lets `lark-cli` choose its default identity.

Use `bot` for CI and app-token based live tests when the bot has document access.

In GitHub Actions, prefer test-specific secrets such as `LARK_TEST_APP_ID` and `LARK_TEST_APP_SECRET`, then map them to `LARK_APP_ID` and `LARK_APP_SECRET` only inside the `lark-cli` setup step.

## `VITEPRESS_BASE`

Docs build base path used by VitePress.

For GitHub Pages project sites, the workflow should set:

```bash
VITEPRESS_BASE=/${{ github.event.repository.name }}/
```
