# feishu-md-sync

Agent-oriented CLI and workflow toolkit for moving documentation between local Markdown, Feishu docs, and Milvus release processes.

`feishu-md-sync` is built for documentation work that is too risky to handle with copy/paste: Feishu-to-Markdown pulls, Markdown-to-Feishu sync, multi-SDK example completion, SDK reference publishing, and gated Milvus release notes updates.

The CLI defaults to dry-run behavior wherever writes are possible. Writes require explicit flags, receipts, approval gates, or workflow state depending on the command.

## Why This Exists

Milvus documentation work often crosses several systems:

- local Markdown files in `milvus-docs`;
- Feishu docx or wiki pages used as review/source documents;
- SDK source repositories and release tags;
- Agent Skills that encode repeatable documentation workflows.

This project gives AI agents a deterministic command surface for that work. The goal is not just to convert Markdown. The goal is to make documentation operations reviewable, resumable, and safe enough for team collaboration.

## What Agents Can Do With It

| Workflow | What the CLI helps the agent do |
| --- | --- |
| Pull Feishu to Markdown | Export a Feishu docx/wiki document into local Markdown for review, comparison, or downstream editing. |
| Sync Markdown to Feishu | Publish one local Markdown file to one existing Feishu document with dry-run-first conflict checks. |
| Complete multi-language examples | Use Python examples in a Feishu doc as the baseline, then verify and fill Java, JavaScript, Go, or RESTful examples by language. |
| Update SDK reference docs | Validate local SDK reference changes, publish approved docs to Feishu Drive, update/audit the release tracking Base, and prepare the downstream `web-content` diff. |
| Update Milvus release notes | Pull release notes from Feishu, scan SDK tags, audit `Variables.json` and user-doc links, then apply local docs changes through approval gates. |

Supporting capabilities such as `status`, `diff`, `merge`, `code-blocks`, and the Milvus publish profile exist to make those workflows safer. They are building blocks for agents, not separate product surfaces.

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

The CLI is intended to be run by an agent from a repository checkout:

```bash
npm install
npm run build
npm exec -- md2feishu --help
```

Typical agent loop:

```bash
npm exec -- md2feishu pull "$FEISHU_DOC" --output feishu.remote.md
npm exec -- md2feishu diff ./doc.md "$FEISHU_DOC"
npm exec -- md2feishu sync ./doc.md "$FEISHU_DOC"
```

Write commands stay explicit:

```bash
npm exec -- md2feishu sync ./doc.md "$FEISHU_DOC" --write --yes
```

Agents should only run write commands after the user confirms the generated diff, report, or dry-run output.

## Core Agent Workflows

### 1. Pull Feishu To Local Markdown

Use this when Feishu is the current source document and the agent needs a local Markdown snapshot.

```bash
md2feishu pull "$FEISHU_DOC" --output feishu.remote.md
```

This is commonly the first step before updating local Milvus docs from a Feishu review document.

### 2. Sync Local Markdown To Existing Feishu Docs

Use this when one local Markdown file should be synced to one existing Feishu document.

```bash
md2feishu status ./doc.md "$FEISHU_DOC"
md2feishu diff ./doc.md "$FEISHU_DOC"
md2feishu sync ./doc.md "$FEISHU_DOC"
md2feishu sync ./doc.md "$FEISHU_DOC" --write --yes
```

Useful supporting commands:

```bash
md2feishu merge ./doc.md "$FEISHU_DOC"
```

#### Milvus / Zilliz Cloud publishing profile

Use the Milvus publish profile when publishing shared Milvus docs content through Feishu:

```bash
md2feishu sync ./doc.md "$FEISHU_DOC" --publish-profile milvus
md2feishu diff ./doc.md "$FEISHU_DOC" --publish-profile milvus
md2feishu sync ./doc.md "$FEISHU_DOC" --publish-profile milvus --write --yes
```

The profile removes frontmatter, drops duplicate title headings, rewrites standalone `Milvus` product names to shared include tags, and wraps versioned names such as `Milvus 3.0` in Milvus-only include tags.

### 3. Complete Multi-SDK Examples By Language

