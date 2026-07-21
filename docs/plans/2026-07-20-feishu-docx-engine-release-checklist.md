# Feishu Docx Engine 0.1.0 / Feishu Markdown Sync 0.6.0 Release Checklist

Status: release candidate prepared locally on 2026-07-21. Neither package has been published by this worktree.

This checklist separates local verification from external Feishu and npm actions. Do not cross either external-action gate without an exact target review and explicit approval.

## Candidate identity

- Source base before Task 13 preparation: `a887840412e613d8f4be7c65d96aced9d9eaa66e`.
- Engine candidate: `feishu-docx-engine@0.1.0`.
- CLI candidate: `feishu-md-sync@0.6.0`.
- CLI dependency: exactly `feishu-docx-engine: 0.1.0`.
- Skill range: `feishu-md-sync >=0.6.0 <0.7.0`.
- Committed release manifest: `.github/releases/v0.6.0.json`.
- Manifest policy: `publishEngine: true`; engine provenance binds to `refs/tags/v0.6.0` and the tag's own commit. A future CLI-only release must set `publishEngine: false` and record the engine's original immutable provenance tag/ref/40-character commit SHA.
- Registry: `https://registry.npmjs.org/`.
- Expected post-publish dist-tags:
  - `feishu-docx-engine@latest -> 0.1.0`
  - `feishu-md-sync@latest -> 0.6.0`

Local candidate tarballs were generated in a disposable `/tmp` directory. Repack from the immutable release commit before publication and require the repacked integrity to match the approved preview.

| Package | npm shasum (SHA-1) | SHA-256 | npm integrity |
| --- | --- | --- | --- |
| `feishu-docx-engine@0.1.0` | `4970237dcc20c83e0bf8f9e9bc2ab4e92f73198d` | `8a7b5bb051648fda62c9d0adcb1fe99a61679481ae4f68fa93859bedd5340ec6` | `sha512-tkiErZ5rC5623noByFcy56bguOdzPkdMvHsSghj/OukoxcgIIt+xEXo/zyN54wN+Z7YeqRW7NsgNJNt9Og2wig==` |
| `feishu-md-sync@0.6.0` | `5b38b2402cf6fd3e13bf89eb303ada844f568e43` | `7063594627703687588af76abff92200800cb19a38cd360b5f4447fafd845a17` | `sha512-xq+/IeYnWXJXvN/IMq3E1aSTHdwXBmFqSNRnA5zwGmv7jzajzhQRMmCE7ktr79FaBIUjIlcYA8wkOvO+T9n9TA==` |

## Hard pre-publish blockers discovered

- `npm whoami` returns `ENEEDAUTH`; this machine cannot publish interactively.
- Public registry ownership is visible for the existing CLI as `liyun95 <yun.li95@hotmail.com>`, but ownership of the new package cannot exist until its first publish.
- `feishu-md-sync@latest` is currently `0.5.0`; `feishu-docx-engine` returns registry `E404`.
- The candidate `.github/workflows/release.yml` now implements dependency-ordered publication and separate provenance verification, but it must be reviewed, committed through the Release PR, merged into `main`, and configured in the protected npm environment before a tag may be created.
- npm Trusted Publishing cannot bootstrap a package name that does not yet exist. After the Release PR is merged but before the immutable `v0.6.0` tag is created, obtain separate explicit approval for a conventional authenticated seed publish of `feishu-docx-engine@0.0.0` with dist-tag `bootstrap`, then configure that package's Trusted Publisher for `liyun95/feishu-md-sync`, workflow `release.yml`, environment `npm`.
- The seed must be packed from a clean disposable checkout of the merged source with only the engine version changed to `0.0.0`. It must not use the candidate `0.1.0` version or the `latest` tag.
Do not use an unauthenticated publish, do not publish `feishu-docx-engine@0.1.0` manually, and do not create `v0.6.0` until the seed package exists and both package Trusted Publisher configurations have been verified.

## Local, no-side-effect preflight

