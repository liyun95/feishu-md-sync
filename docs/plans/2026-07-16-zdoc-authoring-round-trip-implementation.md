# Zdoc Authoring Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Follow superpowers:test-driven-development for every production change and superpowers:verification-before-completion before reporting success. Do not commit or push unless the user explicitly asks.

**Goal:** Replace the presentation-oriented `docusaurus` dialect with `zdoc-authoring`, preserve Procedures boundaries, adopt and protect existing Supademo/ISV resources, emit a structured round-trip report, and update the Agent Skill and public documentation.

**Architecture:** Keep dialect preprocessing responsible for Zdoc syntax inventory and deterministic source transforms. Add first-class semantic nodes and focused planners for Procedures tokens and protected Supademo resources, leaving the general text planner conservative. Store adopted resource identity in a versioned publish receipt and verify token/resource invariants through block readback before writing the receipt.

**Tech Stack:** Node.js 20+, TypeScript ESM, Vitest, Commander, existing Lark CLI adapter, Markdown/Feishu semantic model.

---

## File Structure

### New files

- `packages/cli/src/zdoc/types.ts` — Zdoc component inventory, round-trip report, and protected-resource types.
- `packages/cli/src/zdoc/component-inventory.ts` — scan canonical Zdoc source, validate registered components, and transform imports, Admonitions, Supademo placeholders, and Procedures tokens.
- `packages/cli/src/zdoc/procedures-plan.ts` — plan Procedures create, move, and delete operations from semantic neighbours.
- `packages/cli/src/zdoc/protected-resource-plan.ts` — adopt and verify Supademo/ISV mappings.
- `packages/cli/src/zdoc/round-trip-report.ts` — combine source inventory, Procedures plan, and protected-resource plan into stable machine output.
- `packages/cli/src/semantic/markdown-equivalence.ts` — canonicalize verified Feishu Markdown serialization differences outside protected Code ranges.
- `packages/cli/src/semantic/feishu-table.ts` — convert local or remote Feishu table block shapes into one shared semantic table representation.
- `packages/cli/test/zdoc-component-inventory.test.ts` — registry and transform tests.
- `packages/cli/test/zdoc-procedures-plan.test.ts` — revision 790/799 planner tests.
- `packages/cli/test/zdoc-protected-resource-plan.test.ts` — Supademo adoption/protection tests.
- `packages/cli/test/zdoc-round-trip-report.test.ts` — report classification tests.
- `packages/cli/test/markdown-equivalence.test.ts` — table separator, ordered numbering, NBSP, and Code-protection tests.
- `packages/cli/test/fixtures/zdoc/model-providers/revision-790.md` — credential-free revision 790 Markdown fixture.
- `packages/cli/test/fixtures/zdoc/model-providers/revision-799.md` — credential-free revision 799 Markdown fixture.
- `packages/cli/test/fixtures/zdoc/model-providers/canonical-excerpt.md` — minimal canonical Zdoc excerpt containing Admonition, Supademo, and Procedures.
- `packages/cli/test/fixtures/zdoc/model-providers/isv-blocks.json` — anonymized, read-only remote ISV block shape captured from trustworthy adapter evidence.

### Renamed files

- `packages/cli/src/dialects/docusaurus.ts` → `packages/cli/src/dialects/zdoc-authoring.ts`
- `packages/cli/test/dialect-docusaurus.test.ts` → `packages/cli/test/dialect-zdoc-authoring.test.ts`
- `packages/cli/test/fixtures/dialects/docusaurus/hugging-face.md` → `packages/cli/test/fixtures/dialects/zdoc-authoring/hugging-face.md`
- `packages/cli/test/live-docusaurus-release-dogfood.test.ts` → `packages/cli/test/live-zdoc-authoring-release-dogfood.test.ts`

### Modified core files

- `packages/cli/src/dialects/types.ts`
- `packages/cli/src/dialects/preprocess.ts`
- `packages/cli/src/config/sync-config.ts`
- `packages/cli/src/publish/publish-context.ts`
- `packages/cli/src/semantic/types.ts`
- `packages/cli/src/semantic/local-document.ts`
- `packages/cli/src/semantic/remote-document.ts`
- `packages/cli/src/publish/scoped-patch-plan.ts`
- `packages/cli/src/publish/run-publish.ts`
- `packages/cli/src/publish/publish-plan.ts`
- `packages/cli/src/status/run-status.ts`
- `packages/cli/src/diff/run-diff.ts`
- `packages/cli/src/cli/output.ts`
- `packages/cli/src/receipts/publish-receipt.ts`
- related tests named in the tasks below.

### Modified Skill and documentation files

- `skills/feishu-md-sync/SKILL.md`
- `scripts/validate-agent-skill.mjs`
- `README.md`
- `CHANGELOG.md`
- `apps/docs/guide/agent-usage.md`
- `apps/docs/guide/configuration.md`
- `apps/docs/reference/commands.md`
- `apps/docs/reference/markdown-support.md`

## Task 1: Lock the incident sequence into local fixtures

**Files:**

- Create: `packages/cli/test/fixtures/zdoc/model-providers/revision-790.md`
- Create: `packages/cli/test/fixtures/zdoc/model-providers/revision-799.md`
- Create: `packages/cli/test/fixtures/zdoc/model-providers/canonical-excerpt.md`
- Create: `packages/cli/test/zdoc-fixtures.test.ts`

- [ ] **Step 1: Add the failing fixture-sequence test**

