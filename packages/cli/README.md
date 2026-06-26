# feishu-md-sync

`feishu-md-sync` provides the `md2feishu` CLI for Feishu documentation workflows.

Most team users should start with the workflow skills in the main documentation. Use the CLI directly when you need to debug a workflow, inspect a dry-run, automate a command, or maintain the tool.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## What You Can Do

| Need | Recommended entry |
| --- | --- |
| Pull a Feishu document into local Markdown before editing | `feishu-baseline-sync` skill or `md2feishu pull` |
| Publish local Markdown that has no Feishu URL yet | `feishu-publish-new` skill or `md2feishu publish-new` |
| Push local Markdown changes back to Feishu | `feishu-push` skill or `md2feishu push` |
| Inspect a planned write before applying it | `md2feishu push` without `--write` |
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
npm exec -- md2feishu workflow show publish-new
npm exec -- md2feishu workflow show push
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
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md --write-receipt
```

Refresh an existing local file only after reviewing the remote copy:

```bash
npm exec -- md2feishu pull '<feishu-doc>' --output feishu.remote.md
diff -u doc.md feishu.remote.md
npm exec -- md2feishu pull '<feishu-doc>' --output doc.md --overwrite --write-receipt
```

Dry-run a push. The CLI chooses block-patch, section-replace, or document-replace from the local and remote state:

```bash
npm exec -- md2feishu push ./doc.md DocToken
```

For the full dry-run review workflow, strategy meanings, and scoped receipt caveats, see the [Feishu Push guide](https://liyun95.github.io/feishu-md-sync/guide/push).

Dry-run first publication for a file with no Feishu URL yet:

```bash
npm exec -- md2feishu publish-new ./doc.md --folder-token <folder-token>
```

Write only after reviewing the dry-run:

```bash
npm exec -- md2feishu push ./doc.md DocToken --write --yes
```

Use a heading scope as a guard when only one section should be considered:

```bash
npm exec -- md2feishu push ./doc.md DocToken --scope heading:"Index type overview"
```

Allow full document replacement only when the dry-run recommends it and replacement is intentional:

```bash
npm exec -- md2feishu push ./doc.md DocToken --strategy document-replace --replace-all --write --yes
```

For whole-document pushes with important Markdown tables or local images/SVGs, use docs v2 overwrite plus explicit media upload:

```bash
npm exec -- md2feishu push ./doc.md DocToken --write-backend docx-v2-overwrite --image-root-dir ./static --image-size /img/diagram.svg=900x393 --replace-all --write --yes
```

Supported target forms:

```bash
npm exec -- md2feishu push ./doc.md DocToken
npm exec -- md2feishu push ./doc.md https://example.feishu.cn/docx/DocToken
npm exec -- md2feishu push ./doc.md 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
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