Run from the repository root on the exact release candidate commit:

```bash
git status --short --branch
git diff --check
node --version
npm --version
npm config get registry
npm ci
npm run build
npm run typecheck
npm test
npm run test:coverage
npm run test:package
npm run test:skill:release
npm run test:skill-hash
npm run test:release-workflow
npm run docs:build
node packages/cli/dist/cli/index.js --version
node -e "import('feishu-docx-engine').then(({ENGINE_VERSION,ENGINE_CAPABILITIES}) => console.log({ENGINE_VERSION,ENGINE_CAPABILITIES}))"
```

Inspect all generated package contents with both dry-run and local packs:

Use the release workflow's Node 24 runtime and npm `11.18.0` for every approved pack. npm tarball gzip bytes can differ across Node/zlib versions even when package contents are equivalent.

```bash
PACK_DIR_ONE="$(mktemp -d /tmp/feishu-docx-release-one-XXXXXX)"
PACK_DIR_TWO="$(mktemp -d /tmp/feishu-docx-release-two-XXXXXX)"
npm pack --dry-run --json --workspace=feishu-docx-engine
npm pack --dry-run --json --workspace=feishu-md-sync
npm pack --json --pack-destination "$PACK_DIR_ONE" --workspace=feishu-docx-engine
npm pack --json --pack-destination "$PACK_DIR_ONE" --workspace=feishu-md-sync
npm pack --json --pack-destination "$PACK_DIR_TWO" --workspace=feishu-docx-engine
npm pack --json --pack-destination "$PACK_DIR_TWO" --workspace=feishu-md-sync
shasum -a 256 "$PACK_DIR_ONE"/*.tgz "$PACK_DIR_TWO"/*.tgz
```

Confirm that:

- the CLI tarball manifest pins `feishu-docx-engine` to `0.1.0`, not a range or workspace reference;
- runtime and declaration exports install together in an empty consumer;
- `feishu-md-sync --version` prints `0.6.0`;
- packaged `publish --help` and the full Agent Skill validator pass;
- coverage gates, docs build, and all non-live tests pass;
- neither tarball includes tests, credentials, receipts, dogfood output, coverage, or unrelated generated files.
- both independent packs are byte-identical and exactly match every `integrity` and `sha256` field in `.github/releases/v0.6.0.json`;
- structured YAML validation confirms the protected environment, `id-token: write`, manifest dataflow, hash gate before publish, engine provenance before CLI publish, clean registry consumer, and tagged Skill verification ordering.

The repository does not currently pin an `actionlint` binary or action. `scripts/test-release-workflow.mjs` therefore parses the workflow with the pinned npm `yaml` dependency and performs release-specific structural and semantic checks. This is intentionally documented as a focused actionlint-equivalent gate, not represented as full actionlint coverage. Introduce a real actionlint gate only through a separately reviewed pinned dependency/action change.

Observed local result on 2026-07-21:

- `npm ci`, build, root typecheck, and `git diff --check`: passed.
- Engine tests: 193 passed; coverage 88.61% statements, 77.95% branches, 98.40% functions, 88.61% lines.
- CLI tests: 735 passed and 11 live tests skipped; coverage 88.15% statements, 82.41% branches, 95.75% functions, 88.15% lines.
- Package smokes, release Skill validator/install smoke, Skill tree hash regression, docs build, structured workflow/manifest test, and workflow YAML parse: passed.
- The strengthened live assertions compile and are discovered as eight skipped tests across the two targeted live files when their explicit environment gates are absent.
- The focused Code live regression passed end to end with Lark CLI 1.0.73 in disposable Agent Drive documents: content/language merge, caption preservation, conflict detection, strict-identity movement, reconcile, deletion, and exact cleanup passed in 114.7 seconds as user and 256.1 seconds as bot. The scenario timeout is 600 seconds so slow shared-runner API responses cannot outlive the test and overlap the next shared-document scenario. Composite `feishu-md-sync` CLI commands are capped at 240 seconds because one publish can contain multiple verified writes and checkpoints; direct `lark-cli` setup/cleanup commands remain capped at 120 seconds.
- Before the shared-document Whiteboard scenario begins, the harness requires the remote revision and Markdown to remain unchanged for a 30-second stability window, bounded by a 90-second settle timeout. This preserves strict fixed-revision verification while preventing the provider's delayed post-Code revision from leaking across sequential live scenarios. A consecutive bot Code-to-Whiteboard disposable regression passed in 211.5 seconds plus 61.1 seconds and deleted the exact returned document successfully.
- `npm audit`: six development-tool findings (2 moderate, 2 high, 2 critical) in Vitest/Vite/VitePress dependency paths; `npm audit --omit=dev` reports zero production vulnerabilities. Do not apply an automatic audit fix during release preparation; review upgrades separately.
- Two independent real `npm pack` runs with the workflow-pinned npm `11.18.0` produced byte-identical engine and CLI tarballs. Both runs matched every committed integrity and SHA-256 field in `.github/releases/v0.6.0.json` exactly.

