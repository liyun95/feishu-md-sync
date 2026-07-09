# Domain Glossary

## Sync Bridge

A tool that moves documentation content between local Markdown files and Feishu/Lark online documents or Wiki locations in an Agent-friendly way.

The sync bridge is centered on import, export, push, pull, diff, conflict handling, receipts, and verification. Product-specific documentation workflows are not part of the bridge itself unless they are expressed as optional transforms around this core movement of content.

## Local Markdown

The Markdown file in a local repository or workspace that an author or Agent edits before publishing or syncing to Feishu/Lark.

## Feishu Online Document

A Feishu/Lark collaborative document, typically docx-backed, that teammates can read, comment on, or edit online.

## Feishu Wiki Location

A location in a Feishu/Lark Wiki knowledge space where an online document or imported file can be placed for team knowledge sharing.

## Product-Specific Publish Transform

A configurable transformation applied when publishing local Markdown to Feishu/Lark for a specific documentation product or workflow, such as wrapping product names or applying include/exclude rules.

Product-specific publish transforms are adjacent to the sync bridge; they should not redefine the bridge's core responsibility.

## Publish Profile

A named set of product documentation rules applied before local Markdown is published to Feishu/Lark.

A publish profile can define content transforms, include/exclude handling, product-name markup, validation rules, and risk reporting. Initial profiles include Zilliz, Milvus, and None.

Zilliz profile treats local Markdown as a Zilliz Cloud documentation publish draft. Milvus profile treats local Markdown as a Milvus documentation publish draft. None profile skips product-specific transforms and applies only generic Markdown-to-Feishu/Lark publishing behavior.

Publish profiles represent publishing perspective, not target platform. The same local Markdown source can be rendered through different publish profiles.

## Publish Transform

The direction-specific transform from local Markdown to a Feishu/Lark publish draft.

Publish transforms may add include tags, rewrite product names, remove frontmatter, normalize local Markdown constructs, rewrite links, and produce warnings before content is written to Feishu/Lark.

For the Zilliz publish profile, version-qualified Milvus statements are Milvus-only content. The transform should treat the surrounding sentence or paragraph as Milvus-only rather than wrapping only the product-name token, because Zilliz Cloud tracks the latest Milvus core and should not publish stale version-gated wording.

The first-version granularity for version-qualified Milvus statements is sentence-level. If a paragraph contains only one such sentence, the result is effectively paragraph-level. Complex paragraphs may require a warning instead of an unsafe automatic rewrite.

For ordinary unversioned Milvus product-name mentions in the Zilliz publish profile, the publish transform may rewrite the product name into a dual-product include expression: `<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>`. This rule does not apply inside code, links, existing include tags, or other protected spans.

Headings are protected in the first-version Zilliz publish transform. Product-name or version-qualified Milvus mentions in headings should produce warnings rather than automatic rewrites, because heading changes affect section matching, anchors, and Feishu/Lark document structure.

## Pull Transform

The direction-specific transform from a Feishu/Lark publish draft back to local Markdown.

Pull transforms may filter include-tagged content, remove publish-only markup, and produce a local product view for editing. Pull transforms are related to publish transforms but are not their mirror image.

The first-version pull flow generates a local view from a remote Feishu/Lark publish draft. It does not automatically merge the remote view into an existing local Markdown file.

## Include Tag

The canonical syntax for conditional product content in Feishu/Lark publish drafts.

Include tags use HTML-like inline markup: `<include target="milvus">...</include>` and `<include target="zilliz">...</include>`. This syntax is part of the supported publish format rather than a legacy artifact. First-version support should document and test this syntax instead of introducing a second directive syntax.

Local Markdown does not have to contain include tags before publishing. A publish profile may add include tags when producing a Feishu/Lark publish draft. Pulling a Feishu/Lark publish draft back to local Markdown may filter or remove include-tagged content depending on the desired local product view.

## Product Name

The public-facing name of the sync bridge and CLI.

The preferred product and command name is Feishu Markdown Sync / `feishu-md-sync`. The older `md2feishu` command may remain as a compatibility alias, but it should not define the product's primary mental model because it implies one-way conversion rather than a sync bridge.

## Sync Configuration

The project-local configuration for Feishu Markdown Sync.

The first-version configuration file is `feishu-md-sync.config.json`. CLI flags override configuration values, configuration defaults override built-in defaults, and the fallback publish profile is None.

## Public Documentation

The user-facing documentation for the sync bridge.

Public documentation should present the new core only: quickstart, publish flows, publish profiles, safety model, configuration, and troubleshooting. Historical legacy workflows should be removed from the main documentation instead of documented as primary product capabilities.

## Live Feishu CI

A continuous integration test suite that exercises the new core against real Feishu/Lark resources.

Live Feishu CI is required for the first version and should gate merges once credentials and test resources are configured. Unit and fixture tests still cover deterministic local behavior, but the real Feishu/Lark publish and pull paths must be tested against live infrastructure.

Live Feishu CI should use isolated test resources: dedicated credentials, a test Drive folder, a test Wiki space or parent node, run-specific temporary documents, and cleanup that does not touch real team documentation.

## First Implementation Slice

The first implementation slice for the new core is existing-document Zilliz publish.

This slice starts with `feishu-md-sync publish <file.md> --target <existing-doc> --profile zilliz`, produces a dry-run publish plan, uses the Lark CLI adapter for the remote document boundary, supports a conservative write path, writes a publish receipt after success, and is covered by Live Feishu CI.

