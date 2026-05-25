# feishu-md-sync

Agent-friendly CLI and workflow toolkit for moving documentation between local Markdown, Feishu docs, and Milvus release processes.

`feishu-md-sync` is built for documentation work that is too risky to handle with copy/paste: whole-doc Markdown sync, code-block-only Feishu edits, multi-SDK example completion, SDK reference publishing, and gated Milvus release notes updates.

The CLI defaults to dry-run behavior wherever writes are possible. Writes require explicit flags, receipts, approval gates, or workflow state depending on the command.

## Why This Exists

Milvus documentation work often crosses several systems:

- local Markdown files in `milvus-docs`;
- Feishu docx or wiki pages used as review/source documents;
- SDK source repositories and release tags;
- Agent Skills that encode repeatable documentation workflows.

This project gives humans and AI agents a shared command surface for that work. The goal is not just to convert Markdown. The goal is to make documentation operations reviewable, resumable, and safe enough for team collaboration.

## Features

| Area | What it provides |
| --- | --- |
| Markdown sync | Sync one local Markdown file to one existing Feishu docx document with dry-run-first writes. |
| Pull and diff | Export current Feishu content as Markdown, compare local vs remote, and inspect sync status. |
| Conflict handling | Detect remote changes with receipts and generate `.merged.md` files for manual resolution. |
| Milvus publish profile | Strip frontmatter, normalize product naming, and prepare Milvus docs for Feishu/Zilliz Cloud publishing. |
| Code-block workflows | Inspect, export, update, apply, and audit code blocks without rewriting the whole Feishu document. |
| Multi-SDK workflow | Run resumable Java, JavaScript, Go, and RESTful example completion from a Python baseline. |
| Release notes workflow | Pull Feishu release notes, scan SDK tags, audit Variables/user-doc links, approve reports, and apply local docs changes through gates. |
| SDK reference publishing | Convert approved SDK reference manifests into Feishu Drive/Bitable publish and audit operations. |
| Agent Skills | Repo-documented playbooks for agents, each with clear boundaries and source-of-truth rules. |

## Installation

### Requirements

- Node.js 20+
- Feishu app credentials for real Feishu calls

```bash
APP_ID=...
APP_SECRET=...
FEISHU_HOST=https://open.feishu.cn
```

### From This Repository

```bash
npm install
npm run build
npm exec -- md2feishu --help
```

During development, prefer:

```bash
npm exec -- md2feishu <command>
```

To use `md2feishu` directly from any directory:

```bash
npm link
md2feishu --help
```

## Quick Start

### Human Users

Pull a Feishu document into Markdown:

```bash
md2feishu pull "$FEISHU_DOC" --output feishu.remote.md
```

Preview a local Markdown sync:

```bash
md2feishu sync ./doc.md "$FEISHU_DOC"
```

Write only after reviewing the dry-run:

```bash
md2feishu sync ./doc.md "$FEISHU_DOC" --write --yes
```

### AI Agents

Use deterministic commands and keep writes gated:

```bash
npm exec -- md2feishu status ./doc.md "$FEISHU_DOC" --format json
npm exec -- md2feishu diff ./doc.md "$FEISHU_DOC"
npm exec -- md2feishu sync ./doc.md "$FEISHU_DOC"
```

Only run write commands after the user confirms the generated diff or report.

## Core Workflows

### Whole-Document Markdown Sync

Use this when one local Markdown file should be synced to one existing Feishu document.

```bash
md2feishu sync ./doc.md "$FEISHU_DOC"
md2feishu sync ./doc.md "$FEISHU_DOC" --write --yes
```

Useful supporting commands:

```bash
md2feishu status ./doc.md "$FEISHU_DOC"
md2feishu diff ./doc.md "$FEISHU_DOC"
md2feishu pull "$FEISHU_DOC" --output feishu.remote.md
md2feishu merge ./doc.md "$FEISHU_DOC"
```

### Milvus / Zilliz Cloud Publishing

Use the Milvus publish profile when publishing shared Milvus docs content through Feishu:

```bash
md2feishu sync ./doc.md "$FEISHU_DOC" --publish-profile milvus
md2feishu diff ./doc.md "$FEISHU_DOC" --publish-profile milvus
md2feishu sync ./doc.md "$FEISHU_DOC" --publish-profile milvus --write --yes
```

The profile removes frontmatter, drops duplicate title headings, rewrites standalone `Milvus` product names to shared include tags, and wraps versioned names such as `Milvus 3.0` in Milvus-only include tags.

### Code-Block-Only Feishu Updates

Use this when the Feishu document is the source of truth and only code blocks should change.

