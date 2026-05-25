---
name: sdk-reference-publisher
description: Use when approved SDK reference changes need local verification, Feishu Drive publishing, Bitable/Base tracking, readback audit, or web-content export handoff.
---

# SDK Reference Publisher

Use this skill for the SDK reference update workflow after source truth and doc impact are known. It owns `md2feishu reference plan`, `apply`, `audit`, and the `export` handoff into `web-content`.

For the full team runbook, see `docs-site/guide/sdk-reference-workflow.md`.

Expected flow:

1. Verify the local SDK reference changes and source evidence.
2. Generate or consume an approved reference manifest.
3. Dry-run the Feishu Drive/Bitable publish.
4. Write approved docs to Feishu Drive and update the release tracking Base.
5. Run readback audit.
6. Export audited Feishu docs into a `web-content` checkout and review the generated diff before creating a fork PR.

Commands:

```bash
md2feishu reference preflight --sdk java --repo ~/sdk-doc-sync/repos/milvus-sdk-java --version-line v3.0.x --scan-state ~/sdk-doc-sync/.claude/skills/sdk-doc-sync/scan-state.json --source-path sdk-core/src/main/java --format json
md2feishu reference plan --impact impact.json --out reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --format json
md2feishu reference apply --manifest reference-manifest.json --write -y --format json
md2feishu reference audit --manifest reference-manifest.json --format json
md2feishu reference export --manifest reference-manifest.json --web-content-repo /Volumes/web-content-cs/web-content-java-v30 --manual java-v3.0.x --config scripts/config.json --scope changed --skip-image-down --out runs/reference/java-v3.0.x/web-content-export.json --format json
```

The release audit Base must already exist and be shared with the Feishu app. Manifests with tracker rows must include `targets.releaseAuditBaseToken`. The CLI may create or update tables inside that Base, but it must not create a new Base. If the token is missing or inaccessible, stop before writes and tell the user to create/select the shared Base and grant app access.

Guardrails:

- Do not infer SDK API support; require source evidence or an approved impact matrix.
- Before accepting `NO ACTION`, verify source freshness against the official SDK tags. No-action impact matrices must include `source.baselineTag`, `source.latestTag`, and diff evidence when the tags differ.
- Never write the SDK reference Bitable `Slug` field.
- For version-targeted updates, copy the doc into the target version folder before patching and before repointing Bitable.
- Do not patch older-version source docs in place.
- Run readback audit after writes.
- Use a case-sensitive `web-content` checkout or worktree on macOS. The export command fails closed when case-conflicting tracked paths are present on a case-insensitive filesystem.
- Treat SDK reference work as complete only after Feishu audit passes, the web-content export diff is reviewed, and a fork PR is created when site content changed.
- `reference export` must not stage, commit, push, or open pull requests. Use the reported suggested staging paths as a handoff, and keep unrelated generated noise out of the PR.
- Never push directly to `upstream`; publish site changes from a fork branch.
- Use `/Users/liyun/sdk-doc-sync` post-action scripts only when the manifest explicitly requests them.

Use `sdk-source-verifier` for source truth, `feishu-codeblock-writer` for direct user-guide code blocks, `feishu-markdown-pull` for Feishu-to-Markdown export, and `feishu-markdown-push` for ordinary whole-document publishing.