## Read-only Feishu parity gate

`CONTROLLED_DOC` must be a dedicated, non-production existing document. Never substitute the Hugging Face production authoring archive, its Chinese localization, or another task document.

Run the engine no-op live assertion:

```bash
CONTROLLED_DOC='<dedicated-controlled-doc-url-or-token>' \
  npm exec --workspace=feishu-md-sync -- \
  vitest run test/live-zdoc-authoring-release-dogfood.test.ts \
  -t 'executes a read-only no-op batch without changing the controlled document'
```

Then run the Task 13 CLI parity commands exactly:

Use `test/fixtures/live/zdoc-engine-controlled.md` because the root `npm run dev` command executes the CLI workspace with `packages/cli` as its working directory. The production-shaped Hugging Face dialect fixture is intentionally not used for this gate because it contains a relative document link and therefore correctly requires the configured Base link resolver; without that resolver it is expected to block rather than serve as a standalone controlled parity source.

```bash
export CONTROLLED_DOC='<dedicated-controlled-doc-url-or-token>'
npm run dev -- status test/fixtures/live/zdoc-engine-controlled.md \
  --target "$CONTROLLED_DOC" --dialect zdoc-authoring --profile none --format json

npm run dev -- diff test/fixtures/live/zdoc-engine-controlled.md \
  --target "$CONTROLLED_DOC" --dialect zdoc-authoring --profile none --format json
```

Save stdout, exit codes, target identity, document ID, revision, semantic hashes, operation summary, blockers, warnings, `zdocRoundTrip`, link resolution, and engine diagnostics. Confirm the controlled source remains blocker-free and the remote preserves its note Callout, nested continuation/list hierarchy, and native table semantics. These commands must not include `--write`, `--create`, or any `--confirm-*` flag.

Observed controlled result on 2026-07-21:

- `CONTROLLED_DOC=https://zilliverse.feishu.cn/docx/DiOjdMCpIocoayxEzQwcyppbn5M` is a dedicated non-production document in the approved Agent Drive folder.
- Final document revision is `25`; the engine snapshot hash is `e4d042886e343e514d22eaf16690008aa55246fb11636457127cd7d8298fff05`.
- The root child kinds are exactly `heading`, `paragraph`, `callout`, `heading`, `list`, `heading`, `table` in that order.
- The note Callout contains the managed `Notes` title plus the expected body. The bullet item owns its continuation paragraph and ordered child. The native table is a verified unmerged 2-by-2 table with all four expected cell values.
- After an accidental Code live-test overwrite, the degraded list subtree was restored through the engine's native structured child creation path. The final write changed only the malformed list root; all other root block IDs and hashes remained unchanged.
- The engine no-op live assertion passed without recording a mutation or changing the document revision/hash.
- CLI `status` and `diff` exited `0` with no dialect, link, Callout, Code, table, Whiteboard, or scoped blockers. `zdocRoundTrip.safeToPublish` was `true` with only the expected `metadata-ignored` informational item.
- CLI publish dry-run returned `strategy: no-op`, zero scoped operations, zero blockers, and zero warnings. It still reports untracked-remote and Callout-adoption confirmation requirements because this controlled document intentionally has no publish receipt; no confirmation flag or receipt adoption was applied for this read-only gate.
- The textual diff remains nonempty because the official Markdown renderer flattens the nested-list continuation and renders the native table as GFM, while the source dialect retains the authoring HTML table. The block-tree and semantic planners agree that no remote mutation is needed.

