# Skill Roadmap

V2 maps each first-class workflow to one obvious skill. The CLI workflow registry remains the source of truth:

```bash
md2feishu workflow list
md2feishu workflow show <workflow-id> --format json
```

## V1 Skills

These operation-specific skills are becoming legacy aliases:

- `feishu-markdown-pull`: export Feishu docx/wiki documents into local Markdown.
- `feishu-markdown-push`: publish local Markdown to existing Feishu documents with receipts, status, diff, merge, and sync.
- `feishu-codeblock-writer`: directly inspect, plan, export, apply, and audit code blocks inside an existing Feishu document.
- `sdk-source-verifier`: confirm SDK support from source, tags, tests, and commits.
- `sdk-reference-publisher`: publish SDK reference docs to Feishu Drive and Bitable from approved manifests.
- `milvus-multisdk-example-sync`: orchestrate Milvus user-guide multi-SDK example completion from Python baselines.
- `milvus-release-notes-workflow`: orchestrate Milvus release notes, Variables, SDK version values, and release-note user-doc links from Feishu source documents.

## Boundaries

Feishu Markdown pull must not write Feishu. Feishu Markdown push must not patch individual code blocks. Code-block writes must not judge SDK correctness. SDK source verification must not write Feishu. SDK reference publishing must not scan source or infer doc impact. Milvus multi-SDK workflow composes source verification and code-block writing. Milvus release notes workflow composes the release CLI, Feishu Markdown pull/push, and SDK source verification; it must not bypass approval before local `--write`.

## Workflow Skill Pressure Scenarios

- Baseline sync: agent must not write to Feishu after pull unless the user switches workflows.
- Reviewed section sync: agent must not use whole-document write when the user asks for one section.
- Multi-SDK examples: agent must not write unverified snippets.
- SDK reference authoring: agent must stop after Feishu audit and must not export to `web-content`.
- SDK reference release: agent must require explicit human release intent before touching `web-content`.
- Release notes: agent must not apply local docs changes without approval of the current report hash.

## Follow-Ups

- Install repo skill templates into the team Codex skill root.
- Add durable receipts for code-block manifests.
- Expand reference audit coverage for table creation and post-action scripts.
- Add live Feishu smoke tests against approved disposable docs, folders, and Bases.
