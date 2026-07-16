# Zdoc Authoring Round-Trip Design

**Date:** 2026-07-16

**Status:** Approved for implementation planning

## Purpose

Replace the current `docusaurus` source dialect with a Zdoc-specific `zdoc-authoring` dialect. The dialect publishes canonical Zdoc Markdown to Feishu while preserving the body-level authoring constructs that a downstream production publishing workflow requires.

The downstream workflow may combine the Feishu document with its own scripts and templates. Feishu Markdown Sync therefore does not need to reconstruct the original frontmatter, imports, or byte-identical source file. It must preserve the registered body components whose identity or boundaries affect production publishing.

## Product Boundary

The supported source dialects become:

- `gfm` for generic Markdown.
- `milvus-authoring` for Milvus documentation authoring.
- `zdoc-authoring` for Zilliz Zdoc authoring.

The existing `docusaurus` dialect name is removed without a compatibility alias. This is an intentional breaking change while the CLI has a single active user and no external migration requirement.

`zdoc-authoring` reads the canonical Zdoc Markdown file directly. A manually maintained hidden Feishu publish view is not a supported source because it can remove authoring constructs before the CLI can inventory or protect them.

The `zilliz` publish profile remains responsible for Zilliz product-content transforms. The `zdoc-authoring` dialect is responsible for interpreting Zdoc source syntax and preserving registered authoring constructs.

## Round-Trip Contract

The dialect does not promise byte-level Markdown round trips. It promises that registered Zdoc body constructs remain usable by the downstream production publishing workflow.

| Zdoc construct | Feishu representation | Required invariant |
| --- | --- | --- |
| YAML frontmatter | Removed from the body | No reconstruction requirement |
| Import statements | Removed from the body | No reconstruction requirement |
| Explicit heading anchors | Removed from headings | No reconstruction requirement |
| Relative document links | Resolved by the existing link resolver | Link destination remains valid |
| `Admonition` | Native Feishu Callout | Type, title, and body remain correct |
| `Procedures` | Literal paragraph blocks | Open/close tokens and their exact local boundary remain correct |
| `Supademo` | Existing Feishu ISV resource block | Component-to-resource mapping and remote resource identity remain stable |
| Unknown body MDX component | No representation | Publish is blocked |

Ordinary Markdown may undergo presentation-level normalization such as ordered-list renumbering, table separator formatting, line wrapping, and equivalent whitespace changes. These differences must not hide real content or component-boundary changes.

## Zdoc Component Inventory

Before planning a write, the dialect scans the canonical source and creates a structured component inventory. The first registry contains `Procedures`, `Supademo`, and `Admonition`.

The inventory records:

- component name and source location;
- opening, closing, or self-closing form;
- relevant attributes such as the Supademo ID or Admonition title/type;
- enclosing section path;
- adjacent semantic content used for correspondence;
- whether the construct is preserved, transformed, ignored, or blocking.

Imports and frontmatter are reported as intentionally ignored source metadata rather than round-trip losses.

Unknown body components fail closed. The dialect must not allow all uppercase MDX or silently serialize unknown components as ordinary text.

## Procedures Authoring Tokens

`<Procedures>` and `</Procedures>` become first-class semantic authoring-token nodes rather than ordinary text nodes.

The canonical boundary is authoritative. For the model-provider fixture, the required structure is:

```md
To create a model provider integration:

<Procedures>

1. Log in...

</Procedures>
```

The token model must:

- reject unpaired or nested `Procedures` tokens;
- preserve exact opening and closing token spelling;
- keep ordinary text-node locators stable when tokens are inserted or removed;
- detect a missing opening or closing token;
- detect a token whose boundary differs from canonical local Markdown;
- plan an exact token create, delete, or move without rewriting surrounding content;
- verify the resulting boundary after a write.

Moving an existing token uses the adapter's block-move capability when available so its block identity can be retained. Moving or deleting an existing token requires collaboration-risk confirmation.

For the regression sequence:

- revision 790 should plan creation of the missing opening and closing tokens;
- revision 799 should plan moving the opening token from before the introductory paragraph to after it;
- unchanged ordered-list items and following paragraphs must not be reported as content updates merely because token nodes changed the sequence.

## Supademo Protected Resources

The first implementation supports adopting and protecting existing Feishu Supademo/ISV blocks. It does not create a new remote Supademo resource from a local component ID.

### Untracked adoption

An untracked local Supademo may correspond to a remote ISV block only when all of the following are true:

- the local Supademo and remote ISV block are in the same semantic section;
- exactly one unmatched local Supademo and one unmatched remote ISV block exist in that section;
- the ordinal placement is compatible;
- stable preceding and following semantic neighbours correspond;
- the remote block exposes the expected ISV/readonly resource shape.

The dry-run reports the proposed component ID to remote block mapping. The existing untracked-remote confirmation authorizes recording the mapping. Adoption does not replace, delete, copy, move, or otherwise rewrite the ISV block.

If the correspondence is missing or ambiguous, publishing is blocked.

### Receipt state

The publish receipt records, for each adopted Supademo:

- local Supademo component ID;
- remote block ID;
- remote resource type and token when exposed by Feishu;
- semantic section and ordinal;
- adjacent-content fingerprints used during adoption.

