# Install For Agents

Agents should use a deterministic command path and avoid relying on shell aliases.

## Team Skill Install

The recommended team UX is Skill-first. Install this repository, build the CLI, then copy the workflow skills into the local Codex skill root:

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

After that, users can ask Codex to use the matching workflow skill instead of memorizing CLI commands. The skills call `md2feishu workflow show <workflow-id> --format json` and use the CLI registry as the source of truth.

Early dogfooding can share one Feishu app credential set. Per-user app setup can be introduced later if write attribution or permission isolation becomes important.

If this machine previously installed the older operation-specific aliases, run the migration cleanup once:

```bash
scripts/install-codex-skills.sh --remove-legacy
```

## Repository-Local CLI

From the repository root:

```bash
npm install
npm run build
npm exec -- md2feishu --help
```

Use this form during development:

```bash
npm exec -- md2feishu <command>
```

## Linked Local CLI

When the package is linked:

```bash
npm link
md2feishu --help
```

## Future Published Package

When the package is published, agents may use a global or one-shot install path such as:

```bash
npm install -g md2feishu
md2feishu --help
```

or:

```bash
npx md2feishu --help
```

Until then, prefer `npm exec -- md2feishu ...` inside the repository.
