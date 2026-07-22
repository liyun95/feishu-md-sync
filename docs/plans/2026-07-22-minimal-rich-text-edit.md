# Receipt-Aware Minimal Rich-Text Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Feishu Markdown Sync preserve unchanged receipt-mapped opaque components outside changed scopes and eventually update ordinary text through verified rich-text inline patches that retain block identity and formatting.

**Architecture:** Keep source inventory, semantic correspondence, operation planning, execution, readback, and receipt advancement as separate safety layers. The first independently releasable slice makes `Supademo.isShowcase` part of protected-resource identity and proves through `runPublish` dry-run behavior that an unchanged tracked ISV block does not block an unrelated text change; later slices introduce a three-way rich-text run model and a new low-risk inline operation without using raw global `str_replace`.

**Tech Stack:** TypeScript ESM, Vitest, Feishu/Lark Docx block trees, `feishu-docx-engine`, receipt V5 semantic snapshots.

---

## Design constraints

1. `Supademo.isShowcase` is semantic metadata, not syntax to discard. The canonical source forms `isShowcase` and `isShowcase="true"` both mean `true`; omission means `false`. Unsupported values and unknown attributes remain blockers.
2. A protected Supademo may be preserved only when local metadata agrees with the receipt on component ID, showcase mode, section, and ordinal, and the current remote add-on record agrees with the receipt on component ID, showcase mode, block ID, resource shape, token, section, ordinal, and recorded neighbouring fingerprints. Local neighbouring text may be an independently changed scope, so its fingerprint is not required to remain equal to the receipt.
3. Receipt V5 remains readable. `isShowcase` is optional on historical entries, but every newly emitted or naturally advanced protected-resource entry records the resolved boolean. Historical entries are upgraded only through the normal verified receipt-writing path.
4. "Outside changed scope" never means "ignore validation." It means the planner emits no operation for an identity-stable protected resource while still validating it before planning unrelated text operations. Changed, untracked, missing, ambiguously or multiply mapped, moved, or drifted resources fail closed.
5. Rich-text minimal editing is a later operation type, not an alias for Lark CLI `str_replace`. The planner must compare receipt baseline, local desired runs, and current remote runs; preserve block ID and unaffected runs; execute with revision preconditions; read back text plus marks; and advance the receipt only after style-aware verification.
6. The fallback order is rich-text inline patch, uniquely bounded plain-text replacement only when a single unstyled run proves it safe, full block replacement with collaboration-risk confirmation, anchored section reconciliation, and explicitly approved document replacement.

## File responsibility map

- `packages/cli/src/zdoc/component-inventory.ts` parses supported Supademo syntax and produces source diagnostics.
- `packages/cli/src/zdoc/types.ts` stores source-side component metadata.
- `packages/cli/src/semantic/types.ts` carries protected-resource identity across local and remote semantic documents.
- `packages/cli/src/semantic/local-document.ts` transfers inventory metadata into the local semantic node.
- `packages/cli/src/semantic/remote-document.ts` validates and decodes the Feishu Supademo add-on record.
- `packages/cli/src/receipts/publish-receipt.ts` persists verified protected-resource identity without breaking historical V5 receipts.
- `packages/cli/src/zdoc/protected-resource-plan.ts` performs local/receipt/remote fail-closed correspondence.
- `packages/cli/test/zdoc-component-inventory.test.ts` covers accepted and rejected source syntax.
- `packages/cli/test/zdoc-protected-resource-plan.test.ts` covers semantic identity, receipt upgrades, and drift.
- `packages/cli/test/run-publish.test.ts` exercises the public dry-run planning seam with a real receipt lifecycle.
- `docs/design/2026-07-16-zdoc-authoring-round-trip.md` documents Supademo showcase identity and preserve-only planning.
- Future rich-text files should be focused: `packages/cli/src/rich-text/runs.ts` for normalized runs, `packages/cli/src/publish/rich-text-patch-plan.ts` for three-way planning, and Docx engine operation/readback modules for execution and verification.

### Task 1: Formalize `Supademo.isShowcase` source syntax

**Files:**
- Modify: `packages/cli/src/zdoc/types.ts`
- Modify: `packages/cli/src/zdoc/component-inventory.ts`
- Test: `packages/cli/test/zdoc-component-inventory.test.ts`

