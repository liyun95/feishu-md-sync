# Feishu Markdown Sync

Feishu Markdown Sync is a dry-run-first sync bridge between local Markdown and Feishu/Lark online documents. The official `lark-cli` owns Feishu authentication and document IO; `feishu-md-sync` adds local profiles, receipts, safety gates, status, diff, pull, merge, and publish UX.

The primary product surface is the `feishu-md-sync` CLI: `publish`, `pull`, `status`, `diff`, and `merge`.

Docs site: <https://liyun95.github.io/feishu-md-sync/>

## Quickstart

Install and authenticate the official [`lark-cli`](https://github.com/larksuite/cli):

```bash
npx @larksuite/cli@latest install
lark-cli auth login --domain docs,wiki,drive
lark-cli auth status
```

Install the published CLI with Node.js 20 or newer:

```bash
npm install --global feishu-md-sync@latest
feishu-md-sync --help
```

For a one-off run without a global install, use `npx --yes feishu-md-sync@latest --help`.

The selected `lark-cli` identity must have access to the target document, Drive folder, or Wiki parent.

### Agent Skill

Install the Skill from the same release tag as the CLI:

```bash
npm install --global feishu-md-sync@0.4.0
npx skills add 'liyun95/feishu-md-sync#v0.4.0' --skill feishu-md-sync --global --yes
```

Then ask an Agent:

```text
Use $feishu-md-sync to synchronize ./doc.md with this Feishu document. Review the dry-run first and do not bypass any safety gate.
```

The Skill drives the existing CLI; it does not replace it. It uses `$lark-shared` for authentication and permission repair and leaves ad hoc remote-only editing to `$lark-doc`. See the [Agent usage guide](./apps/docs/guide/agent-usage.md) for development builds, authorization behavior, and matching-version upgrades.

Preview a publish plan:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token>
```

Write to an existing remote document for the first time after reviewing the plan:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write --confirm-untracked-remote
```

Handle remote edits before publishing:

```bash
feishu-md-sync status ./doc.md --target <docx-url-or-token>
feishu-md-sync diff ./doc.md --target <docx-url-or-token>
feishu-md-sync pull --target <docx-url-or-token> --output doc.remote.md --write-receipt
feishu-md-sync merge ./doc.md --target <docx-url-or-token>
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write
```

When the merge already makes the local publish draft match the remote document, the final `publish --write` is a no-op remote write: it refreshes the local receipt and merge base snapshot without changing Feishu content.

## Source Dialects and Profiles

Dialect and profile solve different problems. A dialect describes the syntax in the source file; a profile applies product-content wording after that syntax has been converted into publishable Markdown.

| Source | Dialect | Profile |
| --- | --- | --- |
| Ordinary Markdown | `gfm` | `none` |
| Canonical Zdoc source | `zdoc-authoring` | `zilliz` |
| Milvus canonical source | `milvus-authoring` | `none` |
| Milvus source published with Zilliz wording | `milvus-authoring` | `zilliz` |

`gfm` and profile `none` are the defaults. Select another source dialect with `--dialect` or `defaultDialect` in `feishu-md-sync.config.json`:

```bash
feishu-md-sync status article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz
feishu-md-sync diff article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz
feishu-md-sync publish article.md --target "$TARGET" --dialect zdoc-authoring --profile zilliz
```

Zdoc authoring preprocessing removes non-reconstructable metadata, converts supported Admonitions to native Callouts, preserves Procedures boundaries, and adopts existing Supademo ISV blocks without rewriting them. `zdocRoundTrip.safeToPublish` blocks unknown components or unsafe resource correspondence. Milvus authoring preprocessing expands `Variables.json` values and recursive `fragments/` references.

`pull` remains a separate Feishu-safe snapshot. Automatic merge is available only for `gfm`; Zdoc and Milvus authoring sources must be reconciled manually because Feishu cannot reconstruct all source-only syntax.

Preview creating a new document under a Drive folder or Wiki parent:

```bash
feishu-md-sync publish ./doc.md --target <wiki-parent-url> --create
```

Execute guarded whole-document replacement only when you intentionally accept the risk:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --write --strategy document-replace --confirm-destructive
```

## Safety Model

Commands are dry-run by default. `--write` allows remote writes, but it does not allow destructive strategies by itself.

Existing-document whole replacement requires all of these gates:

- `--write`
- `--strategy document-replace`
- `--confirm-destructive`

This protects comments, anchors, block identity, and teammate edits from accidental replacement. When the document shape is safe, `publish` can use block-level patching instead of whole-document replacement.

Scoped publishing also recognizes reconstructable HTML tables. It reports row additions and updates, combines them with text-block changes, and replaces only the matched table block after `--confirm-collaboration-risk`. Unsupported or conflicting changes produce `strategy: blocked`; `auto` never falls back to whole-document replacement.

Top-level fenced Code blocks are also first-class publish scopes. The CLI preserves Code content exactly, resolves Markdown language aliases to Feishu languages, keeps existing remote captions, and can create, update, delete, or move Code blocks without replacing the document. Content and language are merged as separate managed fields, so disjoint local and remote edits can coexist; overlapping edits fail closed.

Scoped publishing also supports Milvus-style note and warning Callouts:

```html
<div class="alert note">

Use load-time CPU adaptation.

</div>
```

Use `alert warning` for a warning. Local Markdown owns the Callout body; Feishu owns the presentation title, emoji, colors, and container identity. Existing presentation is preserved during body updates. New Callouts use `📘 Notes` or `❗ Warning` by default, and workspace configuration can override the titles, for example `说明` and `警告`.

Callout body updates are planned per child block, so a local edit and a teammate edit to different children can coexist. Type changes are blocked. Deleting a tracked, remotely unchanged Callout is supported after `--confirm-collaboration-risk`. Changed unsupported body content also blocks the complete publish instead of flattening the Callout or replacing the document.

## Editable Whiteboard Assets

Whiteboard sync is opt-in. Keep the published Markdown portable by referencing a PNG, and place an editable SVG beside it with the same basename:

```text
article.md -> ![Architecture](./assets/architecture.png)
assets/architecture.png
assets/architecture.svg
```

The image reference must be on its own Markdown line. The first publish matches that position to one existing remote image or Whiteboard block; later publishes update the same Whiteboard token. Preview before writing:

```bash
feishu-md-sync status article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync diff article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync publish article.md --target "$TARGET" --profile none --sync-whiteboards
feishu-md-sync publish article.md --target "$TARGET" --profile none --sync-whiteboards \
  --write --confirm-untracked-remote --confirm-collaboration-risk
```

This feature does not render or upload the PNG, and images without a same-name SVG remain ordinary images. Remote Whiteboard edits fail closed. After review, overwrite one remotely changed asset explicitly with `--confirm-remote-whiteboard-overwrite assets/architecture.png`. SVG import preserves supported shapes, lines, paths, groups, symbols, and text as editable Whiteboard nodes where Feishu supports them; native smart-connector binding is not guaranteed.

For a `zdoc-authoring` archive that already has a receipt-tracked native Whiteboard, the canonical source may reference the recorded SVG directly. Ordinary status, diff, and publish planning then verify the receipt block/token identity and report `preserve tracked whiteboard` without writing board content. A changed direct SVG blocks until the caller adds both `--sync-whiteboards` and the exact existing PNG receipt key through `--confirm-remote-whiteboard-overwrite`; direct SVG references never initialize an untracked Whiteboard.

## Develop

Root scripts delegate to the CLI and docs workspaces:

```bash
npm install
npm run dev -- <args>
npm run typecheck
npm test
npm run build
npm run test:skill
npm run docs:dev
npm run docs:build
```

Generated outputs such as `packages/cli/dist/`, `packages/cli/coverage/`, `apps/docs/.vitepress/dist/`, `.sync/`, `runs/`, and `dogfood/` should not be committed unless explicitly intended.

Maintainers should follow [`RELEASING.md`](./RELEASING.md) when classifying pull requests, planning versions, and publishing npm releases.

## License

MIT. See [`packages/cli/LICENSE`](./packages/cli/LICENSE) and [`packages/cli/NOTICE`](./packages/cli/NOTICE).