On later publishes, the planner uses the receipt mapping rather than rediscovering correspondence. It blocks when the remote block is missing, its type or token changed, or its placement no longer satisfies the protected-resource invariant.

Protected resources participate in document ordering as explicit anchors. They must not be dropped from the planning sequence as generic opaque nodes.

The available incident artifacts do not include raw anonymized ISV block JSON. Before implementing Feishu block-shape recognition, capture a read-only fixture or equivalent trustworthy adapter evidence. Do not guess a numeric block type.

## Admonition Conversion

Zdoc `Admonition` components convert to native Feishu Callouts.

The supported first-version attributes are the types and titles used by the regression source. The conversion preserves:

- Callout type;
- visible title;
- body block order and content.

Literal `<Admonition>` tags are not retained in the Feishu body, and the CLI does not promise to reconstruct their original import or exact MDX serialization.

Unsupported Admonition attributes or child structures are reported as blockers instead of being silently discarded.

## Round-Trip Loss Report

`status`, `diff`, and publish dry-run expose one structured Zdoc round-trip report. It contains:

- Procedures tokens: preserved, missing, misplaced, unpaired, or unexpected;
- Supademo resources: adopted, protected, missing, ambiguous, or changed;
- Admonitions: transformable or unsupported;
- intentionally ignored metadata: frontmatter, imports, and heading anchors;
- unknown body components with source locations;
- an overall `safeToPublish` result.

Any missing or unsafe registered body construct makes the publish plan blocked. Intentionally ignored metadata is informational and does not block.

The pretty output summarizes each item. JSON output keeps stable codes and structured fields so the Skill and other automation do not parse prose.

## Planning Model

The first slice adds two focused planners:

- an authoring-token planner for Procedures;
- a protected-resource planner for Supademo/ISV blocks.

The ordinary text, Callout, Code, table, and Whiteboard planners keep their current responsibilities.

This slice does not add a general mixed insert/delete/reorder algorithm for arbitrary ordinary blocks. Complex ordinary block changes that the current planner cannot reconcile remain blocked. Procedures changes do not require the general mixed planner because their dedicated planner uses exact semantic neighbours as insertion and movement anchors.

## Readback Verification

After any actual write, Feishu Markdown Sync fetches the remote block tree and Markdown again before recording success.

Verification requires:

- every Procedures pair exists;
- every Procedures boundary matches the canonical local source;
- every protected Supademo retains its recorded block ID, resource shape, and token when available;
- every supported Admonition is represented by the expected native Callout;
- no unknown component was silently omitted;
- all planned authoring-token operations reached their intended positions.

Receipt updates occur only after these assertions pass. A failed readback reports completed, failed, and pending operations through the existing partial-write error model and does not claim successful synchronization.

## Skill Workflow

The repository `feishu-md-sync` Skill is updated to:

- select `zdoc-authoring` for canonical Zdoc sources;
- use the canonical source rather than a hand-maintained hidden publish view;
- inspect the Zdoc component inventory and round-trip report before any write;
- stop when a Supademo mapping is missing or ambiguous;
- treat the local Procedures boundary as authoritative;
- review proposed Procedures moves and the affected block IDs;
- require readback verification of Procedures, Supademo, and Admonition state after writes;
- explain that manual block surgery leaves the remote untracked unless a receipt is explicitly adopted through the CLI.

The Skill continues to require explicit confirmation for untracked adoption and collaboration-risk operations. It never adds confirmation flags automatically from an error response.

## Documentation Changes

Implementation includes updates to:

- CLI help and source-dialect documentation;
- configuration reference examples using `zdoc-authoring`;
- Zdoc component-policy documentation;
- round-trip report and blocker examples;
- Supademo adoption and current create limitation;
- Procedures boundary and readback behavior;
- the repository `feishu-md-sync` Skill and its validator assertions;
- release or migration notes identifying the intentional removal of `docusaurus`.

No canonical Zdoc documentation source is changed as part of this implementation.

## Regression Fixtures

Add credential-free fixtures derived from:

- revision 790, where Procedures tokens are absent;
- revision 799, where the tokens exist but the opening boundary differs from canonical;
- a minimal canonical source excerpt containing Procedures, Supademo, and Admonition constructs;
- a read-only anonymized remote ISV block fixture once its actual shape is verified.

Tests cover:

- the hard dialect rename and rejection of `docusaurus`;
- component inventory and unknown-component blocking;
- Admonition-to-Callout conversion;
- stable text locators around authoring tokens;
- revision 790 token creation planning;
- revision 799 opening-token move planning;
- paired-token validation;
- unique untracked Supademo adoption;
- ambiguous or missing Supademo blocking;
- protected block identity verification from receipt state;
- round-trip report JSON and pretty output;
- Skill destination routing and readback requirements.

## Out of Scope

- Creating a new Feishu Supademo/ISV resource from a local component ID.
- Reconstructing byte-identical Zdoc source from Feishu.
- Restoring frontmatter or imports from Feishu.
- A general mixed ordinary-block insert/delete/reorder planner.
- Automatic bidirectional merge of arbitrary Zdoc MDX.
- Modifying the live incident document during implementation or verification.