- [ ] **Step 1: Write a failing inventory test for both canonical true forms**

Add a table-driven test that inventories `<Supademo id="demo" title="" isShowcase />` and `<Supademo id="demo" title="" isShowcase="true" />`, expects `kind: 'supademo'`, `componentId: 'demo'`, `isShowcase: true`, no blockers, and the readonly ISV placeholder.

- [ ] **Step 2: Run the focused test and confirm the old unsupported-component blocker**

Run: `npm run test --workspace=feishu-md-sync -- test/zdoc-component-inventory.test.ts`

Expected: FAIL because the current attribute parser accepts only quoted assignments and only `id`/`title`.

- [ ] **Step 3: Add the minimal typed parser**

Add `isShowcase: boolean` to `ZdocSupademoComponent`. Parse quoted attributes plus the bare `isShowcase` flag, allow only `id`, `title`, and `isShowcase`, map omission or `"false"` to `false`, and reject duplicate attributes, non-boolean values, malformed leftovers, and unknown attributes with `zdoc-component-unsupported`.

- [ ] **Step 4: Add a failing rejection test, then make it pass**

Cover `isShowcase="yes"`, `isShowcase={true}`, duplicate `isShowcase`, and `autoplay="true"`. Each must remain a blocker rather than being normalized or ignored.

- [ ] **Step 5: Run the focused test**

Run: `npm run test --workspace=feishu-md-sync -- test/zdoc-component-inventory.test.ts`

Expected: PASS.

### Task 2: Carry showcase identity through local, remote, and receipt models

**Files:**
- Modify: `packages/cli/src/semantic/types.ts`
- Modify: `packages/cli/src/semantic/local-document.ts`
- Modify: `packages/cli/src/semantic/remote-document.ts`
- Modify: `packages/cli/src/receipts/publish-receipt.ts`
- Test: `packages/cli/test/remote-semantic-document.test.ts`
- Test: `packages/cli/test/publish-receipt.test.ts`

- [ ] **Step 1: Write failing semantic tests**

Expect local protected resources to carry the inventory boolean and fixture-backed remote Supademo blocks to expose `isShowcase: false` and `isShowcase: true`. Add a malformed remote record case where `isShowcase` is absent or non-boolean and expect the block to remain opaque instead of guessing.

- [ ] **Step 2: Run the focused tests**

Run: `npm run test --workspace=feishu-md-sync -- test/remote-semantic-document.test.ts test/publish-receipt.test.ts`

Expected: FAIL because protected-resource types currently store only component ID and remote shape.

- [ ] **Step 3: Add the minimal semantic and compatible receipt fields**

