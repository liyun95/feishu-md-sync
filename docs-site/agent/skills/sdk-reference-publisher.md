---
name: sdk-reference-publisher
description: Use when approved SDK reference changes need local verification, Feishu Drive publishing, Bitable/Base tracking, or readback audit.
---

# SDK Reference Publisher

Use this skill for the SDK reference update workflow after source truth and doc impact are known. It owns `md2feishu reference plan`, `apply`, and `audit`.

Expected flow:

1. Verify the local SDK reference changes and source evidence.
2. Generate or consume an approved reference manifest.
3. Dry-run the Feishu Drive/Bitable publish.
4. Write approved docs to Feishu Drive and update the release tracking Base.
5. Run readback audit.

Commands:

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
```

The release audit Base must already exist and be shared with the Feishu app. Manifests with tracker rows must include `targets.releaseAuditBaseToken`. The CLI may create or update tables inside that Base, but it must not create a new Base. If the token is missing or inaccessible, stop before writes and tell the user to create/select the shared Base and grant app access.

Guardrails:

- Do not infer SDK API support; require source evidence or an approved impact matrix.
- Never write the SDK reference Bitable `Slug` field.
- For version-targeted updates, copy the doc into the target version folder before patching and before repointing Bitable.
- Do not patch older-version source docs in place.
- Run readback audit after writes.
- Use `/Users/liyun/sdk-doc-sync` post-action scripts only when the manifest explicitly requests them.

Use `sdk-source-verifier` for source truth, `feishu-codeblock-writer` for direct user-guide code blocks, `feishu-markdown-pull` for Feishu-to-Markdown export, and `feishu-markdown-push` for ordinary whole-document publishing.
