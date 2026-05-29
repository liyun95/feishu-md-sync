# Feishu Push Strategy Design

## Problem

The live `section-sync` experiment proved that the current implementation can write a Feishu section with block-level operations:

- A one-line paragraph edit wrote as one block-level `update`.
- A one-bullet insertion wrote as one block-level `create`.
- Neither tested case deleted and recreated the whole section.

The user-facing name is still misleading. `section-sync` describes the matching scope, not the write strategy. A user thinks in terms of intent:

> I changed local Markdown. Push the right changes to the existing Feishu document.

The tool should decide whether that push is best applied as a block patch, section replacement, or whole-document replacement. The user should review and approve the resulting plan, not pick an implementation granularity before the tool has inspected the local and remote state.

## Best-Practice Signals

The design follows these official-tool patterns:

- Git exposes one intent command, `git push`, while destructive overwrite behavior is guarded by explicit force modes such as `--force-with-lease`. Reference: https://git-scm.com/docs/git-push
- Terraform separates plan from apply. `terraform plan` produces an execution plan, and `terraform apply` performs the proposed changes after review. Reference: https://developer.hashicorp.com/terraform/cli/commands/plan and https://developer.hashicorp.com/terraform/cli/commands/apply
- Kubernetes uses declarative `apply` for the user intent, with `kubectl diff` available to preview object changes before applying. Reference: https://kubernetes.io/docs/tasks/manage-kubernetes-objects/declarative-config/
- rsync keeps one sync intent while supporting `--dry-run` and itemized output so operators review what would change before writing. Reference: https://download.samba.org/pub/rsync/rsync.1

The common pattern is:

1. Expose the user intent as the primary command.
2. Compute the concrete patch strategy internally.
3. Show a dry-run plan in human language.
4. Require stronger confirmation for broad or destructive writes.
5. Keep expert strategy overrides, but do not make them the normal workflow.

## Alternatives Considered

### Option A: Expose Three Workflow Skills

Create separate skills such as `feishu-block-sync`, `feishu-section-replace`, and `feishu-document-replace`.

Pros:

- Each write primitive is explicit.
- Advanced users can request the exact operation they want.

Cons:

- Normal users must understand implementation granularity before the tool has inspected the change.
- Agents may choose the wrong skill based on wording instead of evidence.
- Team rollout becomes noisy because the user-facing menu exposes internals.

Decision: reject as the default UX. Keep strategy overrides for advanced debugging only.

### Option B: Keep `feishu-section-sync` As The Main Workflow

Continue treating the current section workflow as the primary write path and improve its docs.

Pros:

- Smallest short-term change.
- It matches the currently tested live behavior.

Cons:

- The name still describes a scope, not the user intent.
- It does not naturally cover whole-document push or block-level push outside a named section.
- It keeps forcing users to decide the heading boundary before seeing the plan.

Decision: reject. The CLI and skills have not been rolled out to team users yet, so there is no need to preserve this workflow as a compatibility surface. Reuse the useful internals, but remove the old user-facing entry points.

### Option C: Single `feishu-push` Workflow With Auto Strategy

Expose one local-to-Feishu write workflow, compute the strategy internally, and gate risky plans.

Pros:

- Matches the user mental model: push local changes to Feishu.
- Lets the planner choose block, section, or document strategy from evidence.
- Keeps high-risk replacement visible at approval time without making it the first decision.
- Matches the plan/apply and dry-run patterns from mature tools.

Cons:

- Requires a clearer strategy plan object and better dry-run output.
- Requires docs and skills to be updated together so the new mental model is the only one users see.

Decision: choose this option.

## Product Decision

Add a new primary workflow named `feishu-push`.

`feishu-push` means:

> Push local Markdown changes to an existing Feishu document.

It becomes the only team-facing Markdown write workflow. Remove `feishu-section-sync` from the installable skill set and from normal docs navigation. The old name may remain only in historical experiment notes.

Keep `feishu-baseline-sync` as the opposite direction:

> Pull current Feishu content to local Markdown.

The top-level workflow model becomes:

| Intent | Skill | Direction | Normal user choice |
| --- | --- | --- | --- |
| Refresh local Markdown from Feishu | `feishu-baseline-sync` | Feishu -> local | yes |
| Push local Markdown changes to Feishu | `feishu-push` | local -> Feishu | yes |
| Work on SDK examples/reference/release notes | existing task skills | mixed | yes |
| Force one section or one strategy | advanced CLI flags | local -> Feishu | no, maintainer/debug only |

