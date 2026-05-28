# Environment Variables

`md2feishu` reads `.env` from the current directory and, when invoked from a checkout, from the CLI workspace root. For normal setup, copy `.env.example` to `.env`; see [Configuration](/guide/configuration). Use the global `--env-file <file>` option for an explicit credentials file. Run `md2feishu doctor auth` to see which files were checked and whether credentials are present.

## `APP_ID`

Feishu app ID.

Required for real Feishu API calls.

## `APP_SECRET`

Feishu app secret.

Required for real Feishu API calls.

## `FEISHU_HOST`

Feishu API host.

Default:

```text
https://open.feishu.cn
```

## `VITEPRESS_BASE`

Docs build base path used by VitePress.

For GitHub Pages project sites, the workflow should set:

```bash
VITEPRESS_BASE=/${{ github.event.repository.name }}/
```
