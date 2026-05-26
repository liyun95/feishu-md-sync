# Skill Roadmap

V1 splits Feishu documentation work into focused skills instead of one generic sync skill.

## V1 Skills

- `feishu-markdown-sync`: whole-document Markdown sync with receipts, status, diff, pull, merge, and sync.
- `feishu-codeblock-writer`: inspect, plan, export, apply, and audit code blocks inside an existing Feishu document.
- `sdk-source-verifier`: confirm SDK support from source, tags, tests, and commits.
- `sdk-reference-publisher`: publish SDK reference docs to Feishu Drive and Bitable from approved manifests.
- `milvus-multisdk-example-sync`: orchestrate Milvus user-guide multi-SDK example completion from Python baselines.

## Boundaries

Whole-document sync must not patch individual code blocks. Code-block writes must not judge SDK correctness. SDK source verification must not write Feishu. SDK reference publishing must not scan source or infer doc impact. Milvus multi-SDK workflow composes source verification and code-block writing.

## Follow-Ups

- Install repo skill templates into the team Codex skill root.
- Add durable receipts for code-block manifests.
- Expand reference audit coverage for table creation and post-action scripts.
- Add live Feishu smoke tests against approved disposable docs, folders, and Bases.