## Internal Strategies

`feishu-push` uses one planner with three write strategies.

### Strategy 1: `block-patch`

Use this when the local and remote structure can be aligned safely and the change is small.

Operations:

- update text-like blocks in place;
- create inserted block ranges;
- delete removed block ranges;
- preserve Feishu block IDs whenever possible.

Risk: low.

Default behavior: auto-select and allow normal dry-run/write approval.

### Strategy 2: `section-replace`

Use this when a unique heading scope is known and block-level diff is not safe enough, but the replacement can be bounded to that heading section.

Operations:

- match a unique Markdown heading locally and remotely;
- delete the remote section block range;
- create the new section blocks at the same boundary;
- preserve content outside the section.

Risk: medium.

Default behavior: auto-select only when the planner can prove the section boundary is unique and the dry-run clearly states that the section will be recreated. Require explicit approval text that names the section and block counts.

### Strategy 3: `document-replace`

Use this when local and remote differ too much for a safe bounded patch, or the user explicitly intends a full rewrite.

Operations:

- replace all comparable document children with the local Markdown output;
- update the whole-document receipt after successful readback.

Risk: high.

Default behavior: the dry-run may recommend this strategy, but write mode must require an explicit high-risk gate such as `--replace-all` or a typed confirmation. Normal `feishu-push --write` should not silently replace an existing non-empty Feishu document.

This preserves the product principle: the user did not need to pick the granularity up front, but the tool still refuses broad destructive writes without explicit approval.

## CLI Shape

Primary command:

```bash
md2feishu push <doc.md> '<feishu-doc>'
```

Default mode is dry-run. It prints the selected strategy and the planned operations.

Write mode:

```bash
md2feishu push <doc.md> '<feishu-doc>' --write
```

Useful options:

```bash
--scope heading:"FAQ"                # optional scope guard, not a strategy choice
--strategy auto|block-patch|section-replace|document-replace
--replace-all                        # required before document-replace writes
--format pretty|json
```

Clean-break changes:

- Remove `md2feishu sync --section` from the public command surface instead of documenting it as compatibility.
- Keep reusable implementation modules if they still serve `push --scope heading:"..."`.
- Do not install or document `feishu-section-sync` after `feishu-push` exists.

## User-Facing Plan Output

Dry-run output should lead with intent and risk, not low-level internal names.

Example for a small edit:

```text
Intent: push local Markdown to Feishu
Selected strategy: block-patch
Scope: FAQ section
Risk: low

Planned Feishu changes:
- update 1 paragraph block
- create 0 blocks
- delete 0 blocks

No content outside "FAQ" will be written.
Run with --write to apply this plan.
```

Example for a fallback:

```text
Intent: push local Markdown to Feishu
Selected strategy: section-replace
Scope: FAQ section
Risk: medium

Why: block-level patch is unsafe because block order or count changed.

Planned Feishu changes:
- delete 19 existing section blocks
- create 20 replacement section blocks
- preserve all content before and after "FAQ"

Approval required: confirm section replacement for "FAQ".
```

Example for a broad rewrite:

```text
Intent: push local Markdown to Feishu
Selected strategy: document-replace
Scope: entire document
Risk: high

Why: no unique safe section boundary and the diff is too large for block patching.

Planned Feishu changes:
- delete 121 existing blocks
- create 341 replacement blocks

Write refused by default. Re-run with --replace-all only if a full document rewrite is intentional.
```

## Planner Behavior

The planner should follow this order:

1. Read local Markdown and current Feishu blocks.
2. Normalize both sides through the same comparison model used by readback verification.
3. If an optional scope guard is supplied, restrict planning to that unique scope.
4. Try `block-patch`.
5. If block patch is unsafe and a unique heading scope exists, try `section-replace`.
6. If the change cannot be bounded, recommend `document-replace`.
7. Attach risk, reason, operation counts, receipt effect, and approval requirement to the plan.

The planner output should be a first-class object, not a side effect of the old `PatchPlan.operation` field. `replace-section` can remain internally, but user-facing output must not imply that a block-level update will delete and recreate the section.

