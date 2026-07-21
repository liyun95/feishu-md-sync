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
| `feishu-docx-engine@0.1.0` | `65affb2bdc25da60b2f8f0d242f989f9bec58389` | `b2ed0af542da1412e71b7f31d9f65e70e4e9325b744126035e7e9d6b4458c1d5` | `sha512-mZQiuocd2JL8xV1xTGzqcvM+m7MNtG+VQSJTWFKGiuUxX136i0AuqGRVVk+WOnHWlMX7wiFB2qvZ3YQe+K8PTg==` |
| `feishu-md-sync@0.6.0` | `9082b0aed49088faa02bd416784b1acd1409a8c4` | `a78a761721d35aa440707d97b5185e9aeb5ea9291d1e9fd4aeefa8e3ed70f187` | `sha512-QkI6TCHjKoNWrNggYz9rxPoBXxAGZL4Nqou6MGSoSMUrxtPrs/NdVl2SW+B/W7LDj5RSYvCv6b2rh286aVvzlQ==` |

## Hard pre-publish blockers discovered

- `npm whoami` returns `ENEEDAUTH`; this machine cannot publish interactively.
- Public registry ownership is visible for the existing CLI as `liyun95 <yun.li95@hotmail.com>`, but ownership of the new package cannot exist until its first publish.
- `feishu-md-sync@latest` is currently `0.5.0`; `feishu-docx-engine` returns registry `E404`.
- The candidate `.github/workflows/release.yml` now implements dependency-ordered publication and separate provenance verification, but it must be reviewed, committed through the Release PR, merged into `main`, and configured in the protected npm environment before a tag may be created.
- `feishu-docx-engine` is a new unscoped package. Confirm how the npm account/protected environment establishes first-publish ownership and Trusted Publishing authorization before relying on OIDC. Do not assume the existing `feishu-md-sync` ownership automatically grants the new package name.
- No controlled Feishu document, disposable Drive folder, or live credentials are configured in this worktree environment.

Do not use a local unauthenticated/manual publish to bypass these blockers. Resolve first-publish ownership and merge the reviewed release candidate, then use the repository's protected `npm` environment.

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
- Engine tests: 181 passed; coverage 88.48% statements, 78.01% branches, 98.38% functions, 88.48% lines.
- CLI tests: 720 passed and 11 live tests skipped; coverage 87.65% statements, 82.31% branches, 95.47% functions, 87.65% lines.
- Package smokes, release Skill validator/install smoke, Skill tree hash regression, docs build, structured workflow/manifest test, and workflow YAML parse: passed.
- The strengthened live assertions compile and are discovered as nine skipped tests across the two targeted live files when their explicit environment gates are absent.
- `npm audit`: six development-tool findings (2 moderate, 2 high, 2 critical) in Vitest/Vite/VitePress dependency paths; `npm audit --omit=dev` reports zero production vulnerabilities. Do not apply an automatic audit fix during release preparation; review upgrades separately.
- Two independent real `npm pack` runs with the workflow-pinned npm `11.18.0` produced byte-identical engine and CLI tarballs. Both runs matched every committed integrity and SHA-256 field in `.github/releases/v0.6.0.json` exactly. npm 10.x produced the same bytes as an additional cross-version check.

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

```bash
export CONTROLLED_DOC='<dedicated-controlled-doc-url-or-token>'
npm run dev -- status packages/cli/test/fixtures/dialects/zdoc-authoring/hugging-face.md \
  --target "$CONTROLLED_DOC" --dialect zdoc-authoring --profile none --format json

npm run dev -- diff packages/cli/test/fixtures/dialects/zdoc-authoring/hugging-face.md \
  --target "$CONTROLLED_DOC" --dialect zdoc-authoring --profile none --format json
```

Save stdout, exit codes, target identity, document ID, revision, semantic hashes, operation summary, blockers, warnings, `zdocRoundTrip`, link resolution, and engine diagnostics. Compare with the pre-extraction fixture. Only explicitly additive engine diagnostic fields may differ. These commands must not include `--write`, `--create`, or any `--confirm-*` flag.

Current result: skipped because `CONTROLLED_DOC` is unset. Required input is one explicitly approved, non-production existing Feishu doc URL/token accessible to the configured identity.

## Exact live-write approval preview

This command is not approved or executed by preparation. It creates a uniquely named document only inside a dedicated disposable Drive folder, writes one nested list plus one native table through `feishu-docx-engine`, verifies the exact block tree, then deletes that same returned docx token in `finally`.

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

Current result: not executed. All three live-write gate variables are unset.

## Registry and ownership preflight

Read-only commands:

```bash
npm config get registry
npm whoami
npm owner ls feishu-md-sync
npm view feishu-md-sync dist-tags versions --json
npm view feishu-docx-engine dist-tags versions --json
```

Before first publish, verify in the protected GitHub `npm` environment:

- Trusted Publishing is configured for `liyun95/feishu-md-sync` and `.github/workflows/release.yml`.
- The job has `id-token: write` and no long-lived npm token is introduced.
- The release commit is merged into `main`; tag `v0.6.0` is immutable and points to that commit.
- Before any publish, the workflow must repack both artifacts and match name, version, npm integrity, and SHA-256 against `.github/releases/v0.6.0.json`.
- With `publishEngine: true`, the workflow publishes/reuses `feishu-docx-engine@0.1.0`, verifies registry integrity and its Sigstore provenance against the current tag/commit, and only then proceeds.
- With `publishEngine: false`, the workflow skips engine publication, requires the exact registry engine bytes, and verifies provenance against the prior tag/ref/commit recorded in the manifest. It must never rebind an independently released engine to the current CLI tag.
- The workflow installs the CLI candidate tarball in a clean temporary consumer without a local engine tarball or workspace link; ordinary npm resolution must install exactly `feishu-docx-engine@0.1.0`, then CLI `--version` and `publish --help` must pass before CLI publication.
- Existing versions are either absent or have byte-identical `dist.integrity`; a differing existing version is a hard stop.

## Exact npm external-action preview

Repository policy requires the reviewed tag workflow. Do not run the following until the dependency-ordered workflow, release notes, and release candidate commit are approved and merged.

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
test "$(git describe --tags --exact-match)" = 'v0.6.0'
REPO_ROOT="$(pwd)"
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
