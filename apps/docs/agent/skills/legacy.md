# Legacy Skill Aliases

These older operation-specific skills are replaced by workflow skills. Do not install them for new team usage.

| Legacy skill | Replacement workflow skill |
| --- | --- |
| `feishu-markdown-pull` | `feishu-baseline-sync` |
| `feishu-markdown-push` | `feishu-section-sync` for section-scoped Feishu writes; workflow registry for other sync cases |
| `feishu-reviewed-section-sync` | `feishu-section-sync` |
| `feishu-codeblock-writer` | `feishu-multisdk-examples` when completing SDK examples; low-level code-block operations only when explicitly requested |
| `milvus-multisdk-example-sync` | `feishu-multisdk-examples` |
| `sdk-reference-publisher` | `feishu-sdk-reference-authoring`; `feishu-sdk-reference-release` only after explicit human release intent |
| `milvus-release-notes-workflow` | `feishu-release-notes` |

New users should install with `scripts/install-codex-skills.sh`.

If a machine already has these aliases installed, run `scripts/install-codex-skills.sh --remove-legacy` once to install the workflow skills and remove the aliases from the local Codex skill root.
