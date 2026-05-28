---
name: sdk-reference-publisher
description: Use when approved SDK reference changes need local verification, Feishu Drive publishing, Bitable/Base tracking, readback audit, or web-content export handoff.
---

# SDK Reference Publisher

> Legacy alias: use `feishu-sdk-reference-authoring` for Feishu writing/audit. Use `feishu-sdk-reference-release` only after the user explicitly starts web-content release.

This page is retained for compatibility with older agent prompts. Do not add workflow logic here.

For Feishu authoring, load:

```bash
md2feishu workflow show sdk-reference-authoring --format json
```

For web-content release, require explicit human release intent, then load:

```bash
md2feishu workflow show sdk-reference-web-content-release --format json
```

Shared write gates live in [Safety Gates](/reference/safety-gates).