Add required `isShowcase: boolean` to source and semantic Supademo nodes. Add optional `isShowcase?: boolean` to `ProtectedResourceReceiptEntry` so existing V5 JSON remains readable, while new planner output always includes a boolean. Decode remote records only when both `id` and `isShowcase` have valid types.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm run test --workspace=feishu-md-sync -- test/remote-semantic-document.test.ts test/publish-receipt.test.ts`

Run: `npm run typecheck`

Expected: PASS.

### Task 3: Fail closed on changed or drifted showcase identity

**Files:**
- Modify: `packages/cli/src/zdoc/protected-resource-plan.ts`
- Test: `packages/cli/test/zdoc-protected-resource-plan.test.ts`

- [ ] **Step 1: Write a failing tracked-resource test**

Use local `isShowcase: true`, receipt `isShowcase: false`, and remote `isShowcase: false`. Expect `supademo-changed`, no replacement operation, and no silent preservation.

- [ ] **Step 2: Run the focused test**

Run: `npm run test --workspace=feishu-md-sync -- test/zdoc-protected-resource-plan.test.ts`

Expected: FAIL because showcase identity is not compared.

- [ ] **Step 3: Compare all three identities and upgrade historical entries**

For tracked mappings, require local and remote booleans to agree; when the receipt already records a boolean, require it to agree too. When a historical entry omits the field and local/remote agree, return an upgraded entry containing the verified boolean. Keep all existing shape, token, placement, and neighbour checks.

- [ ] **Step 4: Add untracked and remote-drift tracer bullets**

Untracked adoption with local `true` and remote `false` must produce `supademo-missing` rather than adopting. A tracked receipt/local `false` with remote `true` must produce `supademo-changed`.

- [ ] **Step 5: Run the focused test**

Run: `npm run test --workspace=feishu-md-sync -- test/zdoc-protected-resource-plan.test.ts`

Expected: PASS.

### Task 4: Prove unrelated text planning preserves the tracked opaque resource

**Files:**
- Modify: `packages/cli/test/run-publish.test.ts`
- Modify: `docs/design/2026-07-16-zdoc-authoring-round-trip.md`

- [ ] **Step 1: Write the failing public-behavior test**

Through `runPublish`, first adopt a unique remote Supademo whose record has `isShowcase: true`, producing receipt V5 without a remote write. Then change only an ordinary paragraph outside the component scope and run a publish dry-run. Assert:

```ts
expect(result.plan.zdocRoundTrip).toMatchObject({ safeToPublish: true });
expect(result.plan.zdocRoundTrip?.items).toContainEqual(expect.objectContaining({
  code: 'supademo-protected',
  remoteBlockId: 'isv1'
}));
expect(result.plan.scopedPatch?.operations).toEqual([
  expect.objectContaining({ kind: 'update' })
]);
```

Also assert the operation target is the changed text block and no operation targets `isv1`.

- [ ] **Step 2: Run the focused public test and confirm red**

Run: `npm run test --workspace=feishu-md-sync -- test/run-publish.test.ts -t "preserves a tracked showcase Supademo while planning unrelated text"`

Expected: FAIL before implementation because the source is blocked by `isShowcase`.

- [ ] **Step 3: Make the test green through Tasks 1-3 only**

Do not add a bypass flag and do not suppress global diagnostics. The public test must pass because the component is fully understood and its receipt-backed identity is verified.

- [ ] **Step 4: Add the public fail-closed companion**

After adopting `isShowcase: false`, change only the source component to `isShowcase`. Dry-run must have `safeToPublish: false`, include `supademo-changed`, and emit no Supademo write operation.

- [ ] **Step 5: Update the approved Zdoc design**

Document that showcase mode is part of protected identity, that omission means false, and that receipt-mapped unchanged resources are validated then preserved outside changed text scopes. State explicitly that changed, untracked, or drifted resources remain blockers.

- [ ] **Step 6: Run focused tests and static checks**

Run: `npm run test --workspace=feishu-md-sync -- test/zdoc-component-inventory.test.ts test/zdoc-protected-resource-plan.test.ts test/remote-semantic-document.test.ts test/run-publish.test.ts`

Run: `npm run typecheck`

Run: `git diff --check`

Expected: PASS.

### Task 5: Verify and commit the P0 protected-resource slice

**Files:**
- Verify all modified files from Tasks 1-4.

- [ ] **Step 1: Run repository verification**

Run: `npm test`

Run: `npm run test:coverage`

Run: `npm run build`

Run: `npm run docs:build`

Expected: PASS without live Feishu access.

- [ ] **Step 2: Review both axes**

Review standards against `AGENTS.md`, the TDD public seam, strict TypeScript, and receipt compatibility. Review spec behavior against this plan and the 2026-07-21 minimal-edit retrospective, especially changed/untracked/drifted fail-closed behavior.

- [ ] **Step 3: Commit the independent slice**

```bash
git add docs/plans/2026-07-22-minimal-rich-text-edit.md \
  docs/design/2026-07-16-zdoc-authoring-round-trip.md \
  packages/cli/src/zdoc/types.ts \
  packages/cli/src/zdoc/component-inventory.ts \
  packages/cli/src/semantic/types.ts \
  packages/cli/src/semantic/local-document.ts \
  packages/cli/src/semantic/remote-document.ts \
  packages/cli/src/receipts/publish-receipt.ts \
  packages/cli/src/zdoc/protected-resource-plan.ts \
  packages/cli/test/zdoc-component-inventory.test.ts \
  packages/cli/test/zdoc-protected-resource-plan.test.ts \
  packages/cli/test/remote-semantic-document.test.ts \
  packages/cli/test/run-publish.test.ts
