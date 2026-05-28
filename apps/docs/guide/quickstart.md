# Quickstart

`md2feishu` is the CLI behind a set of Codex workflow skills for Feishu documentation work.

For normal team usage, install the workflow skills and ask Codex to run the workflow by task name. Use direct CLI commands when you are debugging, automating, or maintaining the tool.

## Install the workflow skills

From the repository root:

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

This installs:

- `feishu-baseline-sync`
- `feishu-reviewed-section-sync`
- `feishu-multisdk-examples`
- `feishu-sdk-reference-authoring`
- `feishu-sdk-reference-release`
- `feishu-release-notes`

After installation, ask Codex to use the matching workflow skill instead of memorizing command sequences.

Use `scripts/install-codex-skills.sh --remove-legacy` only when migrating a machine that previously installed the old alias skills.

## Choose a workflow

| Task | Skill | Workflow recipe |
| --- | --- | --- |
| Pull Feishu into Markdown before editing | `feishu-baseline-sync` | `md2feishu workflow show baseline-sync` |
| Publish one reviewed section | `feishu-reviewed-section-sync` | `md2feishu workflow show reviewed-section-sync` |
| Complete multi-SDK examples | `feishu-multisdk-examples` | `md2feishu workflow show multisdk-examples` |
| Author SDK reference changes on Feishu | `feishu-sdk-reference-authoring` | `md2feishu workflow show sdk-reference-authoring` |
| Release audited SDK references to `web-content` | `feishu-sdk-reference-release` | `md2feishu workflow show sdk-reference-web-content-release` |
| Audit release notes | `feishu-release-notes` | `md2feishu workflow show release-notes` |

See [Workflows](/guide/workflows) for the full workflow chooser.

## Direct CLI fallback

Use direct CLI commands when you need to inspect command behavior or run automation without Codex.

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
