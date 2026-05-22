---
name: sdk-reference-publisher
description: Use when publishing approved SDK reference docs to Feishu Drive and Bitable from a manifest or impact matrix.
---

# SDK Reference Publisher

Use this skill for SDK reference Drive and Bitable publishing. It owns `md2feishu reference plan`, `apply`, and `audit`.

Workflow:

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
```

The release audit Base must already exist and be shared with the Feishu app. Manifests with tracker rows must include `targets.releaseAuditBaseToken`. The CLI may create or update tables inside that Base, but it must not create a new Base. If the token is missing or inaccessible, stop before writes and tell the user to create/select the shared Base and grant app access.

Guardrails:

- Never write the SDK reference Bitable `Slug` field.
- For version-targeted updates, copy the doc into the target version folder before patching and before repointing Bitable.
- Do not patch older-version source docs in place.
- Run readback audit after writes.
- Use `/Users/liyun/sdk-doc-sync` post-action scripts only when the manifest explicitly requests them.

Use `sdk-source-verifier` for source truth, `feishu-codeblock-writer` for local user-guide code blocks, and `feishu-markdown-sync` for ordinary whole-document sync.
