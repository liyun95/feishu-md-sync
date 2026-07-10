# Handoff

## Landed Baseline

PR #28 merged the new `feishu-md-sync` CLI surface:

- `publish`: dry-run or write local Markdown to an existing document, or create a new document under a Drive folder or Wiki parent.
- `pull`: save a reviewable remote Markdown snapshot.
- `status`: report local, remote, and receipt state with a recommended next action.
- `diff`: compare current remote Markdown with the local publish draft.
- `merge`: merge remote edits into the local Markdown source, with check, dry-run, conflict, and abort behavior.
- `doctor auth`: inspect `.env` loading and the selected official `lark-cli` identity without printing credentials.

PR #28 also removed the old `sync`, `push`, `publish-new`, workflow, harness, multisdk, reference, release, and code-block command surfaces.

PR #29 merged the onboarding baseline:

- Official `lark-cli` owns Feishu authentication, API credentials, and document IO.
- `feishu-md-sync` owns profiles, receipts, safety gates, status, diff, pull, merge, and publish UX.
- Quickstart follows one default-`none` path from `lark-cli auth login` through dry-run publish, confirmed first write, and final clean status.
- Bot, CI, App ID, and App Secret setup live in Configuration rather than the main Quickstart.
- Normal CI and `live-feishu` passed for PR #29.
- Live CI uses `LARK_TEST_APP_ID`, `LARK_TEST_APP_SECRET`, and `FEISHU_MD_SYNC_TEST_DOC`; it does not use a generic production-shaped secret.

## npm Release Readiness

Current branch: `codex/npm-release-readiness`.

The initial npm artifact audit found that a local `dist/` could retain removed modules. Before this branch, `npm pack --dry-run` contained 279 files, including retired command and workflow code.

This branch adds:

- a clean-before-build invariant for `packages/cli/dist/`
- an npm package smoke test that derives expected output from current `src/**/*.ts`
- tarball installation and packaged binary help verification
- package metadata, MIT license, repository links, and public provenance configuration
- normal CI coverage for the packaged artifact
- a protected GitHub Release workflow for npm publication
- README and landing-page language aligned with the default `none` onboarding path
- removal of tracked `docs/superpowers/` plans/specs; future skill artifacts stay under ignored `.superpowers/`

The cleaned artifact contains 74 files: 70 generated JavaScript/declaration files plus `package.json`, `README.md`, `LICENSE`, and `NOTICE`.

## Release Operator Steps

After this branch is merged through a pull request:

1. Create a protected GitHub environment named `npm`.
2. Add a short-lived `NPM_PUBLISH_TOKEN` environment secret for the first publication because the package does not exist yet.
3. Publish GitHub Release `v0.1.0`; `.github/workflows/release.yml` verifies the tag, tests the artifact, and publishes with provenance.
4. Configure npm Trusted Publishing for `liyun95/feishu-md-sync`, workflow `release.yml`, environment `npm`, action `npm publish`.
5. Delete `NPM_PUBLISH_TOKEN` so later releases use OIDC only.
6. Verify `npm view feishu-md-sync` and `npx --yes feishu-md-sync@0.1.0 --help`.
7. Update Quickstart from source checkout installation to the published npm installation path in a follow-up docs PR.

Do not publish or create the GitHub Release from an unmerged feature branch.

## Future Feature Candidates

Before starting a new feature, run grill-docs to align user stories and boundaries, then write an implementation plan.

- stronger create UX for Drive folders and Wiki parents
- local image upload and Feishu asset handling
- richer table, grid, and multi-column behavior
- inline text patching to reduce comment and anchor risk
- examples, recipes, CI/live-test documentation, and landing-page polish
- another real Quickstart dogfood run against a disposable test document
