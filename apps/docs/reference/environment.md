# Environment Variables

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