## Exact live-write approval preview

This command creates a uniquely named document only inside a dedicated disposable Drive folder, writes one nested list plus one native table through `feishu-docx-engine`, verifies the exact block tree, then deletes that same returned docx token in `finally`.

Required isolated environment:

- `FEISHU_MD_SYNC_LIVE=1`
- `FEISHU_MD_SYNC_ENGINE_LIVE_WRITE=1`
- `FEISHU_MD_SYNC_ENGINE_TEST_PARENT=<dedicated disposable Drive folder token>`
- `FEISHU_MD_SYNC_LARK_AS=user` for document creation and engine writes
- `FEISHU_MD_SYNC_ENGINE_CLEANUP_AS=bot` for exact returned-document deletion
- credentials authorized only for the test tenant/folder

Both identities are enum-validated before document creation. If `FEISHU_MD_SYNC_ENGINE_CLEANUP_AS` is omitted, the harness falls back only to an explicitly valid `FEISHU_MD_SYNC_LARK_AS`; the approved Task 13 command must set cleanup to `bot` because that identity has the proven document-delete scope.

Exact later command:

```bash
FEISHU_MD_SYNC_LIVE=1 \
FEISHU_MD_SYNC_ENGINE_LIVE_WRITE=1 \
FEISHU_MD_SYNC_ENGINE_TEST_PARENT='<dedicated-disposable-drive-folder-token>' \
FEISHU_MD_SYNC_LARK_AS=user \
FEISHU_MD_SYNC_ENGINE_CLEANUP_AS=bot \
  npm exec --workspace=feishu-md-sync -- \
  vitest run test/live-feishu-publish.test.ts \
  -t 'creates a nested list and native table in an isolated disposable document and deletes it'
```

Isolation and cleanup policy:

- The parent must be a dedicated Drive folder, not a Wiki node and not a production folder.
- The document title always starts with `fms-engine-live-disposable-`.
- Cleanup may delete only the `documentId` returned by that test's own `createDocument` call.
- Cleanup uses the explicit cleanup identity with exact argv `lark-cli drive +delete --file-token <returned-document-id> --type docx --format json --yes --as bot` inside `finally`.
- Cleanup never searches by title, lists sibling documents, deletes by name, or broadens the target beyond the exact `documentId` returned by this test's create call.
- Readback must independently match the complete root sibling order; bullet parent and ordered child block types, parent IDs, text, child order, and provider-default styles; native table dimensions, unmerged-cell metadata, raw cell order, and every cell's exact paragraph text/order.
- The write approval must explicitly include creation and deletion of that one disposable document. It does not authorize writes to any existing document.
- If the process is interrupted before `finally`, locate only documents with the exact title prefix inside the dedicated test folder, review their returned IDs, and approve cleanup separately. Never broaden deletion to the parent folder.
- A cleanup failure is a failed live gate. Record the disposable title and returned document ID; do not publish until the orphan is reviewed and removed.

Observed disposable live-write result on 2026-07-21: passed (`1` passed, `6` skipped). The nested list and native table matched the exact expected block tree and cell content, cleanup succeeded through the explicit bot identity, and no disposable document remained in the Agent folder.

## Registry and ownership preflight

Read-only commands:

```bash
npm config get registry
npm whoami
npm owner ls feishu-md-sync
npm view feishu-md-sync dist-tags versions --json
npm view feishu-docx-engine dist-tags versions --json
```

Before creating the `v0.6.0` tag, verify in the protected GitHub `npm` environment:

