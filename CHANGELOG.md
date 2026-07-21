# Changelog

All notable changes to the published `feishu-md-sync` package are documented here.

## Unreleased

## [0.6.0] - 2026-07-21

### Added

- Add the separately versioned `feishu-docx-engine` package with typed snapshots, deterministic mutation batches, nested-list and native-table creation, Whiteboard mutation, verified readback, and partial-write recovery evidence.

### Changed

- Route scoped Docx writes through the shared engine while keeping Markdown planning, confirmations, Base resolution, receipts, and CLI JSON contracts in `feishu-md-sync`.
- Pin the CLI package to `feishu-docx-engine` 0.1.0 and add consumer smoke tests that install both generated tarballs before exercising runtime exports, public types, `--version`, and `publish --help`.
- Publish the engine before the CLI in the protected tag workflow, require exact registry integrity before the dependent publish, and verify separate Sigstore provenance for both packages.
- Gate publication on a committed tag-keyed manifest containing both tarball integrities and SHA-256 hashes, and smoke the CLI candidate against the registry-resolved engine before publishing it.
- Install the tagged Agent Skill and released CLI in isolated locations after publication, compare the installed Skill tree hash with the tagged checkout, and validate their compatibility together.
- Update the version-matched Agent Skill to require `feishu-md-sync >=0.6.0 <0.7.0` and document engine-backed nested-list, native-table, and Whiteboard safety boundaries.

## [0.5.0] - 2026-07-20

### Added

- Add the `zdoc-authoring` round-trip dialect with Procedures token planning, managed Admonition titles, protected Supademo adoption, semantic canonicalization, and structured `zdocRoundTrip` safety reports.
- Add receipt V5 for protected Supademo resource identity and readback verification.
- Add explicit local-only `baseline adopt` so an operator can record an intentional L0/R0 divergence and publish only the later L0-to-L1 delta.
- Add read-only Base resolver slug aliases for canonical document names that differ from local filenames.

### Changed

- Remove the old generic Zdoc dialect name without a compatibility alias.
- Preserve nested list and text hierarchy through semantic snapshots, scoped planning, Docx writes, pull reconstruction, and strict readback verification.
- Reconcile scoped text, Code, Callout, and table operations against L0/R0 correspondence while keeping ambiguous or overlapping changes fail closed.
- Update the Agent Skill with baseline adoption, destination-role discovery, Zdoc authoring-archive verification, and partial-write recovery guidance.

### Fixed

- Verify post-create Callout and Procedures mutations before writing a receipt, and report recoverable partial-write details when creation succeeds but planning, mutation, readback, or receipt persistence fails.
- Match multiple Procedures pairs by exact semantic boundaries, report token deletion, block ambiguous deletion, and show required token creation during create dry-runs.
- Block removal of tracked Supademo placeholders so protected ISV mappings cannot be silently dropped from receipt V5.
- Checkpoint verified mutation prefixes after partial writes, use revision-aware scoped readback for eventually consistent tables, and resume without duplicating already-created blocks.
- Normalize equivalent Feishu table, Callout, Code-language, and trailing-empty-paragraph representations without weakening destructive replacement or collaboration-risk protection.
- Pull paragraph-wrapped or metadata-identified native Callouts when their type is unambiguous, while rejecting unknown custom Callout types.

## [0.4.0] - 2026-07-15

### Added

- Add explicit `gfm`, the former Zdoc source dialect, and `milvus-authoring` for deterministic publish preprocessing.
- Resolve configured relative document links through a read-only Feishu Base index with one-hour local caching and stale-cache fallback.
- Store dialect metadata, used link mappings, and the exact prior publish draft in receipt V4.

### Changed

- Add `--dialect` to status, diff, publish, and merge while keeping `gfm` as the default.
- Block automatic merge for Zdoc and Milvus authoring sources because Feishu cannot reconstruct source-only syntax.
- Update the version-matched Agent Skill to preserve one selected dialect and handle dialect/link diagnostics before writing.

### Fixed

- Keep link-resolution fingerprints stable when the same mapping moves between live Base reads and fresh or stale cache reads.
- Remove escaped Zdoc heading anchors without leaving a trailing backslash in the publish draft.

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