The first implementation slice may use guarded document replacement as its only real write strategy while block patch and section replace remain plan-only. This is a staged implementation choice to validate the new core end to end before enabling finer-grained writes.

## Product Documentation Sync Layer

The self-owned domain layer that prepares product documentation for movement between local Markdown and Feishu/Lark.

This layer owns product-specific transforms, publish intent, sync state, diff/conflict semantics, dry-run/write safety, and verification. It should prefer official Lark CLI capabilities for underlying Feishu/Lark operations.

## Feishu Adapter

The integration boundary that performs concrete Feishu/Lark operations for the sync bridge.

The preferred Feishu adapter is the official Lark CLI. Direct Feishu Open Platform API calls are reserved for gaps where the official CLI cannot express the required operation or cannot provide the reliability needed by the sync bridge.

The first-version new core treats the official Lark CLI as the default runtime dependency for Feishu/Lark operations. Core publish logic should depend on the Feishu adapter boundary rather than calling the CLI directly throughout the codebase.

## New Core

The replacement core for the sync bridge, built inside the existing repository while legacy workflows remain isolated.

The new core should define the future product boundary. Legacy workflow code can be migrated, retired, or split out after the new core proves the main documentation sync stories.

## Legacy Workflow

An existing workflow that grew around a specific historical team process, such as multi-SDK examples, SDK reference release, release notes, or harness grading.

Legacy workflows may remain useful, but they should not shape the primary sync bridge model or the default command surface.

Outdated implementation paths should be explicitly marked as legacy instead of silently remaining part of the primary architecture.

Legacy workflows may remain available under a legacy command namespace during migration. They should be removed from the main public documentation so the documented product model reflects the new core rather than historical automation paths.

## Legacy Feishu Client

The existing self-owned Feishu/Lark API client code from the pre-refactor system.

The legacy Feishu client should not be the default path for the new core. It may remain temporarily for old commands or be mined for direct API adapter capabilities when official Lark CLI support is insufficient.

## Publish Target

The Feishu/Lark destination for local Markdown content.

A publish target can be an existing online document that should be updated, a Drive folder where a new online document should be created, or a Wiki location where a new or existing online document should be organized.

Publish targets are provided as explicit URLs or tokens in the first version of the new core. Human-readable folder or knowledge-base paths are not first-version targets.

## Existing Remote Update

A publish flow where local Markdown updates an already-existing Feishu/Lark online document.

Existing remote updates must account for collaboration state already attached to the document, such as comments, block identity, and teammate edits.

## New Remote Publish

A publish flow where local Markdown creates a new Feishu/Lark online document and optionally places it in a Drive folder or Wiki location.

New remote publish can use a broader initial write strategy because there is no existing document collaboration state to preserve.

## Collaboration State

User-visible collaboration data attached to a Feishu/Lark online document, such as comments, mentions, anchors, and block-level context.

The sync bridge should treat collaboration state as part of the remote document's value, not as disposable formatting.

## Safe Existing Remote Update

An existing remote update that preserves collaboration state by default.

Safe existing remote updates must not delete and recreate the whole document as the default write path. If the sync bridge cannot produce a safe block-level or section-level write plan, it should stop with a dry-run risk report instead of silently falling back to whole-document replacement.

## Destructive Replacement

An explicit write strategy that replaces an existing online document broadly enough to risk losing collaboration state.

Destructive replacement is allowed only when the caller intentionally opts into that risk. It should never be selected automatically for an existing remote update.

Destructive replacement is part of the first-version strategy set because some real publish flows require whole-document replacement. The safety boundary is an explicit guardrail and human confirmation, not removing the strategy from the product.

Destructive replacement requires separate permission to write and permission to use the destructive strategy. A caller may generate a dry-run destructive plan without writing, and a caller may allow safe writes without allowing destructive replacement.

## Publish Command

The primary user-facing command for moving local Markdown to Feishu/Lark.

The publish command is story-oriented rather than strategy-oriented. It accepts local Markdown, a publish target, and a publish profile, then produces a publish plan that may create a new remote document or safely update an existing one.

## Pull Command

The user-facing command for generating a local Markdown view from a Feishu/Lark online document.

The first-version pull command is explicit and one-directional. It should not imply automatic bidirectional sync or merge.

## Sync Command

A future command concept for bidirectional coordination between local Markdown and Feishu/Lark.

The first version of the new core does not include a new sync command. Historical sync behavior may remain under the legacy namespace during migration.

## Publish Plan

A dry-run-first description of what the publish command intends to do.

A publish plan identifies the target type, selected publish profile, content transforms, write strategy, collaboration-state risk, required permissions, and whether the plan is safe to execute.

## Publish Receipt

A local record written after a successful publish.

A publish receipt records the local source hash, transformed publish draft hash, remote snapshot hash or revision, and target identity from the last successful publish. It is used to detect whether an existing remote document changed after the last publish before planning another write.

Local source hashes and remote snapshot hashes are not directly interchangeable because local Markdown, transformed publish drafts, and fetched remote content are different representations.

## Untracked Remote

An existing Feishu/Lark online document that has no publish receipt for the current local workspace.

Untracked remotes can still be dry-run and may be written when the publish plan is conservative and the target structure is stable. Their publish plans should carry higher risk because the sync bridge cannot prove whether remote content changed since a previous local publish.

## Auto Strategy

The default strategy selection mode for the publish command.

Auto strategy selects the lowest-risk write strategy that can satisfy the publish plan. For existing remote updates, auto strategy may select no-op, block patch, or section replace. It may recommend destructive replacement, but it must not automatically select destructive replacement for execution.
