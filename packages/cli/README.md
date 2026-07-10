# feishu-md-sync

`feishu-md-sync` provides the `md2feishu` CLI for Feishu documentation workflows.

Most team users should start with the workflow skills in the main documentation. Use the CLI directly when you need to debug a workflow, inspect a dry-run, automate a command, or maintain the tool.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## What You Can Do

| Need | Recommended entry |
| --- | --- |
| Pull a Feishu document into a local remote snapshot | `feishu-md-sync pull` |
| Publish local Markdown that has no Feishu URL yet | `feishu-publish-new` skill or `md2feishu publish-new` |
| Push local Markdown changes back to Feishu | `feishu-md-sync publish` |
| Inspect a planned write before applying it | `feishu-md-sync publish` without `--write` |
| Check publish readiness | `feishu-md-sync status` |
| Resolve local/remote drift | `feishu-md-sync status`, `feishu-md-sync diff`, then `feishu-md-sync merge` |
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

Pull the current Feishu document into a profile-filtered remote snapshot:

```bash
npm exec -- feishu-md-sync pull --target DocToken --output feishu.remote.md --profile milvus
```

Check whether local and remote are ready for publish:

```bash
npm exec -- feishu-md-sync status ./doc.md --target DocToken --profile zilliz
```

Inspect the remote-current to publish-draft diff:

```bash
npm exec -- feishu-md-sync diff ./doc.md --target DocToken --profile zilliz
```

Merge remote edits back into the local authoring file:

```bash
npm exec -- feishu-md-sync merge ./doc.md --target DocToken --profile milvus
```

`merge` writes only local files. It fetches the remote Markdown, applies pull-side profile filtering, and uses the local base snapshot saved by the last successful `publish --write` when available. If it cannot safely merge a region, it writes standard conflict markers and exits `1`:

```md
<<<<<<< LOCAL
local content
=======
remote content
>>>>>>> REMOTE
```

Abort the last in-place merge for a file:

```bash
npm exec -- feishu-md-sync merge ./doc.md --abort --profile milvus
```

Refresh an existing local file only after reviewing the remote copy:

```bash
npm exec -- feishu-md-sync pull --target DocToken --output feishu.remote.md --profile milvus
diff -u doc.md feishu.remote.md
npm exec -- feishu-md-sync pull --target DocToken --output feishu.remote.md --profile milvus --overwrite --write-receipt
```

Dry-run a publish. The CLI chooses no-op, block-patch, or guarded document-replace from the local and remote state:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz
```

For the full strategy meanings and safety gates, see the [Command Reference](https://liyun95.github.io/feishu-md-sync/reference/commands) and [Safety Gates](https://liyun95.github.io/feishu-md-sync/reference/safety-gates).

Dry-run first publication for a file with no Feishu URL yet:

```bash
npm exec -- md2feishu publish-new ./doc.md --folder-token <folder-token>
```

Write only after reviewing the dry-run:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz --write --confirm-collaboration-risk
```

Use a heading scope as a guard when only one section should be considered:

```bash
npm exec -- md2feishu push ./doc.md DocToken --scope heading:"Index type overview"
```

Allow full document replacement only when the dry-run recommends it and replacement is intentional:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken --profile zilliz --strategy document-replace --write --confirm-destructive
```

For whole-document pushes with important Markdown tables or local images/SVGs, use docs v2 overwrite plus explicit media upload:

```bash
npm exec -- md2feishu push ./doc.md DocToken --write-backend docx-v2-overwrite --image-root-dir ./static --image-size /img/diagram.svg=900x393 --replace-all --write --yes
```

Supported target forms:

```bash
npm exec -- feishu-md-sync publish ./doc.md --target DocToken
npm exec -- feishu-md-sync publish ./doc.md --target https://example.feishu.cn/docx/DocToken
npm exec -- feishu-md-sync publish ./doc.md --target 'https://example.feishu.cn/wiki/WikiNodeToken?renamingWikiNode=true'
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