Use this for Milvus user-guide pages that have Python examples and need verified Java, JavaScript, Go, or RESTful examples. The workflow is resumable and language-scoped.

```bash
md2feishu multisdk init "$FEISHU_DOC" --out runs/<doc-token>
md2feishu multisdk export runs/<doc-token> --language java
md2feishu multisdk verify runs/<doc-token> --language java --evidence evidence/java.log --command "mvn test"
md2feishu multisdk apply runs/<doc-token> --language java
md2feishu multisdk apply runs/<doc-token> --language java --write -y
md2feishu multisdk audit runs/<doc-token> --language java
md2feishu multisdk finalize runs/<doc-token>
```

The lower-level `code-blocks` commands remain available when an agent needs to inspect, export, apply, or audit Feishu code blocks directly.

### 4. Update SDK Reference Docs

Use this when an approved SDK reference impact matrix or manifest should publish docs to Feishu Drive, update the release tracking Base, and prepare the downstream `web-content` diff. For the full team runbook, see `docs-site/guide/sdk-reference-workflow.md`.

```bash
md2feishu reference preflight \
  --sdk java \
  --repo ~/sdk-doc-sync/repos/milvus-sdk-java \
  --version-line v3.0.x \
  --scan-state ~/sdk-doc-sync/.claude/skills/sdk-doc-sync/scan-state.json \
  --source-path sdk-core/src/main/java \
  --format json

md2feishu reference plan --impact impact.json --out reference-manifest.json
md2feishu reference apply --manifest reference-manifest.json
md2feishu reference apply --manifest reference-manifest.json --write -y
md2feishu reference audit --manifest reference-manifest.json
md2feishu reference export \
  --manifest reference-manifest.json \
  --web-content-repo /Volumes/web-content-cs/web-content-java-v30 \
  --manual java-v3.0.x \
  --config scripts/config.json \
  --scope changed \
  --skip-image-down \
  --out runs/reference/java-v3.0.x/web-content-export.json
```

The expected flow is: verify source freshness against the official SDK tags, verify locally, generate a manifest, dry-run publish, write approved docs to Feishu Drive/Base, audit the result, then export the audited Feishu docs into a `web-content` checkout for PR review. A `NO ACTION` reference plan must include source freshness evidence (`baselineTag`, `latestTag`, and diff evidence when they differ); this prevents stale local scan state from being mistaken for an up-to-date SDK line.

`reference export` wraps `web-content/scripts/lark-docs/index.js`. It validates that `scripts/config.json` contains the requested manual, reads the Feishu source Base and output directory, runs changed-doc or full-manual export, checks `git diff --check`, and reports related changed files, untracked generated files, unrelated dirty files, and suggested staging paths. It does not stage, commit, push, or open pull requests.

Use a case-sensitive `web-content` checkout or worktree on macOS. The export command fails closed if it detects case-conflicting tracked paths on a case-insensitive filesystem.

### 5. Update Milvus Release Notes

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

## Agent Skills

The repository documents focused Agent Skills in `docs-site/agent/skills/`. These are playbooks for agents. The CLI remains the deterministic engine.

| Skill | Use it when |
| --- | --- |
| `feishu-markdown-pull` | Exporting Feishu docx/wiki documents into local Markdown. |
| `feishu-markdown-push` | Publishing local Markdown to existing Feishu documents with dry-run and conflict checks. |
| `feishu-codeblock-writer` | Directly inspecting, exporting, applying, or auditing Feishu code blocks outside the multi-SDK workflow. |
| `sdk-source-verifier` | Confirming SDK feature support from source code, tests, tags, or commits. |
| `sdk-reference-publisher` | Publishing approved SDK reference docs to Feishu Drive/Bitable and preparing the downstream `web-content` diff. |
| `milvus-multisdk-example-sync` | Completing Milvus user-guide examples across Java, JavaScript, Go, and RESTful. |
| `milvus-release-notes-workflow` | Updating Milvus release notes, Variables, SDK version values, and release-note user-doc links from Feishu source docs. |

Skill boundaries matter:

- Feishu Markdown pull must not write Feishu.
- Feishu Markdown push must not patch individual code blocks.
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
- SDK reference workflow guide;
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
