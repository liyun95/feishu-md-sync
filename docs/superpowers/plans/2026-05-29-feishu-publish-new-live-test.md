# Feishu Publish-New Live Test Plan

> **For agentic workers:** This tests first publication against a disposable Feishu destination. Do not use a shared production wiki page or folder.

**Goal:** Verify that `feishu-publish-new` creates a new Feishu docx from local Markdown, optionally places it under the configured wiki parent, writes a receipt, and enables a follow-up `feishu-push` dry-run against the returned URL.

**Local file:** `/private/tmp/feishu-md-sync-publish-new-live.md`

**Acceptance content:**

~~~markdown
# Publish New Acceptance

Live publish-new acceptance note: created from local Markdown on 2026-05-29.

- Bullet item

| Column | Value |
| --- | --- |
| smoke | publish-new |

```ts
console.log('publish-new smoke');
```
~~~

## Prerequisites

Configure a disposable destination before running write mode:

```bash
export FEISHU_PUBLISH_APP_OWNED=true
```

Or configure a disposable Drive folder:

```bash
export FEISHU_PUBLISH_FOLDER_TOKEN='<disposable-folder-token>'
```

For wiki placement, also configure:

```bash
export FEISHU_PUBLISH_SPACE_ID='<disposable-space-id>'
export FEISHU_PUBLISH_PARENT_NODE_TOKEN='<disposable-parent-node-token>'
```

## Workflow

1. Create the local Markdown file:

```bash
cat > /private/tmp/feishu-md-sync-publish-new-live.md <<'EOF'
# Publish New Acceptance

Live publish-new acceptance note: created from local Markdown on 2026-05-29.

- Bullet item

| Column | Value |
| --- | --- |
| smoke | publish-new |

```ts
console.log('publish-new smoke');
```
EOF
```

2. Run the dry-run:

```bash
md2feishu publish-new /private/tmp/feishu-md-sync-publish-new-live.md
```

Expected: output shows title, title source, destination source, staging folder, creation strategy, document type, wiki move behavior, duplicate title status, block count, and `Run with --write to publish.`

3. Publish:

```bash
md2feishu publish-new /private/tmp/feishu-md-sync-publish-new-live.md --write -y
```

Expected: output ends with `Published:`, `Receipt:`, `Verification: passed`, and a `Next update command` using `md2feishu push`.

4. Pull the returned URL:

```bash
md2feishu pull '<new-url>' --output /private/tmp/feishu-md-sync-publish-new-live.readback.md --overwrite
```

Expected: `/private/tmp/feishu-md-sync-publish-new-live.readback.md` contains the acceptance note once.

5. Run the follow-up push dry-run:

```bash
md2feishu push /private/tmp/feishu-md-sync-publish-new-live.md '<new-url>'
```

Expected: push dry-run is clean or explains only harmless normalization differences.

## Current Status

Folder smoke passed on 2026-05-29 with the configured disposable folder:

- `FEISHU_PUBLISH_FOLDER_TOKEN=JF4VfVKaKlUuhodjXLJcMqF8n6f`
- Published URL: `https://zilliverse.feishu.cn/docx/LYmCdvl8pofS51xe1HpcDmunnyh`
- Receipt: `packages/cli/.sync/feishu/feishu-md-sync-publish-new-folder-live.md.LYmCdvl8pofS51xe1HpcDmunnyh.json`
- Pull readback wrote `/private/tmp/feishu-md-sync-publish-new-folder-live.readback.md` and preserved the heading, paragraph, list, table, and fenced code block.
- Follow-up `md2feishu push ... --markdown-engine local` dry-run reported `No Feishu write is needed.`
- Receipt metadata smoke also passed with `https://zilliverse.feishu.cn/docx/CIQtd5DdwoH2H9xJMGKc9ZVCn1g`; the written receipt includes `publish.workflow`, `publish.title`, `publish.documentUrl`, `publish.destination`, and `publish.creationStrategy`.

Non-destructive UX checks completed:

- `md2feishu publish-new --help` shows the common usage shapes and defaults `--markdown-engine` to `local` for the V1 block-pipeline path.
- Missing destination exits before creating anything and prints `Nothing was created.`
- Wiki destination missing space id exits before creating anything and prints `Nothing was created.`
- Wiki destination missing staging folder exits before creating anything and prints `Nothing was created.`
- `md2feishu workflow show publish-new --format json` exposes the publish-new recipe.

Wiki smoke first reached the move step on 2026-05-29:

- Parent node token from URL: `Tk2qwlX1Li6C26kVo84cOJPCnWg`
- Resolved space id: `7314484612833640452`
- Created staging docx: `https://zilliverse.feishu.cn/docx/I3lbdyOBMovMN0x1lDncgqrQnCh`
- Result: move failed with `permission denied: no destination parent node permission`
- Receipt: not written

After granting destination parent permission, wiki smoke passed:

- Published wiki URL: `https://zilliverse.feishu.cn/wiki/YJJmwH0Njif1makvv0jcPzBpnUc`
- Created docx id: `Nw33dHe8xo7SQexW05Uc648qnob`
- Receipt: `packages/cli/.sync/feishu/feishu-md-sync-publish-new-folder-live.md.Nw33dHe8xo7SQexW05Uc648qnob.json`
- Receipt metadata includes `publish.wikiUrl`, `publish.wikiNodeToken`, `publish.documentUrl`, `publish.destination`, and `publish.creationStrategy`.
- Pull readback wrote `/private/tmp/feishu-md-sync-publish-new-wiki-live.readback.md` and preserved the heading, paragraph, list, table, and fenced code block.
- Follow-up `md2feishu push ... --markdown-engine local` dry-run reported `No Feishu write is needed.`
