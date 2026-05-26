# Install For Agents

Agents should use a deterministic command path and avoid relying on shell aliases.

## Repository-Local Install

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
