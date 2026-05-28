# feishu-md-sync

Feishu documentation workflows for Codex and the `md2feishu` CLI.

Use this repo when a Feishu document needs to be pulled into Markdown, updated by a reviewed section, filled with multi-SDK examples, or moved through SDK reference and release-note workflows. The recommended team path is Skill-first: install the Codex workflow skills, then ask Codex to run the workflow that matches the task.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Quickstart

From the repository root:

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

This installs the workflow skills:

- `feishu-baseline-sync`
- `feishu-reviewed-section-sync`
- `feishu-multisdk-examples`
- `feishu-sdk-reference-authoring`
- `feishu-sdk-reference-release`
- `feishu-release-notes`

After installation, ask Codex to use the matching skill instead of memorizing command sequences.

## Choose a workflow

| Task | Skill | Workflow recipe |
| --- | --- | --- |
| Pull Feishu into Markdown before editing | `feishu-baseline-sync` | `md2feishu workflow show baseline-sync` |
| Publish one reviewed section | `feishu-reviewed-section-sync` | `md2feishu workflow show reviewed-section-sync` |
| Complete multi-SDK examples | `feishu-multisdk-examples` | `md2feishu workflow show multisdk-examples` |
| Author SDK reference changes on Feishu | `feishu-sdk-reference-authoring` | `md2feishu workflow show sdk-reference-authoring` |
| Release audited SDK references to `web-content` | `feishu-sdk-reference-release` | `md2feishu workflow show sdk-reference-web-content-release` |
| Audit release notes | `feishu-release-notes` | `md2feishu workflow show release-notes` |

SDK reference authoring stops after Feishu write and audit. Moving audited reference docs into `web-content` is a separate human-triggered release workflow.

## Direct CLI fallback

Use direct CLI commands when debugging, automating, or maintaining the tool:

```bash
npm exec -- md2feishu workflow list
npm exec -- md2feishu workflow show baseline-sync
npm exec -- md2feishu --help
```

Required environment variables for real Feishu calls:

```bash
APP_ID=...
APP_SECRET=...
FEISHU_HOST=https://open.feishu.cn
```

Detailed CLI usage lives in [`packages/cli/README.md`](./packages/cli/README.md).

## Develop

Root scripts delegate to the CLI and docs workspaces:

```bash
npm run dev -- <args>
npm run typecheck
npm test
npm run build
npm run docs:dev
npm run docs:build
```

Generated outputs such as `packages/cli/dist/`, `packages/cli/coverage/`, `apps/docs/.vitepress/dist/`, `.sync/`, `runs/`, and `dogfood/` should not be committed unless explicitly intended.

## License

MIT. See [`packages/cli/NOTICE`](./packages/cli/NOTICE).
