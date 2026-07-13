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

## npm Release

The initial npm artifact audit found that a local `dist/` could retain removed modules. Before this branch, `npm pack --dry-run` contained 279 files, including retired command and workflow code.

PR #30 added:

- a clean-before-build invariant for `packages/cli/dist/`
- an npm package smoke test that derives expected output from current `src/**/*.ts`
- tarball installation and packaged binary help verification
- package metadata, MIT license, repository links, and public provenance configuration
- normal CI coverage for the packaged artifact
- a protected GitHub Release workflow for npm publication
- README and landing-page language aligned with the default `none` onboarding path
- removal of tracked `docs/superpowers/` plans/specs; future skill artifacts stay under ignored `.superpowers/`

The cleaned artifact contains 74 files: 70 generated JavaScript/declaration files plus `package.json`, `README.md`, `LICENSE`, and `NOTICE`.

`feishu-md-sync@0.1.0` is published on npm with SLSA provenance:

- GitHub Release: <https://github.com/liyun95/feishu-md-sync/releases/tag/v0.1.0>
- npm package: <https://www.npmjs.com/package/feishu-md-sync>
- Primary installation: `npm install --global feishu-md-sync@latest`
- Registry install and `--help` were verified from a clean temporary directory.

The first publish used the protected `npm` GitHub environment and a short-lived bootstrap token. Configure npm Trusted Publishing for `release.yml` and then delete `NPM_PUBLISH_TOKEN` so future releases use OIDC only.

PR #31 contains a repository-checkout build fix so a clean `tsc` build preserves the executable bit required by `npm exec -- feishu-md-sync` on Unix-like systems. Registry-installed `0.1.0` was already executable because npm applies bin permissions during installation.

## Future Feature Candidates

Before starting a new feature, run grill-docs to align user stories and boundaries, then write an implementation plan.

- stronger create UX for Drive folders and Wiki parents
- local image upload and Feishu asset handling
- richer table, grid, and multi-column behavior
- inline text patching to reduce comment and anchor risk
- examples, recipes, CI/live-test documentation, and landing-page polish
- another real Quickstart dogfood run against a disposable test document
