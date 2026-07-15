# Release Policy

This document defines how changes to the published `feishu-md-sync` package are classified, grouped into versions, and released.

## Release metadata

Each user-visible pull request should carry metadata in three independent dimensions.

### Change type

Change-type labels describe what kind of work the pull request contains:

| Label | Meaning |
| --- | --- |
| `enhancement` | A new capability or a meaningful improvement to existing behavior. |
| `bug` | A correction to behavior that was already intended to work. |
| `documentation` | Documentation-only changes. |
| `proposal` | A design or proposal that does not yet ship product behavior. |

### Release impact

Every pull request that can affect the published package must have exactly one release-impact label:

| Label | Version effect | Use when |
| --- | --- | --- |
| `release:major` | Major bump | The release intentionally introduces incompatible behavior or graduates the package to `1.0.0`. Before `1.0.0`, apply this only after an explicit maintainer decision. |
| `release:minor` | Minor bump | The pull request adds backward-compatible, user-visible functionality. |
| `release:patch` | Patch bump | The pull request fixes existing behavior without adding a major capability. |
| `release:none` | No bump by itself | The change affects only documentation, tests, CI, internal refactoring, or release infrastructure. |

When multiple pull requests are released together, the highest impact determines the version bump:

```text
major > minor > patch > none
```

For example, one minor feature plus two patch fixes produces a minor release.

### Area

Area labels identify the affected subsystem. They do not determine the version number.

| Label | Scope |
| --- | --- |
| `cli` | CLI commands, options, output, and runtime behavior. |
| `area:release` | npm packaging, publishing, versions, and release automation. |
| `area:table` | Markdown and Feishu table support. |
| `area:whiteboard` | SVG assets and Feishu Whiteboard support. |
| `area:callout` | Feishu Callout parsing and scoped publishing. |
| `area:code-block` | Fenced Markdown Code parsing, planning, and scoped Feishu publishing. |
| `agent` | Agent-facing workflows and integrations. |

Add more area labels only when a stable subsystem needs its own release-history filter.

### Skill impact

Every pull request declares one Agent Skill impact value in its description:

| Value | Use when |
| --- | --- |
| `update` | The change modifies commands, flags, JSON fields, exit codes, safety gates, recommended workflow sequencing, or routing with official Lark Skills. Update `skills/feishu-md-sync/` in the same release line. |
| `none` | The change preserves the Agent-facing contract, such as an internal refactor, performance improvement, or implementation-only bug fix. |

Skill impact does not independently determine the package version. It ensures the tagged Skill and tagged npm CLI remain compatible.

## Milestones and Git tags

A GitHub Milestone answers which planned version will contain a pull request. Assign user-visible changes to a version milestone before merging when the target version is known.

- Open milestones represent planned releases, such as `v0.2.0`.
- Close a milestone after its npm package and GitHub Release are published.
- Moving a pull request between milestones changes the release plan; it does not change Git history.

A Git tag is the immutable release anchor, not a planning marker. Do not create it while a version is merely planned. Create `vX.Y.Z` only after the dedicated Release PR is merged and ready to publish; pushing the tag starts npm publishing. The tag, npm provenance, GitHub Release, and package version must refer to that same release commit.

## Pull request workflow

Before a user-visible pull request is ready to merge:

1. Apply one change-type label.
2. Apply exactly one `release:*` label.
3. Apply the relevant area labels.
4. Assign the target version milestone, or state why the change is not assigned yet.
5. Add a short release-note sentence that describes the user-visible outcome.
6. Declare `Skill impact: update | none` and review the Skill when the Agent contract changes.

Use `release:none` for documentation or infrastructure work that should not independently trigger an npm version bump. Such work may still be mentioned in release notes when it materially affects installation, operation, or maintenance.

## Preparing a release

Create a dedicated Release PR rather than publishing directly from an arbitrary feature commit.

1. Review the target milestone and confirm all intended pull requests are merged.
2. Calculate the version from the highest `release:*` impact in the milestone.
3. Update `packages/cli/package.json` and `package-lock.json` to the target version.
4. Add or update the changelog and draft the GitHub Release notes from the milestone pull requests.
5. Run:

   ```bash
   npm test
   npm run test:coverage
   npm run typecheck
   npm run test:package
   npm run test:skill:release
   npm run docs:build
   ```

6. Run the live Feishu smoke tests with the dedicated test document and identity.
7. Merge the Release PR after all required checks pass.
8. Create and push the matching `vX.Y.Z` Git tag from the merged Release PR commit. Repository rules prevent matching release tags from being updated or deleted. The immutable tag triggers `Publish npm package`; approve its protected `npm` environment deployment. The workflow then publishes through npm Trusted Publishing, verifies the signed Sigstore provenance against that tag and commit, and creates the matching GitHub Release.
9. Install the released CLI and matching tagged Skill in an isolated environment, then run the Skill validation and a read-only Feishu dogfood.
10. Confirm the npm package, GitHub Release, and tagged Skill are available. If a post-publish step fails, rerun the same tag workflow; recovery accepts only matching package bytes and provenance from that exact tag commit.
11. Close the milestone.

`npm run test:skill` permits only an older pre-release development CLI while the next release is being assembled. Release PRs and tagged releases must use `npm run test:skill:release`, which rejects any CLI version outside the Skill's declared compatibility range.

Release notes must show both matching installation commands:

```bash
npm install --global feishu-md-sync@X.Y.Z
npx skills add 'liyun95/feishu-md-sync#vX.Y.Z' --skill feishu-md-sync --global --yes
```

## Current version map

| Version | Included work | State |
| --- | --- | --- |
| `v0.1.0` | New CLI surface, lark-cli onboarding, and initial npm packaging. | Published |
| `v0.2.0` | Executable packaging fixes, npm installation docs, scoped table publishing, editable Whiteboard assets, scoped Callouts, and first-class Code block publishing. | Published |
| `v0.3.0` | Agent-ready CLI contract, version-matched Agent Skill, structured failures, and Skill distribution validation. | Planned |

The current process uses GitHub labels and milestones as the release-planning source. If Changesets is introduced later, changeset files become the machine-readable version input while these labels remain useful for review and filtering.
