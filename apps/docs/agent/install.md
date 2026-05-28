# Agent Installation

The recommended team path has moved to [Quickstart](/guide/quickstart).

Install the workflow skills from the repository root:

```bash
npm install
npm run build
scripts/install-codex-skills.sh
```

After installation, ask Codex to use the workflow skill that matches the task:

- `feishu-baseline-sync`
- `feishu-reviewed-section-sync`
- `feishu-multisdk-examples`
- `feishu-sdk-reference-authoring`
- `feishu-sdk-reference-release`
- `feishu-release-notes`

Use `scripts/install-codex-skills.sh --remove-legacy` only when migrating a machine that previously installed older alias skills.

For workflow selection, see [Choose a Workflow](/guide/workflows).
