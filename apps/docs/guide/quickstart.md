# Quickstart

`md2feishu` is the CLI behind a set of Codex workflow skills for Feishu documentation work.

For normal team usage, install the workflow skills and ask Codex to run the workflow by task name. The CLI stays available when you need exact command control for debugging, automation, or maintenance.

## Get the repository

Clone the repo and install from its root:

```bash
git clone https://github.com/liyun95/feishu-md-sync.git
cd feishu-md-sync
```

## Install workflow skills

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

This installs the workflow skills used by Codex:

| Skill | What it is for |
| --- | --- |
| [`feishu-baseline-sync`](/agent/skills/feishu-baseline-sync) | Pull a remote Feishu document into local Markdown before editing. |
| [`feishu-reviewed-section-sync`](/agent/skills/feishu-reviewed-section-sync) | Sync one reviewed local Markdown section back to the matching Feishu section. |
| [`feishu-multisdk-examples`](/agent/skills/feishu-multisdk-examples) | Complete and validate Java, JavaScript, Go, or REST examples from a source example. |
| [`feishu-sdk-reference-authoring`](/agent/skills/feishu-sdk-reference-authoring) | Write and audit SDK reference changes in Feishu. |
| [`feishu-sdk-reference-release`](/agent/skills/feishu-sdk-reference-release) | Release audited SDK reference content into `web-content` after a human starts release. |
| [`feishu-release-notes`](/agent/skills/feishu-release-notes) | Audit release notes and apply approved local docs changes. |

After installation, ask Codex to use the matching workflow skill instead of memorizing command sequences.

## Configure Feishu access

Before the first pull or write, copy the example environment file and fill in your Feishu app credentials:

```bash
cp .env.example .env
```

```bash
APP_ID=cli_xxx
APP_SECRET=xxx
FEISHU_HOST=https://open.feishu.cn
```

Then confirm the CLI can load the credentials:

```bash
npm exec -- md2feishu doctor auth --format json
```

The Feishu app also needs API permissions and access to the target document. See [Configuration](/guide/configuration) for the minimum permission list and resource access notes.

## Choose a workflow

| When you need to... | Use this skill | What the workflow does |
| --- | --- | --- |
| Pull a remote Feishu document into local Markdown before making edits | `feishu-baseline-sync` | Exports the current Feishu content to a local baseline file. It does not write back to Feishu. |
| Sync reviewed local Markdown changes back to the remote Feishu document | `feishu-reviewed-section-sync` | Replaces one uniquely named section after a dry-run and approval. Content outside that section is preserved. |
| Complete missing SDK examples across languages | `feishu-multisdk-examples` | Generates, validates, and applies language-scoped code-block updates for selected SDKs. |
| Write SDK reference changes in Feishu | `feishu-sdk-reference-authoring` | Plans, writes, and audits Feishu reference content. It stops after the Feishu audit. |
| Move audited SDK reference content into `web-content` | `feishu-sdk-reference-release` | Starts only after a human asks for release, then prepares the external docs repository handoff. |
| Audit release notes before docs apply | `feishu-release-notes` | Checks SDK tags, Variables usage, and user-doc links before applying approved local docs changes. |

See [Workflows](/guide/workflows) for the full workflow chooser and exact approval points.

## Direct CLI fallback

Use direct CLI commands when you need to inspect command behavior or run automation without Codex.

Run a dry-run:

```bash
npm exec -- md2feishu sync ./doc.md DocToken
```

Write after inspecting the plan:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --write --yes
```

## Supported Targets

Use any of these forms:

```bash
npm exec -- md2feishu sync ./doc.md DocToken
npm exec -- md2feishu sync ./doc.md https://example.feishu.cn/docx/DocToken
npm exec -- md2feishu sync ./doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```