```bash
md2feishu code-blocks inspect "$FEISHU_DOC" --format json
md2feishu code-blocks export "$FEISHU_DOC" --out ./snippets --manifest manifest.json --expect java,javascript,go,restful
md2feishu code-blocks apply "$FEISHU_DOC" --manifest manifest.json
md2feishu code-blocks apply "$FEISHU_DOC" --manifest manifest.json --write -y
md2feishu code-blocks audit "$FEISHU_DOC" --expect java,javascript,go,restful --format json
```

### Multi-SDK Example Completion

Use this for Milvus user-guide pages that have Python examples and need verified Java, JavaScript, Go, or RESTful examples.

```bash
md2feishu multisdk init "$FEISHU_DOC" --out runs/<doc-token>
md2feishu multisdk export runs/<doc-token> --language java
md2feishu multisdk verify runs/<doc-token> --language java --evidence evidence/java.log --command "mvn test"
md2feishu multisdk apply runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java --write -y
md2feishu multisdk audit runs/<doc-token> --language java
md2feishu multisdk finalize runs/<doc-token>
```

### Release Notes Workflow

Use this for Milvus release notes updates that start from a Feishu release-note document and need Variables/user-doc link checks.

```bash
md2feishu release init \
  --release-line 2.6.x \
  --version 2.6.17 \
  --release-doc "$RELEASE_DOC" \
  --milvus-docs ~/milvus-docs \
  --out runs/releases/2.6.17

md2feishu release pull runs/releases/2.6.17
md2feishu release scan-sdk-tags runs/releases/2.6.17
md2feishu release audit runs/releases/2.6.17
```

Review `runs/releases/2.6.17/audit/report.md`, then approve and dry-run apply:

```bash
md2feishu release approve runs/releases/2.6.17 --by "$USER"
md2feishu release apply runs/releases/2.6.17
md2feishu release apply runs/releases/2.6.17 --write
```

`release apply --write` requires a passing report, approval of the current report hash, and a successful dry-run. Existing release sections are merged conservatively: local release dates, SDK tables, and user-doc links are preserved.

### SDK Reference Publishing

Use this when an approved SDK reference impact matrix or manifest should publish docs to Feishu Drive and Bitable.

```bash
md2feishu reference plan --impact impact.json --out reference-manifest.json
md2feishu reference apply --manifest reference-manifest.json
md2feishu reference apply --manifest reference-manifest.json --write -y
md2feishu reference audit --manifest reference-manifest.json
```

## Agent Skills

The repository documents focused Agent Skills in `docs-site/agent/skills/`. These are playbooks for agents. The CLI remains the deterministic engine.

| Skill | Use it when |
| --- | --- |
| `feishu-markdown-sync` | Syncing a whole local Markdown file with a Feishu document. |
| `feishu-codeblock-writer` | Updating or auditing code blocks inside an existing Feishu document. |
| `sdk-source-verifier` | Confirming SDK feature support from source code, tests, tags, or commits. |
| `sdk-reference-publisher` | Publishing approved SDK reference docs to Feishu Drive and Bitable. |
| `milvus-multisdk-example-sync` | Completing Milvus user-guide examples across Java, JavaScript, Go, and RESTful. |
| `milvus-release-notes-workflow` | Updating Milvus release notes, Variables, SDK version values, and release-note user-doc links from Feishu source docs. |

Skill boundaries matter:

- Whole-document sync must not patch individual code blocks.
- Code-block workflows must not decide SDK correctness.
- SDK source verification must not write Feishu docs.
- Release notes workflow must not bypass report approval before local `--write`.

## Documentation Site

Run locally:

```bash
npm run docs:dev
```

Build:

```bash
npm run docs:build
```

The docs site includes:

- command reference;
- sync and merge workflows;
- multi-SDK workflow guide;
- release workflow guide;
- Agent Skill pages;
- architecture and testing notes.

## Safety Model

`md2feishu` is intentionally fail-closed:

- Sync writes default to dry-run.
- Real Feishu writes require `--write` plus confirmation or `--yes`.
- Whole-document sync stores receipts under `.sync/feishu/`.
- Remote changes are detected before writes.
- Merge workflows produce `.merged.md` instead of silently overwriting conflicts.
- Multi-SDK writes require validation evidence and dry-run state.
- Release writes require audit, report approval, dry-run state, and a passing report.
- The CLI never commits, pushes, or opens pull requests.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run docs:build
```

Generated outputs such as `dist/`, `coverage/`, `.sync/`, and local task directories under `runs/` should not be committed unless explicitly intended.

## License

MIT. See `NOTICE`.