- `feishu-docx-engine@0.0.0` exists with dist-tag `bootstrap` after the separately approved conventional seed publish; `latest` must still be absent for the engine.
- Trusted Publishing is configured separately for both `feishu-docx-engine` and `feishu-md-sync`, using owner `liyun95`, repository `feishu-md-sync`, workflow `release.yml`, and environment `npm`.
- The job has `id-token: write` and no long-lived npm token is introduced.
- The release commit is merged into `main`; tag `v0.6.0` is immutable and points to that commit.
- Before any publish, the workflow must repack both artifacts and match name, version, npm integrity, and SHA-256 against `.github/releases/v0.6.0.json`.
- With `publishEngine: true`, the workflow publishes/reuses `feishu-docx-engine@0.1.0`, verifies registry integrity and its Sigstore provenance against the current tag/commit, and only then proceeds.
- With `publishEngine: false`, the workflow skips engine publication, requires the exact registry engine bytes, and verifies provenance against the prior tag/ref/commit recorded in the manifest. It must never rebind an independently released engine to the current CLI tag.
- The workflow installs the CLI candidate tarball in a clean temporary consumer without a local engine tarball or workspace link; ordinary npm resolution must install exactly `feishu-docx-engine@0.1.0`, then CLI `--version` and `publish --help` must pass before CLI publication.
- Existing versions are either absent or have byte-identical `dist.integrity`; a differing existing version is a hard stop.

## Exact npm external-action preview

Repository policy requires the reviewed tag workflow. Do not run the following until the dependency-ordered workflow, release notes, and release candidate commit are approved and merged; the separately approved `feishu-docx-engine@0.0.0` bootstrap seed exists; and both Trusted Publisher configurations have been verified.

The one-time seed publish is a separate irreversible action and is not authorization to publish either release candidate manually:

```bash
npm publish ./seed-artifacts/feishu-docx-engine-0.0.0.tgz \
  --access public --tag bootstrap
```

The seed artifact must come from the clean disposable merged-source checkout described above. Stop after verifying `bootstrap -> 0.0.0` and configuring the engine Trusted Publisher; do not move `latest` and do not publish `0.1.0` outside the protected tag workflow.

The external trigger requiring approval is:

```bash
git tag v0.6.0 <approved-merged-release-commit-sha>
git push origin refs/tags/v0.6.0
```

Pushing that immutable tag triggers the protected `npm` environment. It is authorization for the manifest-bound engine and CLI publish sequence below; it is not authorization for any Feishu write.

The manifest-approved publish actions that the protected workflow may perform are:

```bash
npm publish ./release-artifacts/feishu-docx-engine-0.1.0.tgz \
  --access public --provenance --tag latest

npm publish ./release-artifacts/feishu-md-sync-0.6.0.tgz \
  --access public --provenance --tag latest
```

The engine publish is conditional on `publishEngine`. Immediately before either publish, the workflow has already compared both freshly packed artifacts with the committed manifest. The CLI publish remains unreachable until engine registry integrity, engine provenance, and clean-consumer registry resolution all succeed.

Expected resulting registry state:

```text
feishu-docx-engine@0.1.0  dist-tag latest=0.1.0
feishu-md-sync@0.6.0      dist-tag latest=0.6.0
```

## Post-publish verification

Run from a clean checkout detached at the immutable `v0.6.0` tag after registry propagation. Keep the installed CLI and Skill in isolated temporary locations, and use `REPO_ROOT` for every tagged-checkout script path:

