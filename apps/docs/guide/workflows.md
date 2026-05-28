# Choose a Workflow

Use workflow skills instead of memorizing command combinations. Each skill loads the matching CLI workflow recipe and follows the safety gates for that task.

```bash
md2feishu workflow list
md2feishu workflow show <workflow-id>
```

| User task | Skill | Workflow ID | Writes to | Human approval point |
| --- | --- | --- | --- | --- |
| Pull or refresh a remote Feishu doc into local Markdown | `feishu-baseline-sync` | `baseline-sync` | Local Markdown only | Before any later Feishu write |
| Sync one local Markdown section back to Feishu | `feishu-section-sync` | `section-sync` | One Feishu section | Before `--write` |
| Complete multi-language SDK examples | `feishu-multisdk-examples` | `multisdk-examples` | Feishu code blocks | Before applying validated snippets |
| Write and audit SDK reference changes in Feishu | `feishu-sdk-reference-authoring` | `sdk-reference-authoring` | Feishu docs and Bitable artifacts | Before Feishu apply |
| Release audited SDK reference docs to `web-content` | `feishu-sdk-reference-release` | `sdk-reference-web-content-release` | External `web-content` checkout | At workflow start; this is a separate human-triggered release |
| Audit and apply release-note changes | `feishu-release-notes` | `release-notes` | Local docs checkout | Before applying an approved report hash |

## How to ask Codex

Use the task name and the target document or task directory:

```text
Use feishu-baseline-sync on this Feishu document and write a local remote-copy Markdown file for review.
```

```text
Use feishu-section-sync to update only the section named "Index type overview" from my local Markdown.
```

```text
Use feishu-sdk-reference-authoring for this SDK reference change. Stop after the Feishu audit.
```

```text
Use feishu-sdk-reference-release for the audited reference manifest. This is a human-approved release to web-content.
```

## Direct CLI usage

The CLI recipe is still available when you need exact commands:

```bash
md2feishu workflow show baseline-sync
md2feishu workflow show section-sync
md2feishu workflow show multisdk-examples
md2feishu workflow show sdk-reference-authoring
md2feishu workflow show sdk-reference-web-content-release
md2feishu workflow show release-notes
```

Workflow details are generated from the CLI registry. If this page and CLI output disagree, update this page or the registry in the same change.