Add a test that reads the two exact incident snapshots and asserts that their line diff contains only the Procedures tokens and surrounding blank lines. Also assert the canonical boundary places the introductory paragraph before the opening token.

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const fixture = (name: string) => new URL(
  `./fixtures/zdoc/model-providers/${name}`,
  import.meta.url
);

describe('model provider Zdoc round-trip fixtures', () => {
  it('records revision 790 to 799 as a Procedures-only change', async () => {
    const before = await readFile(fixture('revision-790.md'), 'utf8');
    const after = await readFile(fixture('revision-799.md'), 'utf8');
    const withoutTokens = after
      .replace('\n<Procedures>\n\n', '\n')
      .replace('\n</Procedures>\n\n', '\n');

    expect(withoutTokens).toBe(before);
  });

  it('records the canonical Procedures boundary', async () => {
    const source = await readFile(fixture('canonical-excerpt.md'), 'utf8');
    expect(source.indexOf('To create a model provider integration:'))
      .toBeLessThan(source.indexOf('<Procedures>'));
    expect(source.indexOf('<Procedures>'))
      .toBeLessThan(source.indexOf('1. Log in'));
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
npm test --workspace=feishu-md-sync -- --run test/zdoc-fixtures.test.ts
```

Expected: FAIL because the three fixture files do not exist.

- [ ] **Step 3: Add the fixtures with `apply_patch`**

Use the exact credential-free Markdown from:

- `/Users/liyun/zdoc/.worktrees/hugging-face-integration/.context/hugging-face-integration/feishu/model-providers-remote-after-block-update.md`
- `/Users/liyun/zdoc/.worktrees/hugging-face-integration/.context/hugging-face-integration/feishu/model-providers-remote-after-user-edits.md`

Create `canonical-excerpt.md` from the canonical Create-integration section, retaining these exact constructs:

```md
<Admonition type="info" icon="📘" title="Billing">

Creating a model provider integration does not incur charges.

</Admonition>

## Create an integration in the Zilliz Cloud console

<Supademo id="cmj9f3j6u0johf6zpk5kdyx3u" title="" />

To create a model provider integration:

<Procedures>

1. Log in to the [Zilliz Cloud console](https://cloud.zilliz.com/login).

1. Click **Add**.

</Procedures>

Once created, the integration becomes available.
```

- [ ] **Step 4: Run the fixture test and verify GREEN**

Run the same command. Expected: 2 tests pass.

- [ ] **Step 5: Check the working tree without committing**

Run `git status --short` and confirm only intended fixture/test/design/plan files are present.

## Task 2: Hard-rename the dialect to `zdoc-authoring`

**Files:**

- Rename: `packages/cli/src/dialects/docusaurus.ts` → `packages/cli/src/dialects/zdoc-authoring.ts`
- Rename: `packages/cli/test/dialect-docusaurus.test.ts` → `packages/cli/test/dialect-zdoc-authoring.test.ts`
- Rename: `packages/cli/test/fixtures/dialects/docusaurus/hugging-face.md` → `packages/cli/test/fixtures/dialects/zdoc-authoring/hugging-face.md`
- Rename: `packages/cli/test/live-docusaurus-release-dogfood.test.ts` → `packages/cli/test/live-zdoc-authoring-release-dogfood.test.ts`
- Modify: `packages/cli/src/dialects/types.ts`
- Modify: `packages/cli/src/dialects/preprocess.ts`
- Modify: `packages/cli/src/config/sync-config.ts`
- Modify: `packages/cli/src/cli/commands/core.ts`
- Modify: `packages/cli/src/cli/commands/publish.ts`
- Test: `packages/cli/test/sync-config.test.ts`
- Test: `packages/cli/test/cli-help-surface.test.ts`
- Test: `packages/cli/test/publish-context.test.ts`
- Test: `packages/cli/test/publish-receipt.test.ts`
- Test: `packages/cli/test/run-merge.test.ts`

- [ ] **Step 1: Change tests first to require the new name**

Update expectations to use:

```ts
export const DIALECT_NAMES = ['gfm', 'zdoc-authoring', 'milvus-authoring'] as const;
```

Add an explicit rejection assertion:

```ts
expect(() => resolveDialect({
  cliDialect: 'docusaurus',
  config: { profiles: {}, dialects: {} }
})).toThrow(
  'Invalid --dialect docusaurus. Expected gfm, zdoc-authoring, or milvus-authoring.'
);
```

Update help tests to expect:

```text
source dialect: gfm | zdoc-authoring | milvus-authoring
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/sync-config.test.ts \
  test/cli-help-surface.test.ts \
  test/publish-context.test.ts \
  test/publish-receipt.test.ts \
  test/run-merge.test.ts
```

Expected: failures containing the old `docusaurus` union value and help text.

- [ ] **Step 3: Rename files and update production dispatch**

Use `apply_patch` moves for tracked files. Change `DialectName`, preprocessing dispatch, error messages, help text, config keys, receipt fixtures, and live dogfood names to `zdoc-authoring`. Export:

```ts
export async function preprocessZdocAuthoring(input: {
  sourcePath: string;
  markdown: string;
  config: DialectWorkspaceConfig;
  linkResolver?: DocumentLinkResolver;
}): Promise<DialectResult>;
```

Do not leave a runtime alias for `docusaurus`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Expected: all selected tests pass.

- [ ] **Step 5: Search for stale executable references**

Run:

```bash
rg -n "docusaurus|Docusaurus" packages/cli/src packages/cli/test
```

Expected: no executable or test references. Documentation and the design's historical explanation may still mention the removed name until Task 12.

## Task 3: Add the Zdoc component inventory and deterministic transforms

**Files:**

- Create: `packages/cli/src/zdoc/types.ts`
- Create: `packages/cli/src/zdoc/component-inventory.ts`
- Modify: `packages/cli/src/dialects/types.ts`
- Modify: `packages/cli/src/dialects/zdoc-authoring.ts`
- Create: `packages/cli/test/zdoc-component-inventory.test.ts`
- Modify: `packages/cli/test/dialect-zdoc-authoring.test.ts`

- [ ] **Step 1: Write failing inventory tests**

Define the desired public types in the test:

```ts
type ZdocComponentInventory = {
  components: Array<{
    kind: 'procedures' | 'supademo' | 'admonition' | 'unknown';
    sourceLine: number;
    sectionPath: string[];
    status: 'preserved' | 'transformed' | 'blocking';
    componentId?: string;
    token?: 'open' | 'close';
  }>;
  ignoredMetadata: Array<{
    kind: 'frontmatter' | 'import' | 'heading-anchor';
    sourceLine: number;
  }>;
};
```

Test the canonical excerpt:

```ts
const result = await preprocessFixture('canonical-excerpt.md');

expect(result.zdoc?.inventory.components).toEqual(expect.arrayContaining([
  expect.objectContaining({ kind: 'admonition', status: 'transformed' }),
  expect.objectContaining({
    kind: 'supademo',
    status: 'preserved',
    componentId: 'cmj9f3j6u0johf6zpk5kdyx3u'
  }),
  expect.objectContaining({ kind: 'procedures', token: 'open', status: 'preserved' }),
  expect.objectContaining({ kind: 'procedures', token: 'close', status: 'preserved' })
]));
expect(result.markdown).toContain('<readonly-block type="isv"></readonly-block>');
expect(result.markdown).toContain('<Procedures>');
expect(result.markdown).toContain('</Procedures>');
expect(result.markdown).toContain('<div class="alert note">');
expect(result.markdown).not.toContain('<Admonition');
expect(result.blockers).toEqual([]);
```

Add tests that unpaired Procedures, nested Procedures, unsupported Admonition children, and `<Tabs>` produce stable blocker codes.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/zdoc-component-inventory.test.ts \
  test/dialect-zdoc-authoring.test.ts
```

Expected: module-not-found/type failures for the new inventory interface.

- [ ] **Step 3: Implement the minimal registry scanner**

Add these stable codes:

```ts
export type ZdocDiagnosticCode =
  | 'zdoc-procedures-unpaired'
  | 'zdoc-procedures-nested'
  | 'zdoc-admonition-unsupported'
  | 'zdoc-component-unsupported';
```

Implement `inventoryAndTransformZdoc` with this interface:

```ts
export function inventoryAndTransformZdoc(input: {
  sourcePath: string;
  markdown: string;
  lineOffset: number;
}): {
  markdown: string;
  inventory: ZdocComponentInventory;
  blockers: DialectDiagnostic[];
};
```

Required transformation order:

1. Ignore protected code ranges.
2. Remove top-level `import` and `export` lines and record them as ignored metadata.
3. Convert supported `Admonition` pairs to existing canonical Callout HTML.
4. Replace each self-closing `Supademo` with exactly `<readonly-block type="isv"></readonly-block>` while retaining the component ID in inventory order.
5. Preserve standalone `<Procedures>` and `</Procedures>` lines verbatim.
6. Block any remaining uppercase body component.

Extend `DialectResult` with:

```ts
zdoc?: {
  inventory: ZdocComponentInventory;
};
```

- [ ] **Step 4: Run tests and verify GREEN**

Expected: inventory and existing dialect tests pass.

- [ ] **Step 5: Refactor only after green**

Extract line/source-location helpers only if duplicate parsing logic remains between Admonition, Procedures, and Supademo handling. Re-run the same tests.

## Task 4: Preserve Zdoc Admonition titles in native Callouts

**Files:**

- Modify: `packages/cli/src/semantic/types.ts`
- Modify: `packages/cli/src/semantic/html-callout.ts`
- Modify: `packages/cli/src/callouts/callout-xml.ts`
- Modify: `packages/cli/src/publish/callout-plan.ts`
- Modify: `packages/cli/src/publish/run-publish.ts`
- Test: `packages/cli/test/html-callout.test.ts`
- Test: `packages/cli/test/callout-xml.test.ts`
- Test: `packages/cli/test/callout-plan.test.ts`
- Test: `packages/cli/test/run-publish.test.ts`

- [ ] **Step 1: Write failing managed-title tests**

Extend the Zdoc Admonition transform from Task 3 to produce canonical local HTML with an internal title attribute:

```html
<div class="alert note" data-fms-callout-title="Billing">

Creating a model provider integration does not incur charges.

</div>
```

Add `titleManaged?: true` to `SemanticCallout` and test:

```ts
expect(parseHtmlCallout(
  '<div class="alert note" data-fms-callout-title="Billing">\n\nBody.\n\n</div>',
  { sectionPath: [], kind: 'callout', ordinal: 0 }
)).toMatchObject({
  calloutType: 'note',
  titleManaged: true,
  title: { markdown: 'Billing' }
});
```

Test `renderCalloutXml` emits `<p>Billing</p>` instead of the configured default `Notes`. Add an untracked correspondence test requiring the remote native Callout title to equal the managed Zdoc title, and a tracked title-change test expecting a `callout-title-update` operation.

- [ ] **Step 2: Run Callout tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/html-callout.test.ts \
  test/callout-xml.test.ts \
  test/callout-plan.test.ts \
  test/run-publish.test.ts
```

Expected: the parser ignores `data-fms-callout-title`, XML still emits `Notes`, and no title operation exists.

- [ ] **Step 3: Implement managed Callout titles without changing generic Callout ownership**

Add:

```ts
export type CalloutTitleUpdateOperation = {
  kind: 'callout-title-update';
  locator: SemanticLocator;
  calloutBlockId: string;
  remoteBlockId: string;
  desiredMarkdown: string;
};
```

Rules:

- `parseHtmlCallout` sets `titleManaged: true` only when `data-fms-callout-title` is present;
- ordinary HTML Callouts without that attribute keep current Feishu-owned title behavior;
- `renderCalloutXml` uses the managed title when present and falls back to configured `Notes`/`Warning` otherwise;
- untracked adoption requires type, managed title, and adjacency correspondence;
- tracked managed-title changes use three-way comparison and emit `callout-title-update` only when the remote title did not change independently;
- conflicting local and remote title edits produce `remote-callout-conflict`;
- `calloutContentHash` includes the title only when `titleManaged` is true.

Execute `callout-title-update` with `replaceBlock` against the remote title paragraph and include it in collaboration-risk and readback verification.

- [ ] **Step 4: Run Callout tests and verify GREEN**

Expected: selected tests pass and existing generic Callout title-preservation tests remain unchanged.

## Task 5: Represent Procedures and Supademo as first-class semantic nodes

**Files:**

- Modify: `packages/cli/src/semantic/types.ts`
- Modify: `packages/cli/src/semantic/local-document.ts`
- Modify: `packages/cli/src/semantic/remote-document.ts`
- Modify: `packages/cli/src/semantic/normalize.ts`
- Modify: `packages/cli/src/publish/publish-context.ts`
- Test: `packages/cli/test/local-semantic-document.test.ts`
- Test: `packages/cli/test/remote-semantic-document.test.ts`
- Test: `packages/cli/test/semantic-normalize.test.ts`

- [ ] **Step 1: Write failing semantic tests**

Add the semantic node types expected by tests:

```ts
export type SemanticAuthoringToken = {
  kind: 'authoring-token';
  locator: SemanticLocator;
  component: 'Procedures';
  token: 'open' | 'close';
  markdown: '<Procedures>' | '</Procedures>';
  remoteBlockId?: string;
};

export type SemanticProtectedResource = {
  kind: 'protected-resource';
  locator: SemanticLocator;
  resourceKind: 'supademo';
  componentId?: string;
  remoteBlockId?: string;
  remoteToken?: string;
  remoteShape?: string;
};
```

Test that adding Procedures tokens does not shift ordinary text ordinals:

```ts
const without = localSemanticDocument('Intro.\n\n1. First.\n\nAfter.');
const withTokens = localSemanticDocument(
  'Intro.\n\n<Procedures>\n\n1. First.\n\n</Procedures>\n\nAfter.'
);

expect(withTokens.nodes.filter((node) => node.kind === 'text').map((node) => node.locator))
  .toEqual(without.nodes.filter((node) => node.kind === 'text').map((node) => node.locator));
```

Test local Supademo placeholder pairing by passing the inventory from `PublishContext`, and test remote Procedures paragraphs are classified as authoring tokens instead of text. Remote ISV recognition remains deferred until the fixture gate in Task 9.

- [ ] **Step 2: Run semantic tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/local-semantic-document.test.ts \
  test/remote-semantic-document.test.ts \
  test/semantic-normalize.test.ts
```

Expected: missing semantic kinds and locator kind errors.

- [ ] **Step 3: Implement semantic parsing**

Extend `SemanticLocator['kind']` with `'authoring-token' | 'protected-resource'` and include the new nodes in `SemanticNode`.

Change the local parser interface to accept optional Zdoc inventory:

```ts
export function localSemanticDocument(
  markdown: string,
  codeBlocks: CodeBlockConfig = DEFAULT_CODE_BLOCK_CONFIG,
  zdoc?: ZdocComponentInventory
): SemanticDocument;
```

Classification rules:

- exact standalone `<Procedures>` → opening authoring token;
- exact standalone `</Procedures>` → closing authoring token;
- each exact standalone `<readonly-block type="isv"></readonly-block>` pairs by occurrence with the next Supademo inventory entry and becomes a protected resource;
- the same placeholder without matching inventory remains an opaque local node and blocks Zdoc publishing later;
- remote text paragraphs containing exact Procedures tokens become authoring-token nodes;
- fixture-backed remote ISV recognition is added only after the read-only evidence gate in Task 9; until then, unknown remote resources remain opaque.

Pass `publishContext.zdoc?.inventory` when `run-publish` creates `localCurrent`.

- [ ] **Step 4: Run semantic tests and verify GREEN**

Expected: all selected semantic tests pass and existing Code/Callout/table nodes remain unchanged.

## Task 6: Canonicalize verified Feishu Markdown serialization differences

**Files:**

- Create: `packages/cli/src/semantic/markdown-equivalence.ts`
- Create: `packages/cli/src/semantic/feishu-table.ts`
- Create: `packages/cli/test/markdown-equivalence.test.ts`
- Modify: `packages/cli/src/semantic/local-document.ts`
- Modify: `packages/cli/src/semantic/remote-document.ts`
- Modify: `packages/cli/src/status/run-status.ts`
- Modify: `packages/cli/src/publish/scoped-patch-plan.ts`
- Test: `packages/cli/test/local-semantic-document.test.ts`
- Test: `packages/cli/test/remote-semantic-document.test.ts`
- Test: `packages/cli/test/run-status.test.ts`
- Test: `packages/cli/test/scoped-patch-plan.test.ts`

- [ ] **Step 1: Write failing equivalence tests from the incident evidence**

Define:

```ts
export function canonicalizeMarkdownSemantics(markdown: string): string;
```

Test these exact equivalences outside fenced Code blocks:

```ts
expect(canonicalizeMarkdownSemantics(
  '| A | B |\n|-|-|\n| x | y |'
)).toBe(
  '| A | B |\n| --- | --- |\n| x | y |'
);

expect(canonicalizeMarkdownSemantics('1. one\n2. two'))
  .toBe(canonicalizeMarkdownSemantics('1. one\n1. two'));

expect(canonicalizeMarkdownSemantics('Provider\u00a0name'))
  .toBe(canonicalizeMarkdownSemantics('Provider name'));

expect(canonicalizeMarkdownSemantics(
  '```md\n|-|-|\n2. literal\nA\u00a0B\n```'
)).toContain('|-|-|\n2. literal\nA\u00a0B');
```

Add a status test where a canonical table separator and Feishu's short separator produce `contentMatchesRemote: true`. Add a scoped-planner test showing ordered numbering and NBSP-only differences produce no operations.

Add a local semantic test requiring both separator spellings to produce a `SemanticTable` with the same headers, rows, row keys, and semantic hash as a remote Feishu table block.

- [ ] **Step 2: Run equivalence tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/markdown-equivalence.test.ts \
  test/local-semantic-document.test.ts \
  test/remote-semantic-document.test.ts \
  test/run-status.test.ts \
  test/scoped-patch-plan.test.ts
```

Expected: module-not-found failure and the table status test reports a mismatch.

- [ ] **Step 3: Implement the minimal protected-range canonicalizer**

Use existing `protectedCodeRanges` and process only unprotected source ranges. In those ranges:

- expand each table separator cell containing one or more hyphens to at least `---`, retaining optional leading/trailing alignment colons;
- normalize ordered-list markers at the start of a line to `1.` while preserving indentation;
- replace NBSP with an ordinary space;
- retain all ordinary text, link destinations, inline formatting, and line order.

Apply the canonicalizer:

- before `markdownToFeishuBlocks` in `localSemanticDocument`, so `|-|-|` is parsed as a table-shaped block rather than one paragraph;
- before `canonicalMarkdown` in status raw-content comparison;
- inside `textRepresentationsEquivalent` before visible-text comparison.

Extract the existing remote-table conversion into:

```ts
export function semanticTableFromFeishuBlock(
  block: FeishuBlock,
  locator: SemanticLocator
): SemanticTable;
```

Use it from both `remoteSemanticDocument` and `localSemanticDocument`. When the local Markdown parser returns block type 31, create a `SemanticTable` instead of a `SemanticTextBlock`. Execution metadata stripping must make the local and remote forms hash-equivalent when cell content is equal.

Do not add nested-list flattening, link-target equivalence, or a general Markdown formatter in this slice.

- [ ] **Step 4: Run equivalence tests and verify GREEN**

Expected: all selected tests pass, and fenced Code content remains byte-preserved.

## Task 7: Plan Procedures creation, movement, and deletion independently

**Files:**

- Create: `packages/cli/src/zdoc/procedures-plan.ts`
- Create: `packages/cli/test/zdoc-procedures-plan.test.ts`
- Modify: `packages/cli/src/publish/scoped-patch-plan.ts`
- Modify: `packages/cli/src/publish/run-publish.ts`
- Modify: `packages/cli/src/publish/partial-write-error.ts`

- [ ] **Step 1: Write revision 790 and 799 failing tests**

Define operations:

```ts
export type ProceduresOperation =
  | {
      kind: 'authoring-token-create';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      parentBlockId: string;
      insertAfterBlockId: string;
    }
  | {
      kind: 'authoring-token-move';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      remoteBlockId: string;
      insertAfterBlockId: string;
    }
  | {
      kind: 'authoring-token-delete';
      locator: SemanticLocator;
      token: '<Procedures>' | '</Procedures>';
      parentBlockId: string;
      remoteBlockId: string;
    };
```

For revision 790, assert exactly two creates and zero ordinary text operations. For revision 799, assert exactly one move of `<Procedures>` after the `To create...` paragraph and zero text updates.

Add paired deletion and ambiguous-anchor blocker tests.

- [ ] **Step 2: Run the planner test and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run test/zdoc-procedures-plan.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement neighbour-based token planning**

Expose:

```ts
export function planProceduresChanges(input: {
  parentBlockId: string;
  local: SemanticDocument;
  remote: SemanticDocument;
}): {
  operations: ProceduresOperation[];
  blockers: Array<{
    code: 'procedures-anchor-missing' | 'procedures-boundary-ambiguous';
    message: string;
  }>;
};
```

For every local token, find the nearest preceding non-token semantic node. Resolve that node in remote by locator plus semantic content hash. Create after that remote block when the token is missing. Move the existing token block when its current predecessor differs. Delete only when the complete local pair was intentionally removed and remote correspondence is unique.

Exclude authoring-token and protected-resource nodes from `planningEntries()` so the ordinary text planner cannot emit shifted text updates. Append Procedures operations to `ScopedPatchOperation` and mark move/delete as collaboration risk.

Extend `partitionScopedOperations` so token moves run in the move phase, creates in create, and deletes in delete. Execute token moves with `moveBlocksAfter`, creates with `insertBlocksAfter`, and deletes with `deleteBlocks`.

If a Procedures move is required but `moveBlocksAfter` is unavailable, return a structured planner blocker instead of entering the write phase.

- [ ] **Step 4: Add per-operation readback assertions**

`verifyOperation` must verify the token block exists immediately after its planned anchor and still contains the exact token text. Add summaries to the existing partial-write model.

- [ ] **Step 5: Run planner and scoped publish tests and verify GREEN**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/zdoc-procedures-plan.test.ts \
  test/scoped-patch-plan.test.ts \
  test/run-publish.test.ts \
  test/partial-write-error.test.ts
```

Expected: all selected tests pass.

## Task 8: Add the structured Zdoc round-trip report and block unsafe plans

**Files:**

- Create: `packages/cli/src/zdoc/round-trip-report.ts`
- Create: `packages/cli/test/zdoc-round-trip-report.test.ts`
- Modify: `packages/cli/src/publish/publish-context.ts`
- Modify: `packages/cli/src/publish/publish-plan.ts`
- Modify: `packages/cli/src/publish/run-publish.ts`
- Modify: `packages/cli/src/status/run-status.ts`
- Modify: `packages/cli/src/diff/run-diff.ts`
- Modify: `packages/cli/src/cli/output.ts`
- Test: `packages/cli/test/cli-output.test.ts`
- Test: `packages/cli/test/run-status.test.ts`
- Test: `packages/cli/test/run-diff.test.ts`
- Test: `packages/cli/test/publish-plan.test.ts`

- [ ] **Step 1: Write failing report tests**

Use this stable shape:

```ts
export type ZdocRoundTripReport = {
  safeToPublish: boolean;
  items: Array<{
    code:
      | 'procedures-preserved'
      | 'procedures-create'
      | 'procedures-move'
      | 'procedures-invalid'
      | 'supademo-adopt'
      | 'supademo-protected'
      | 'supademo-missing'
      | 'supademo-ambiguous'
      | 'supademo-changed'
      | 'admonition-transform'
      | 'metadata-ignored'
      | 'component-unsupported';
    severity: 'info' | 'warning' | 'blocker';
    component: string;
    message: string;
    sourceLine?: number;
    remoteBlockId?: string;
  }>;
};
```

Assert pretty output includes lines such as:

```text
zdoc[info][procedures-move]: move <Procedures> to the canonical boundary
zdoc[blocker][supademo-ambiguous]: no unique ISV correspondence
```

Assert JSON status, diff, and publish plan expose the same `zdocRoundTrip` object.

- [ ] **Step 2: Run report/output tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/zdoc-round-trip-report.test.ts \
  test/cli-output.test.ts \
  test/run-status.test.ts \
  test/run-diff.test.ts \
  test/publish-plan.test.ts
```

Expected: missing report fields and pretty lines.

- [ ] **Step 3: Implement report composition**

Expose:

```ts
export function buildZdocRoundTripReport(input: {
  inventory: ZdocComponentInventory;
  procedures: ReturnType<typeof planProceduresChanges>;
  protectedResources?: {
    items: ZdocRoundTripReport['items'];
    blockers: Array<{ code: string; message: string }>;
  };
}): ZdocRoundTripReport;
```

Before remote analysis, report source-only blockers such as invalid Procedures and unknown components. After remote analysis, merge Procedures and Supademo states. Add `zdocRoundTrip?: ZdocRoundTripReport` to `PublishContext`, `PublishPlan`, `PublishStatusResult`, and `RunDiffResult`.

When the inventory contains Supademo but no protected-resource analysis is available yet, emit `supademo-missing` as a blocker. Task 10 replaces that provisional blocker with adopted/protected results once verified ISV recognition and correspondence are available.

When `safeToPublish` is false, return `strategy: 'blocked'` and include stable report messages in `risks`; do not invoke write methods.

- [ ] **Step 4: Implement pretty output**

Render report items before ordinary planner warnings. Do not branch on the human message; use item codes and severity in tests and Skill behavior.

- [ ] **Step 5: Run report/output tests and verify GREEN**

Expected: all selected tests pass.

## Task 9: Capture and lock the real ISV block shape before implementing Supademo matching

**Files:**

- Create: `packages/cli/test/fixtures/zdoc/model-providers/isv-blocks.json`
- Modify: `packages/cli/test/remote-semantic-document.test.ts`

- [ ] **Step 1: Fetch the incident document blocks read-only**

Resolve the known Wiki token without writing:

```bash
lark-cli api GET /open-apis/wiki/v2/spaces/get_node \
  --params '{"token":"B1cSwfWcri4VJLkCR20cHIs6nCf"}' \
  --format json
```

Resolve and validate the document token in the shell without writing:

```bash
DOC_TOKEN="$(lark-cli api GET /open-apis/wiki/v2/spaces/get_node \
  --params '{"token":"B1cSwfWcri4VJLkCR20cHIs6nCf"}' \
  --format json | node -e 'let raw=""; process.stdin.on("data", chunk => raw += chunk); process.stdin.on("end", () => { const parsed = JSON.parse(raw); process.stdout.write(parsed.data.node.obj_token); });')"
test -n "$DOC_TOKEN"
```

Then fetch blocks with the same read-only endpoint used by `LarkCliAdapter.fetchDocBlocks`:

```bash
lark-cli api GET /open-apis/docx/v1/documents/$DOC_TOKEN/blocks \
  --params '{"page_size":500,"document_revision_id":-1}' \
  --format json
```

This step must not call `docs +update`, `publish --write`, or any mutation endpoint.

- [ ] **Step 2: Verify the two known protected IDs in the response**

The response must contain:

```text
XViWdTKb4ouwFJxEeepcSNQInLf
RYSAdAA9XojPNBxd0fqcZt42nEg
```

Record only the minimum structural fields needed to recognize ISV resources: anonymized block type, resource payload key, type discriminator, token field, parent/order references, and the two stable test block IDs. Remove unrelated document text and metadata.

If the blocks are unavailable, the IDs are absent, or the payload cannot distinguish ISV from other opaque blocks, stop Supademo implementation after Task 8 and report the evidence gap. Continue with Procedures, rename, reports, Skill, and documentation; do not guess.

- [ ] **Step 3: Write a failing remote semantic test from the captured shape**

The test must expect both fixture blocks to become:

```ts
expect.objectContaining({
  kind: 'protected-resource',
  resourceKind: 'supademo',
  remoteBlockId: 'XViWdTKb4ouwFJxEeepcSNQInLf'
});
```

- [ ] **Step 4: Run the remote semantic test and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run test/remote-semantic-document.test.ts
```

Expected: the fixture blocks are still generic opaque nodes.

- [ ] **Step 5: Implement fixture-backed ISV recognition and verify GREEN**

Add recognition using only the verified fields. Re-run the test and require it to pass.

## Task 10: Adopt and protect Supademo resources with receipt V5

**Files:**

- Create: `packages/cli/src/zdoc/protected-resource-plan.ts`
- Create: `packages/cli/test/zdoc-protected-resource-plan.test.ts`
- Modify: `packages/cli/src/receipts/publish-receipt.ts`
- Modify: `packages/cli/src/publish/run-publish.ts`
- Modify: `packages/cli/src/publish/scoped-patch-plan.ts`
- Test: `packages/cli/test/publish-receipt.test.ts`
- Test: `packages/cli/test/run-publish.test.ts`
- Test: `packages/cli/test/scoped-patch-plan.test.ts`

- [ ] **Step 1: Write failing unique-adoption and blocker tests**

Define receipt state:

```ts
export type ProtectedResourceReceiptEntry = {
  kind: 'supademo';
  componentId: string;
  blockId: string;
  remoteShape: string;
  remoteToken?: string;
  sectionPath: string[];
  ordinal: number;
  previousFingerprint?: string;
  nextFingerprint?: string;
};
```

Test these outcomes:

- one local Supademo plus one remote ISV in the same section and matching neighbours → `supademo-adopt`, no remote operation;
- two remote ISV candidates → blocker `supademo-ambiguous`;
- no remote ISV candidate → blocker `supademo-missing`;
- tracked block ID missing or token/type changed → blocker `supademo-changed`;
- protected resources remain in the ordering model but produce no text create/update/delete operations.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/zdoc-protected-resource-plan.test.ts \
  test/publish-receipt.test.ts \
  test/scoped-patch-plan.test.ts \
  test/run-publish.test.ts
```

Expected: missing planner and receipt V5 types.

- [ ] **Step 3: Implement the protected-resource planner**

Expose:

```ts
export function planProtectedResources(input: {
  local: SemanticDocument;
  remote: SemanticDocument;
  receiptEntries: ProtectedResourceReceiptEntry[];
}): {
  entries: ProtectedResourceReceiptEntry[];
  items: ZdocRoundTripReport['items'];
  blockers: Array<{
    code: 'supademo-missing' | 'supademo-ambiguous' | 'supademo-changed';
    message: string;
  }>;
};
```

For untracked adoption, match only inside the same section and require unique candidate count plus matching adjacent fingerprints. For tracked resources, resolve only by receipt block ID and verify shape/token/placement invariants.

- [ ] **Step 4: Add receipt V5**

Define:

```ts
export type PublishReceiptV5 = Omit<PublishReceiptV4, 'version'> & {
  version: 5;
  protectedResources: ProtectedResourceReceiptEntry[];
};
```

Add:

```ts
export function protectedResourceEntries(
  receipt: PublishReceipt | undefined
): ProtectedResourceReceiptEntry[] {
  return receipt?.version === 5 ? receipt.protectedResources : [];
}
```

No-op adoption writes receipt V5 only after untracked confirmation and successful readback. Existing V1–V4 receipts remain readable.

- [ ] **Step 5: Run focused tests and verify GREEN**

Expected: all selected tests pass.

## Task 11: Add end-to-end dry-run and write-readback regression coverage

**Files:**

- Modify: `packages/cli/test/run-publish.test.ts`
- Modify: `packages/cli/test/run-status.test.ts`
- Modify: `packages/cli/test/run-diff.test.ts`
- Modify: `packages/cli/test/partial-write-error.test.ts`

- [ ] **Step 1: Write a failing revision 790 dry-run integration test**

Build an in-memory adapter whose Markdown is revision 790 and whose block tree includes stable paragraph/list IDs plus the two fixture-backed ISV resources. Assert:

```ts
expect(result.plan.strategy).toBe('block-patch');
expect(result.plan.scopedPatch?.operations).toEqual(expect.arrayContaining([
  expect.objectContaining({ kind: 'authoring-token-create', token: '<Procedures>' }),
  expect.objectContaining({ kind: 'authoring-token-create', token: '</Procedures>' })
]));
expect(result.plan.scopedPatch?.operations.some((operation) => operation.kind === 'update'))
  .toBe(false);
expect(result.plan.zdocRoundTrip?.safeToPublish).toBe(true);
```

- [ ] **Step 2: Run and verify RED**

```bash
npm test --workspace=feishu-md-sync -- --run test/run-publish.test.ts
```

Expected: missing Zdoc plan/report behavior.

- [ ] **Step 3: Add revision 799 move test and simulated write readback**

The adapter records `moveBlocksAfter` calls and returns a mutated block order after the call. Assert only the opening Procedures token moves, both ISV IDs remain present, the final report is safe, and receipt V5 contains both protected mappings.

- [ ] **Step 4: Add readback failure coverage**

Return unchanged block order after the simulated move. Expect `PartialWriteError` with:

```ts
expect.objectContaining({
  receiptWritten: false,
  failedOperation: expect.objectContaining({ kind: 'authoring-token-readback' })
});
```

- [ ] **Step 5: Run publish/status/diff tests and verify GREEN**

```bash
npm test --workspace=feishu-md-sync -- --run \
  test/run-publish.test.ts \
  test/run-status.test.ts \
  test/run-diff.test.ts \
  test/partial-write-error.test.ts
```

Expected: all selected tests pass without live Feishu writes.

## Task 12: Update the Skill and public documentation test-first

**Files:**

- Modify: `scripts/validate-agent-skill.mjs`
- Modify: `skills/feishu-md-sync/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `apps/docs/guide/agent-usage.md`
- Modify: `apps/docs/guide/configuration.md`
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/reference/markdown-support.md`

- [ ] **Step 1: Make the Skill validator fail on the old workflow**

Add assertions:

```js
assert(skill.includes('zdoc-authoring'), 'Skill must route canonical Zdoc sources through zdoc-authoring');
assert(!skill.includes('docusaurus'), 'Skill must not reference the removed docusaurus dialect');
assert(skill.includes('canonical Zdoc source'), 'Skill must require the canonical source instead of a hidden publish view');
assert(skill.includes('zdocRoundTrip'), 'Skill must inspect the structured Zdoc round-trip report');
assert(skill.includes('Procedures'), 'Skill must verify Procedures boundaries');
assert(skill.includes('Supademo'), 'Skill must verify protected Supademo resources');
assert(skill.includes('readback'), 'Skill must require Zdoc readback verification');
```

- [ ] **Step 2: Run Skill validation and verify RED**

```bash
npm run build
node scripts/validate-agent-skill.mjs --allow-development-version
```

Expected: fail on the first missing `zdoc-authoring` assertion.

- [ ] **Step 3: Update the Skill**

Add a `Route Zdoc Authoring` section before source-dialect resolution:

```md
## Route Zdoc Authoring

When canonical Zdoc Markdown is published to a Feishu document that feeds the production publishing workflow, use `--dialect zdoc-authoring` with the canonical source file. Do not publish a hand-maintained hidden view.

Inspect `zdocRoundTrip` before writing. Stop when `safeToPublish` is false, a Procedures boundary is invalid, or a Supademo resource is missing, ambiguous, or changed. After a write, require readback verification of Procedures boundaries, Supademo block identity, and native Admonition Callouts before reporting success.
```

Replace all dialect option lists with `gfm`, `zdoc-authoring`, and `milvus-authoring`. Keep existing confirmation safety unchanged.

- [ ] **Step 4: Update public documentation**

Document:

- the hard rename;
- canonical source input;
- component policy table;
- Procedures create/move behavior;
- Supademo adoption-only limitation;
- `zdocRoundTrip` JSON and pretty examples;
- blocked unknown components;
- removal of hidden publish views;
- automatic merge remaining unsupported for `zdoc-authoring` and `milvus-authoring`.

Use this configuration example consistently:

```json
{
  "defaultDialect": "zdoc-authoring",
  "defaultProfile": "zilliz",
  "dialects": {
    "zdoc-authoring": {
      "publicSiteBaseUrl": "https://docs.zilliz.com/docs"
    }
  }
}
```

- [ ] **Step 5: Run Skill and docs verification and verify GREEN**

```bash
npm run test:skill
npm run docs:build
```

Expected: both commands exit 0.

## Task 13: Full verification and requirement audit

**Files:**

- Review all changed files; no new production files are added in this task.

- [ ] **Step 1: Verify no stale dialect references**

```bash
rg -n "docusaurus|Docusaurus" \
  packages/cli/src \
  packages/cli/test \
  skills \
  scripts \
  README.md \
  CHANGELOG.md \
  apps/docs
```

Expected: no stale product references. Historical wording in the approved design document is allowed.

- [ ] **Step 2: Run the full unit suite**

```bash
npm test
```

Expected: all non-live Vitest suites pass with zero failures.

- [ ] **Step 3: Run type checking**

```bash
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 4: Run coverage**

```bash
npm run test:coverage
```

Expected: repository coverage thresholds pass.

- [ ] **Step 5: Build CLI, Skill, and docs**

```bash
npm run build
npm run test:skill
npm run docs:build
```

Expected: all commands exit 0.

- [ ] **Step 6: Verify no generated artifacts or unrelated files are included**

```bash
git status --short
git diff --check
```

Expected: only intended source, tests, fixtures, Skill, documentation, design, and plan files appear. Generated `dist`, coverage, `.sync`, and zdoc files remain absent.

- [ ] **Step 7: Audit the approved design line by line**

Confirm evidence for every implemented requirement:

- `docusaurus` is removed and `zdoc-authoring` is the only Zdoc dialect name;
- canonical source is used directly;
- Procedures tokens are first-class and revision 790/799 regressions pass;
- Admonition produces native Callout structures;
- Supademo adoption is unique, receipt-backed, and preserve-only;
- unsafe or unknown components block through `zdocRoundTrip`;
- readback happens before receipt success;
- general mixed ordinary-block planning and Supademo creation remain out of scope;
- no live Feishu document or canonical zdoc source was modified.

Do not report completion unless the fresh verification outputs support every applicable claim.
