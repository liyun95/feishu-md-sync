# Changelog

All notable changes to the published `feishu-md-sync` package are documented here.

## [0.3.0] - 2026-07-15

### Added

- Add `feishu-md-sync --version` so Agents and automation can verify CLI compatibility before operating.
- Add a machine-readable JSON error contract on stderr with stable error categories, subtypes, hints, retryability, required confirmation flags, and exit codes.
- Add one version-matched `$feishu-md-sync` Agent Skill for status, diff, publish, create, pull, merge, and explicit Whiteboard synchronization.
- Add automated CLI-contract, Skill-distribution, installation, and release-range validation.

### Changed

- Return exit code `10` for confirmation-required writes and preserve official `lark-cli` authentication, authorization, scope, hint, and confirmation details.
- Route Agent authentication and permission repair through `$lark-shared`, while leaving ad hoc remote-only editing to `$lark-doc`.
- Require the npm CLI and Agent Skill to come from the same release tag, with strict compatibility validation during tagged releases.

### Fixed

- Reject invalid output formats before Feishu IO and sanitize malformed or non-JSON `lark-cli` failures without leaking raw sensitive output.

## [0.2.0] - 2026-07-15

### Added

- Publish reconstructable HTML tables as scoped Feishu table updates, including one-level lists inside cells and row-level planning.
- Convert standalone PNG references with same-name local SVG files into editable Feishu Whiteboards through the opt-in `--sync-whiteboards` flow.
- Publish note and warning Callouts while preserving Feishu-managed titles, emoji, colors, container identity, and unrelated remote child edits.
- Publish top-level fenced Code blocks with language aliases, caption preservation, scoped creation, update, deletion, movement, and section reconcile.
- Report scope-aware status, diff, conflict, safety-gate, and semantic receipt information for tables, Callouts, Code blocks, and Whiteboards.

### Changed

- Make the published npm package and installed `feishu-md-sync` binary the primary onboarding path in user documentation.
- Fail closed when scoped correspondence or readback verification is unsafe instead of silently replacing the whole document.

### Fixed

- Preserve executable permissions on the generated CLI entrypoint and verify them in package smoke tests.

## [0.1.0] - 2026-07-10

### Added

- Introduce the `publish`, `pull`, `status`, `diff`, `merge`, and `doctor auth` CLI workflow.
- Integrate with the official `lark-cli` for Feishu authentication and document IO.
- Publish the initial public npm package with provenance.
