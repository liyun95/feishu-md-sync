# Quickstart

`md2feishu` syncs one local Markdown file to one existing Feishu docx document.

The CLI is safe by default: commands run as dry-runs unless you pass `--write`.

## Choose a workflow

- Pull Feishu into Markdown: `md2feishu workflow show baseline-sync`
- Publish one reviewed section: `md2feishu workflow show reviewed-section-sync`
- Complete multi-SDK examples: `md2feishu workflow show multisdk-examples`
- Author SDK reference changes on Feishu: `md2feishu workflow show sdk-reference-authoring`
- Release audited SDK references to web-content: `md2feishu workflow show sdk-reference-web-content-release`
- Audit release notes: `md2feishu workflow show release-notes`

See [Workflows](/guide/workflows) for the shared workflow index.

## Install Locally

From the repository root:

```bash
npm install
npm run build
npm exec -- md2feishu --help
```

For Codex users, install the workflow skills as the normal team entry point:

```bash
scripts/install-codex-skills.sh
```

After this, users can ask Codex for the workflow by name instead of learning the underlying command sequence.

Use `scripts/install-codex-skills.sh --remove-legacy` only when migrating a machine that previously installed the old alias skills.

During development, the most reliable command form is:

```bash
npm exec -- md2feishu <command>
```

After linking the package locally:

```bash
npm link
md2feishu --help
```

## Minimal Workflow

Set credentials:

```bash
export APP_ID=...
export APP_SECRET=...
export FEISHU_HOST=https://open.feishu.cn
```

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
