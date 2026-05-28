---
name: sdk-source-verifier
description: Use when SDK feature support must be confirmed from source code, tests, tags, or commits.
---

# SDK Source Verifier

Use this skill before writing SDK examples or reference updates. Published Milvus docs are not source of truth for this workflow.

Source locations:

- Java: `https://github.com/milvus-io/milvus-sdk-java`
- JavaScript/Node: `https://github.com/milvus-io/milvus-sdk-node`
- Go: Milvus monorepo `client/`
- REST: OpenAPI, server route, or server tests
- Python: `pymilvus`

Output a support matrix with source paths or URLs, commit/tag, minimal API usage, and verification result or plan. For Go `client/v2@master`, run inside the Milvus source `client/` module when repo-local replacements are required.

Do not write Feishu docs, Bitable records, or code blocks. Hand off approved reference-writing evidence to `feishu-sdk-reference-authoring`; use `feishu-sdk-reference-release` only after explicit human release intent.
