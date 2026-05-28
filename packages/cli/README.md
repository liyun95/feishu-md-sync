# feishu-md-sync

`feishu-md-sync` provides the `md2feishu` CLI for Feishu documentation workflows.

Most team users should start with the workflow skills in the main documentation. Use the CLI directly when you need to debug a workflow, inspect a dry-run, automate a command, or maintain the tool.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## What You Can Do

| Need | Recommended entry |
| --- | --- |
| Pull a Feishu document into local Markdown before editing | `feishu-baseline-sync` skill or `md2feishu pull` |
| Sync one local Markdown section back to Feishu | `feishu-section-sync` skill or `md2feishu sync --section` |
| Inspect a planned write before applying it | `md2feishu sync` without `--write` |
| Resolve local/remote drift | `md2feishu status`, `md2feishu diff`, and `md2feishu merge` |
| Work on multi-SDK examples, SDK references, or release notes | Use the matching workflow skill first |

The CLI is dry-run-first. Commands that write to Feishu require `--write` and either interactive confirmation or `--yes`.

## Run From This Repository

```bash
npm install
npm run build
npm exec -- md2feishu workflow list
```

Show the workflow recipe before running lower-level commands:

```bash
npm exec -- md2feishu workflow show baseline-sync
npm exec -- md2feishu workflow show section-sync
```

## Configure Feishu Access

From the repository root:

```bash
cp .env.example .env
```

Fill in `APP_ID` and `APP_SECRET`, then verify that the CLI can load them:

```bash
npm exec -- md2feishu doctor auth --format json
```

The Feishu app also needs API permissions and document access. See the [Configuration guide](https://liyun95.github.io/feishu-md-sync/guide/configuration).

## Direct CLI Examples

Pull the current Feishu document into Markdown:

```bash
npm exec -- md2feishu pull DocToken --output feishu.remote.md
```

Dry-run a section update:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --section "Index type overview"
```

Write only after reviewing the dry-run:

```bash
npm exec -- md2feishu sync ./doc.md DocToken --section "Index type overview" --write --yes
```

Supported target forms:

```bash
npm exec -- md2feishu sync ./doc.md DocToken
npm exec -- md2feishu sync ./doc.md https://example.feishu.cn/docx/DocToken
npm exec -- md2feishu sync ./doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
```

## More References

- [Quickstart](https://liyun95.github.io/feishu-md-sync/guide/quickstart)
- [Choose a Workflow](https://liyun95.github.io/feishu-md-sync/guide/workflows)
- [Command Reference](https://liyun95.github.io/feishu-md-sync/reference/commands)
- [Safety Gates](https://liyun95.github.io/feishu-md-sync/reference/safety-gates)
- [Troubleshooting](https://liyun95.github.io/feishu-md-sync/guide/troubleshooting)

## Development

```bash
npm run typecheck
npm test
npm run build
```

Generated outputs such as `dist/` and `coverage/` should not be committed.
