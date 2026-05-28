# Legacy Skill Aliases

These older operation-specific skill pages are retained only as compatibility aliases. New agent work should use workflow skills.

| Legacy skill | Replacement workflow skill |
| --- | --- |
| `feishu-markdown-pull` | `feishu-baseline-sync` |
| `feishu-markdown-push` | `feishu-reviewed-section-sync` for partial reviewed-doc writes; workflow registry for other sync cases |
| `feishu-codeblock-writer` | `feishu-multisdk-examples` when completing SDK examples; low-level code-block operations only when explicitly requested |
| `milvus-multisdk-example-sync` | `feishu-multisdk-examples` |
| `sdk-reference-publisher` | `feishu-sdk-reference-authoring`; `feishu-sdk-reference-release` only after explicit human release intent |
| `milvus-release-notes-workflow` | `feishu-release-notes` |
