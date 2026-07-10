# Handoff

This repo has been refactored to the new `feishu-md-sync` CLI surface.

## Current State

The first sync-bridge slice is complete:

- `publish`: local Markdown to Feishu, including existing doc updates, `--create`, block-patch, guarded document-replace, readback verification, publish receipts, and local merge base snapshots.
- `pull`: Feishu Markdown export to a local remote snapshot, with profile filtering and optional pull receipts.
- `status`: read-only local/remote/receipt state with recommended next action.
- `diff`: current remote Markdown vs local publish draft.
- `merge`: Git-like local merge of remote edits into the local Markdown source, with `--check`, `--dry-run`, and `--abort`.
- `doctor auth`: `.env` load report plus `lark-cli` identity hints.

The old surface has been physically removed:

- `sync`
- `push`
- `publish-new`
- `workflow`
- `harness`
- `multisdk`
- `reference`
- `release`
- `code-blocks`

Unknown retired commands, including `sync --help`, now fail with `error: unknown command '<command>'`.

## Verified Live Flow

Test target used during dogfood:

```text
DRcMdScYVoYhvlxbBZ5cyqU5nTf
```

The verified workflow:

```bash
FEISHU_MD_SYNC_LARK_AS=bot \
node packages/cli/dist/cli/index.js status dogfood/live-block-patch-smoke.md \
  --target DRcMdScYVoYhvlxbBZ5cyqU5nTf \
  --profile zilliz \
  --format json

FEISHU_MD_SYNC_LARK_AS=bot \
node packages/cli/dist/cli/index.js pull \
  --target DRcMdScYVoYhvlxbBZ5cyqU5nTf \
  --output dogfood/live-block-patch-smoke.remote.md \
  --profile zilliz \
  --overwrite \
  --write-receipt \
  --format json

FEISHU_MD_SYNC_LARK_AS=bot \
node packages/cli/dist/cli/index.js merge dogfood/live-block-patch-smoke.md \
  --target DRcMdScYVoYhvlxbBZ5cyqU5nTf \
  --profile milvus \
  --format json

FEISHU_MD_SYNC_LARK_AS=bot \
node packages/cli/dist/cli/index.js publish dogfood/live-block-patch-smoke.md \
  --target DRcMdScYVoYhvlxbBZ5cyqU5nTf \
  --profile zilliz \
  --write \
  --format json

FEISHU_MD_SYNC_LARK_AS=bot \
node packages/cli/dist/cli/index.js status dogfood/live-block-patch-smoke.md \
  --target DRcMdScYVoYhvlxbBZ5cyqU5nTf \
  --profile zilliz \
  --format json
```

Final status was `clean`. The final `publish --write` was `strategy: "no-op"` and refreshed the local publish receipt plus merge base snapshot without changing Feishu content.

## Validation Commands

Run these before pushing:

```bash
npm run typecheck
npm run build
npm test
npm run test:coverage
npm run docs:build
FEISHU_MD_SYNC_LIVE=1 FEISHU_MD_SYNC_LARK_AS=bot FEISHU_MD_SYNC_TEST_DOC='https://my.feishu.cn/wiki/K6GQwm4niiatXAkUl8YcY66InSc?from=from_copylink' npm run test:live:feishu
```

The latest local run passed typecheck, build, unit tests, docs build, and live Feishu publish/merge smoke tests.

## Recent Commits

- `e293c54 Refresh publish receipt on no-op writes`
- `f0e4482 Use unchanged local file as merge base fallback`
- `5210e95 Reject retired commands before help`
- `f25ea04 Delete legacy workflow code`
- `957e700 Clean up legacy CLI surface`

## Next Session

Recommended next step is release/landing:

1. Run the validation commands above once more.
2. Review `git log --oneline` and `git status --short --ignored`.
3. Push the branch.
4. Confirm GitHub Pages renders the simplified docs.
5. Start the next feature discussion only after this baseline is landed.

Likely next feature topics:

- image upload and Feishu asset handling
- richer table/grid handling
- inline text patch instead of block replacement
- stronger create UX for Drive folders and Wiki parents
- CI strategy for live Feishu tests