git commit -m "Preserve tracked showcase Supademos"
```

### Task 6: Introduce normalized rich-text runs

**Files:**
- Create: `packages/cli/src/rich-text/runs.ts`
- Create: `packages/cli/test/rich-text-runs.test.ts`
- Modify: `packages/cli/src/semantic/types.ts`
- Modify: `packages/cli/src/semantic/local-document.ts`
- Modify: `packages/cli/src/semantic/remote-document.ts`

- [ ] Define immutable runs containing text, bold, italic, code, underline, strike, link href, foreground/background color, and exact whitespace.
- [ ] Add fixture-derived tests for inline code, formatted-boundary spaces, bold text, and links.
- [ ] Normalize local Markdown and remote Docx elements to the same model without coalescing runs whose marks differ.
- [ ] Store style-aware baseline data through the existing semantic snapshot rather than a parallel unmanaged sidecar.

### Task 7: Plan a three-way inline patch

**Files:**
- Create: `packages/cli/src/publish/rich-text-patch-plan.ts`
- Create: `packages/cli/test/rich-text-patch-plan.test.ts`
- Modify: `packages/cli/src/publish/scoped-patch-plan.ts`
- Modify: `packages/cli/src/publish/publish-plan.ts`

- [ ] Compare baseline-to-local run changes and prove the same target range is unchanged in current remote.
- [ ] Emit an inline operation only when block, character range, and run correspondence are unique.
- [ ] Preserve block ID, parent ID, non-target runs, links, formatting boundaries, and exact spaces.
- [ ] Report ambiguity and the selected fallback reason instead of guessing.

### Task 8: Execute and verify inline operations

**Files:**
- Modify: `packages/docx-engine/src/operations.ts` or the focused engine operation module selected by its current API.
- Modify: `packages/cli/src/publish/docx-engine-operations.ts`
- Modify: `packages/cli/src/publish/run-publish.ts`
- Create: `packages/cli/test/rich-text-patch-execution.test.ts`

- [ ] Add a typed rich-text element update primitive with revision precondition and idempotency key.
- [ ] Read back block ID, parent identity, visible text, every supported mark, link href, and whitespace boundaries.
- [ ] Stop as a partial write and do not advance the receipt when visible text matches but styling differs.
- [ ] Prove reruns are idempotent through receipt and remote semantic snapshots.

### Task 9: Refine fallback and risk classification

**Files:**
- Modify: `packages/cli/src/publish/publish-plan.ts`
- Modify: `packages/cli/src/publish/block-patch-plan.ts`
- Modify: `packages/cli/src/cli/output.ts`
- Test: `packages/cli/test/publish-plan.test.ts`
- Test: `packages/cli/test/publish-cli.test.ts`

- [ ] Classify verified block-identity-preserving inline patches as low risk.
- [ ] Keep full block update/delete under collaboration-risk confirmation.
- [ ] Display the exact changed runs, identity preservation, formatting delta, selection reason, fallback reason, and expected receipt advancement.
- [ ] Never auto-escalate an ambiguous inline patch to document replacement.

### Task 10: Add receipt-aware controlled-operation adoption

**Files:**
- Create: `packages/cli/src/publish/operation-adopt.ts`
- Create: `packages/cli/test/operation-adopt.test.ts`
- Modify: `packages/cli/src/cli/commands/publish.ts`
- Modify: `packages/cli/src/receipts/publish-baseline-bundle.ts`

- [ ] Accept only a CLI-generated, reviewed operation manifest containing target block, baseline hash, desired rich-text hash, expected revision, and readback assertions.
- [ ] Verify current remote state and completed effects before advancing the receipt.
- [ ] Reject arbitrary external surgery, stale revisions, partial style matches, and manually edited receipt state.

## P0 slice acceptance criteria

- Source inventory accepts real Zdoc bare and quoted-true `isShowcase` forms.
- A tracked local `isShowcase: true` resource matching receipt and remote state is validated and preserved while unrelated text gets a normal scoped operation.
- The Supademo remote block ID receives no create, update, move, or delete operation.
- Source showcase changes, remote showcase drift, missing mappings, ambiguous mappings, removal, shape/token drift, and placement drift remain blockers.
- New verified receipt entries record showcase identity; old V5 entries remain readable.
- No Feishu write, tag, release, or raw string replacement is part of this slice.