```bash
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
test -z "$(git status --porcelain)"
test "$(git rev-parse --abbrev-ref HEAD)" = 'HEAD'
test "$(git describe --tags --exact-match)" = 'v0.6.0'
TEMP_HOME="$(mktemp -d)"
CLI_PREFIX="$(mktemp -d)"
npm view feishu-docx-engine@0.1.0 version dist.integrity dist.shasum dist-tags --json
npm view feishu-md-sync@0.6.0 version dependencies dist.integrity dist.shasum dist-tags --json
npm install --prefix "$CLI_PREFIX" --ignore-scripts --no-audit --no-fund feishu-md-sync@0.6.0
FMS="$CLI_PREFIX/node_modules/.bin/feishu-md-sync"
"$FMS" --version
"$FMS" --help
"$FMS" publish --help
HOME="$TEMP_HOME" XDG_STATE_HOME="$TEMP_HOME/.local/state" \
  npx --yes skills@1.5.17 add 'liyun95/feishu-md-sync#v0.6.0' \
  --skill feishu-md-sync --agent codex --global --copy --yes
node "$REPO_ROOT/scripts/hash-skill-tree.mjs" "$REPO_ROOT/skills/feishu-md-sync"
node "$REPO_ROOT/scripts/hash-skill-tree.mjs" "$TEMP_HOME/.agents/skills/feishu-md-sync"
FEISHU_MD_SYNC_SKILL_DIR="$TEMP_HOME/.agents/skills/feishu-md-sync" \
FEISHU_MD_SYNC_BIN="$FMS" node "$REPO_ROOT/scripts/validate-agent-skill.mjs"
```

Also verify both Sigstore provenance bundles against the immutable `v0.6.0` tag, release commit SHA, repository, workflow path, GitHub Actions builder, and push event. Run the read-only controlled-doc parity again using the installed CLI and matching tagged Skill.

Only after both packages, provenance records, tagged Skill, GitHub Release, read-only parity, and controlled live cleanup are verified may Project B consume `feishu-docx-engine@0.1.0`.

## Rollback and deprecation limits

- npm package versions are immutable. Do not overwrite, delete, or reuse `0.1.0` or `0.6.0` after publication.
- If the engine publishes but the CLI does not, leave `feishu-docx-engine@0.1.0` available, fix the release workflow on a reviewed commit, and retry only byte-identical publication/recovery. Do not publish a different engine under `0.1.0`.
- If either published package is unsafe, immediately communicate the issue, move `latest` back to the last known-safe version where appropriate, and publish a new patch version. Use `npm deprecate <name>@<version> '<reason and safe replacement>'` only after explicit maintainer approval.
- Dist-tag changes and deprecation are external registry writes and require their own preview and approval.
- A GitHub Release or provenance verification failure does not justify repacking different bytes under the same version. Rerun only against the same tag commit and matching integrity.
- Do not modify or fabricate Feishu receipts, cleanup evidence, package hashes, provenance, or registry metadata by hand.

## Release metadata commit gate

Task 13's original plan places the release metadata commit after publication, but `RELEASING.md` and the tag workflow require the release candidate files to be committed in a dedicated Release PR, merged to `main`, and then tagged before publication. Publication cannot legally precede the commit. This preparation therefore leaves changes uncommitted and unstaged and reports the ordering conflict instead of inventing a commit.

The reviewed pre-publish release commit would need to include at least:

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml \
  .github/releases/v0.6.0.md .github/releases/v0.6.0.json \
  README.md apps/docs/guide/agent-usage.md \
  package.json package-lock.json packages/cli/package.json packages/docx-engine/package.json \
  packages/cli/test/live-feishu-publish.test.ts \
  packages/cli/test/live-zdoc-authoring-release-dogfood.test.ts \
  skills/feishu-md-sync/SKILL.md scripts/validate-agent-skill.mjs \
  scripts/test-agent-skill-validator.mjs scripts/test-release-workflow.mjs \
  scripts/hash-skill-tree.mjs scripts/test-skill-tree-hash.mjs \
  CHANGELOG.md RELEASING.md \
  docs/plans/2026-07-20-feishu-docx-engine-release-checklist.md
git commit -m "Prepare v0.6.0 release"
```

Do not create this commit from this preparation subtask. The main task must review the complete diff and explicitly reconcile the implementation plan's post-publish commit wording with the repository's mandatory pre-publish Release PR convention. No tag, push, or publish is authorized here.