## Skill Model

Add:

- `feishu-push`: primary local-to-Feishu write skill.

Keep:

- `feishu-baseline-sync`: primary Feishu-to-local read skill.

Remove from user-facing surfaces:

- `feishu-section-sync`: remove from install scripts and normal docs after `feishu-push` lands.
- Any older operation-specific write skills should remain removed or documented only as legacy.

The agent behavior for `feishu-push`:

1. Confirm the local file and Feishu target.
2. Refresh or verify baseline freshness when needed.
3. Run push dry-run.
4. Summarize selected strategy, scope, risk, operation counts, and fallback reason.
5. Ask for write approval only after the plan is understandable.
6. Apply the write.
7. Verify readback.
8. Ask the user to visually inspect Feishu for formatting and edit-history quality when the write touched rendered doc content.

## Receipt And Status UX

The current live test showed successful section-level block writes can leave whole-document `status` as `diverged` because section writes do not update the whole-document receipt.

`feishu-push` should make receipt effects explicit:

- `block-patch` writes a scoped operation record with affected block IDs or ranges. When the patch is bounded to a heading, the record also stores that heading.
- `section-replace` writes a section operation record with heading, before/after hashes, operation counts, and timestamp.
- `document-replace` updates the whole-document receipt after readback verification.

Future `status` should distinguish:

- unknown divergence;
- remote drift since baseline;
- local edits since baseline;
- verified Feishu writes made by this tool after the last whole-document baseline.

## Deliverables

- CLI: `md2feishu push` with dry-run by default, write mode, optional heading scope, strategy plan output, and high-risk replace-all gate.
- Workflow registry: replace `section-sync` with `push`, and make the workflow recipe describe plan, approval, write, readback, and visual verification.
- Skill: add `feishu-push`; remove `feishu-section-sync` from install scripts and user-facing skill docs.
- Docs: update README, `packages/cli/README.md`, quickstart, workflow chooser, command reference, safety gates, markdown support notes if needed, and agent skill pages.
- Docs: remove or redirect the Section Sync guide so users do not see two competing write workflows.
- Tests: cover planner strategy selection, plan output, write gates, skill installation manifest, and docs build.

## Migration Plan

Phase 1: Product docs and skill naming.

- Document `feishu-push` as the intended write workflow.
- Remove `feishu-section-sync` from installable skills and user-facing docs.
- Update workflow chooser language from "sync one section" to "push local changes to Feishu".

Phase 2: CLI planner.

- Add `md2feishu push`.
- Reuse existing `sync --section` and block-level planning internals.
- Add a strategy plan object with risk and approval metadata.
- Add pretty output for dry-run.
- Remove the old `sync --section` user-facing command path from CLI help, workflow docs, and skill recipes.

Phase 3: Safety gates.

- Require explicit approval for `section-replace`.
- Require `--replace-all` or typed confirmation for `document-replace`.
- Keep existing no-receipt initial overwrite protection.

Phase 4: Receipts and status.

- Add section operation records.
- Teach `status` to explain verified scoped writes.

Phase 5: Skill rollout.

- Install `feishu-push`.
- Remove noisy legacy write skills from the normal install set.

## Acceptance Criteria

- A team member can ask an agent to "push this local Markdown to Feishu" without knowing block/section/document strategy names.
- Dry-run always says selected strategy, scope, risk, operation counts, and whether Feishu will be written.
- Small paragraph edits use block-level `update` when safe.
- Small insertions use block-level `create` when safe.
- Unique-heading fallback can perform section replacement only after the plan names the section and counts.
- Whole-document replacement is never applied silently to an existing non-empty Feishu document.
- The workflow docs clearly separate pull baseline (`feishu-baseline-sync`) from push (`feishu-push`).
- README, package README, docs site, workflow chooser, command reference, safety gates, and agent skill docs all describe the new push workflow.
- `feishu-section-sync` is not installed, documented as a normal workflow, or shown in the workflow chooser after migration.

## Non-Goals

- Do not expose three normal user-facing skills for the three write granularities.
- Do not depend on Feishu official Markdown conversion for block-level writes unless it can preserve or map remote block IDs.
- Do not treat hash readback alone as the full UX verification for rendered docs; visual inspection remains part of high-confidence acceptance.
