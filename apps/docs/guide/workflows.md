# Workflows

Use workflows instead of memorizing command combinations.

```bash
md2feishu workflow list
md2feishu workflow show <workflow-id>
```

| Workflow | Use when | Starts with |
| --- | --- | --- |
| `baseline-sync` | Pull current Feishu content into local Markdown before editing. | `md2feishu workflow show baseline-sync` |
| `reviewed-section-sync` | Replace one reviewed Feishu section from local Markdown. | `md2feishu workflow show reviewed-section-sync` |
| `multisdk-examples` | Complete and validate Java, JavaScript, Go, or REST examples from Python examples. | `md2feishu workflow show multisdk-examples` |
| `sdk-reference-authoring` | Plan, write, and audit SDK reference changes on Feishu. | `md2feishu workflow show sdk-reference-authoring` |
| `sdk-reference-web-content-release` | Release audited SDK reference docs to `web-content` after human approval. | `md2feishu workflow show sdk-reference-web-content-release` |
| `release-notes` | Audit and apply Milvus release-note changes. | `md2feishu workflow show release-notes` |

Workflow details are generated from the CLI registry. If this page and CLI output disagree, update this page or the registry in the same change.
