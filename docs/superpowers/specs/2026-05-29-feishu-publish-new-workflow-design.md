# Feishu Publish-New Workflow Design

## Problem

`feishu-push` is intentionally scoped to an existing Feishu docx or wiki document. It reads a known remote target, compares local Markdown with the remote state, chooses a safe patch strategy, and protects existing content.

The missing workflow is first publication:

> I have a local Markdown file, but no corresponding Feishu document exists yet. Publish it to a governed Feishu destination, return a stable URL, and create the local binding needed for later `feishu-push`.

This workflow should be separate from `feishu-push` because the hard parts are destination selection, document creation, same-title handling, discoverability, initial verification, and receipt binding. Those concerns are not patch-strategy concerns.

## Source Requirements

This design is based on issue 20 and the research note in `docs/superpowers/specs/2026-05-29-feishu-publish-new-workflow-research.md`.

Required deliverables:

- Add `md2feishu publish-new`.
- Add a `feishu-publish-new` Codex skill.
- Add a workflow registry entry.
- Document first-publication configuration and permissions.
- Keep default behavior as dry-run.
- Refuse writes without an explicit or configured destination.
- Show title, destination, creation strategy, document type, and wiki move behavior before writing.
- Detect same-title candidates in the destination and force an explicit choice.
- Write a receipt only after readback verification succeeds.
- If wiki move fails, report the Drive doc URL and do not claim wiki publication succeeded.
- Add fake-client tests for dry-run, creation, readback, receipt, destination validation, and same-title handling.
- Run a live smoke test against a disposable Feishu destination before treating the feature as production-ready.

## Product Decision

Add a new workflow named `feishu-publish-new`.

`feishu-publish-new` means:

> Publish a local Markdown file to a new Feishu docx destination for the first time.

The intended workflow sequence is:

```bash
md2feishu publish-new ./doc.md --title "Doc Title"
md2feishu push ./doc.md '<new-feishu-url>'
```

`publish-new` owns first publication and receipt creation. `push` owns subsequent updates to that known target. If a user asks to push local Markdown without a Feishu URL, the agent should route to `feishu-publish-new`, not `feishu-push`.

## Alternatives Considered

### Option A: Native Drive Import Flow

Upload the Markdown file as an import source, create a Drive import task targeting docx, poll for the resulting docx, optionally move it to wiki, then pull readback and write the receipt.

Pros:

- Most native interpretation of "import this Markdown file into Feishu".
- Lets Feishu own initial Markdown rendering.
- Avoids block-by-block assembly during the first publish.

Cons:

- Requires new upload, import-task, and task-polling API surfaces.
- Adds more permissions before the first version of the workflow is proven.
- Import rendering still needs live validation against the docs team's Markdown patterns.

Decision: defer. Keep this as a future `--creation-strategy import-task` once live testing proves import quality and permissions.

### Option B: Existing Block Pipeline Flow

Create an empty docx in a configured staging folder, convert Markdown to docx blocks with the existing Markdown engine, insert the blocks, optionally move the document into wiki, pull readback, and write the receipt.

Pros:

- Reuses the current docx client, block convert client, Markdown engine, pull/readback path, and receipt model.
- Smaller implementation with lower new API risk.
- Produces behavior closer to later `feishu-push` writes.
- Easier to fake-test because the current clients already model docx creation, block insertion, folder listing, and readback.

Cons:

- Initial rendering depends on the same block conversion safeguards as push.
- Publishing to wiki still needs a staging Drive folder before moving the docx.

Decision: choose this for V1.

### Option C: Fold First Publish Into `push`

Make `md2feishu push ./doc.md` create a new document when no Feishu target is passed.

Pros:

- Fewer commands.
- Matches a loose meaning of "push this somewhere".

Cons:

- Hides destination and creation semantics inside a command designed for existing targets.
- Makes accidental creation more likely when a user simply forgot the remote URL.
- Weakens the clean split between first publication and iterative patching.

Decision: reject.

## V1 User Experience

Primary command:

```bash
md2feishu publish-new <markdown-file>
```

Useful options:

```bash
--title <title>                         # explicit Feishu title
--wiki-parent <wiki-url-or-node-token>  # destination wiki parent override
--wiki-space-id <space-id>              # required when --wiki-parent is used without configured wiki space id
--folder-token <folder-token>           # Drive/staging folder override
--write                                 # perform the publication; omitted means dry-run
-y, --yes                               # skip interactive write confirmation
--allow-duplicate-title                 # create anyway when same-title candidates exist
--publish-profile <profile>             # reuse existing publish transform profiles, such as milvus
--markdown-engine <engine>              # auto | official | local
--format <format>                       # pretty | json
--host <url>
--timeout-ms <number>
```

Title resolution order:

1. `--title`
2. first local H1
3. Markdown file basename without extension

Default mode is dry-run. A dry-run prints:

```text
Intent: publish local Markdown to a new Feishu document
Title: Doc Title
Source: ./doc.md
Destination: wiki parent WikiNode123 in space Spc123
Creation strategy: block-pipeline
Staging folder: Fld456
Final document type: docx in wiki
Wiki move: yes
Duplicate title check: passed
Receipt: .sync/feishu/doc.md.<new-doc-id>.json after write verification

Planned Feishu changes:
- create 1 docx document
- create 42 docx child blocks
- move document to wiki parent WikiNode123
- pull readback for verification

Run with --write to publish.
```

If duplicate candidates exist, dry-run and write mode print candidates and stop:

```text
Duplicate title candidates found in the destination:
- Doc Title: https://...

Write refused by default. Use the existing URL with `md2feishu push`, or re-run publish-new with --allow-duplicate-title if a separate new document is intentional.
```

## Command Guidance And Error UX

The command should guide the user by intent, not by Feishu API mechanics. Every refusal should include:

- what the CLI was trying to do;
- what value was missing or ambiguous;
- the shortest safe command to retry;
- whether any remote object was created.

The top-level help should show the four common usage shapes:

```text
Usage:
  md2feishu publish-new <doc.md>
  md2feishu publish-new <doc.md> --title "Doc Title"
  md2feishu publish-new <doc.md> --title "Doc Title" --wiki-space-id <space-id> --wiki-parent <node-token>
  md2feishu publish-new <doc.md> --title "Doc Title" --folder-token <folder-token>

Default: dry-run. Add --write to create the Feishu document.
```

The command should explain inferred values during dry-run:

```text
Title: API Guide
Title source: first H1
Destination source: FEISHU_PUBLISH_SPACE_ID + FEISHU_PUBLISH_PARENT_NODE_TOKEN
Mode: dry-run, no Feishu document will be created
```

Missing destination:

```text
Cannot publish a new Feishu document because no destination was configured.

Nothing was created.

Choose one:
- publish to the configured team wiki: set FEISHU_PUBLISH_SPACE_ID, FEISHU_PUBLISH_PARENT_NODE_TOKEN, and FEISHU_PUBLISH_FOLDER_TOKEN
- publish to a Drive folder now: md2feishu publish-new ./doc.md --folder-token <folder-token>
- publish to a wiki parent now: md2feishu publish-new ./doc.md --wiki-space-id <space-id> --wiki-parent <node-token> --folder-token <staging-folder-token>
```

Wiki destination without a staging folder:

```text
Cannot publish to wiki yet because V1 needs a staging Drive folder before moving the docx into wiki.

Nothing was created.

Retry with:
md2feishu publish-new ./doc.md --wiki-space-id <space-id> --wiki-parent <node-token> --folder-token <staging-folder-token>
```

Wiki destination missing the space id:

```text
Cannot resolve the wiki destination because --wiki-parent was provided without --wiki-space-id and FEISHU_PUBLISH_SPACE_ID is not set.

Nothing was created.

Retry with:
md2feishu publish-new ./doc.md --wiki-space-id <space-id> --wiki-parent <node-token>
```

Duplicate title:

```text
A document named "Doc Title" already exists in the destination.

Nothing was created.

Candidates:
- Doc Title: https://...

Use the existing document:
md2feishu push ./doc.md 'https://...'

Or intentionally create a separate new document:
md2feishu publish-new ./doc.md --title "Doc Title" --allow-duplicate-title --write
```

Successful write output should end with the next command:

```text
Published: https://...
Receipt: .sync/feishu/doc.md.<doc-id>.json
Verification: passed

Next update command:
md2feishu push ./doc.md 'https://...'
```

If a failure happens after docx creation, the output must be explicit that a remote object exists and receipt was not written:

```text
The docx was created, but publishing did not finish.

Created docx: https://...
Failed step: move to wiki
Receipt: not written

Fix the destination permission or move the document manually before retrying.
```

## Destination Model

The workflow supports two destination shapes.

### Wiki Destination

Configured defaults:

```text
FEISHU_PUBLISH_SPACE_ID
FEISHU_PUBLISH_PARENT_NODE_TOKEN
FEISHU_PUBLISH_FOLDER_TOKEN
```

CLI overrides:

```bash
md2feishu publish-new ./doc.md \
  --title "Doc Title" \
  --wiki-space-id '<space-id>' \
  --wiki-parent '<wiki-url-or-node-token>' \
  --folder-token '<folder-token>'
```

For the block-pipeline V1, `FEISHU_PUBLISH_FOLDER_TOKEN` is required even for wiki publication because the docx is first created in a Drive folder and then moved into wiki. The configured or provided folder must be a location where the app can create docx documents.

The final user-facing URL is the wiki URL when the move succeeds. The Drive doc URL is also returned as diagnostic metadata.

### Drive Folder Destination

Configured default:

```text
FEISHU_PUBLISH_FOLDER_TOKEN
```

CLI override:

```bash
md2feishu publish-new ./doc.md --title "Doc Title" --folder-token '<folder-token>'
```

The final URL is the created docx URL. No wiki move occurs.

### Destination Precedence

1. Explicit CLI destination flags.
2. Environment/config defaults.
3. Refuse with a destination error.

If wiki and folder values are both configured, wiki is the default final destination and the folder is treated as staging. If only a folder token is configured, the final destination is the Drive folder.

## Permission Requirements

V1 block-pipeline permissions:

- create docx documents in the configured staging/final Drive folder;
- convert Markdown content to docx blocks;
- create docx child blocks;
- read docx blocks for verification;
- export/read docx content as Markdown for the receipt snapshot;
- list Drive folder children for same-title checks in folder destinations;
- list wiki child nodes for same-title checks in wiki destinations;
- move cloud docx documents into the configured wiki parent;
- view/edit/manage the configured wiki space or parent node enough for the move endpoint to succeed.

Native import permissions for upload and Drive import tasks are not required in V1 because the import-task strategy is deferred.

## Execution Flow

### Dry-Run Flow

1. Read the local Markdown file.
2. Apply the selected publish transform profile.
3. Resolve the title.
4. Resolve the destination from CLI flags and environment.
5. Validate required destination fields:
   - folder publish requires a folder token;
   - wiki publish requires space id, parent node token, and staging folder token.
6. Convert Markdown to Feishu blocks with the configured Markdown engine.
7. Check same-title candidates in the final destination.
8. Build a `PublishNewPlan` with title, destination, strategy, block count, duplicate candidates, warnings, and approval requirement.
9. Print pretty or JSON output.
10. Do not create any Feishu object.

### Write Flow

1. Build the same plan used by dry-run.
2. If duplicate candidates exist and `--allow-duplicate-title` is absent, refuse before creating anything.
3. Confirm the plan unless `--yes` is present.
4. Create an empty docx in the staging/final folder with the resolved title.
5. Fetch the newly created docx blocks and locate the page/root block with the same helper used by sync.
6. Insert converted blocks under that page/root block.
7. If the final destination is wiki, move the created docx to the configured wiki parent.
8. Pull the final document blocks and compare their comparable child-block hash with the desired block hash.
9. Export the final document through the Markdown readback path for the receipt snapshot.
10. Write a receipt only if verification succeeds.
11. Print docx URL, wiki URL when available, document id, wiki node token when available, receipt path, and verification result.

If wiki move fails after docx creation, the command returns a failure that includes the created Drive doc URL and document id. It does not write a receipt and does not print a wiki URL as successful output.

If readback verification fails, the command returns a failure that includes the created URL and a compact mismatch summary. It does not write a receipt.

## Architecture

Add a focused publish-new layer rather than mixing creation logic into `run-sync`.

### New Core Types

Create `packages/cli/src/sync/publish-new-plan.ts`.

```ts
export type PublishDestination =
  | {
      kind: 'folder';
      folderToken: string;
    }
  | {
      kind: 'wiki';
      spaceId: string;
      parentNodeToken: string;
      stagingFolderToken: string;
    };

export type PublishDuplicateCandidate = {
  title: string;
  url?: string;
  token?: string;
  objType?: string;
};

export type PublishNewPlan = {
  intent: 'publish local Markdown to a new Feishu document';
  sourcePath: string;
  title: string;
  destination: PublishDestination;
  creationStrategy: 'block-pipeline';
  documentType: 'docx';
  blockCount: number;
  wikiMove: boolean;
  duplicateCandidates: PublishDuplicateCandidate[];
  receiptPathPreview: string;
  approvalRequired: 'normal-write' | 'duplicate-title';
  warnings: string[];
};
```

Responsibilities:

- title resolution;
- destination validation;
- same-title candidate modeling;
- dry-run output data.

### New Workflow Runner

Create `packages/cli/src/sync/publish-new.ts`.

Responsibilities:

- read source Markdown;
- apply publish transforms;
- convert Markdown to blocks through `MarkdownEngine`;
- build `PublishNewPlan`;
- execute write mode;
- run readback verification;
- write the publish receipt.

The runner should accept injected dependencies so tests can use fakes:

```ts
export type PublishNewClient = {
  createDocument(title: string, folderToken: string): Promise<FeishuDriveFile>;
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
  createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[], options?: { index?: number }): Promise<FeishuBlock[]>;
  listFolder?(folderToken: string, type?: string): Promise<FeishuDriveFile[]>;
  listWikiChildren?(spaceId: string, parentNodeToken: string): Promise<PublishDuplicateCandidate[]>;
  moveDocxToWiki?(input: {
    spaceId: string;
    parentNodeToken: string;
    documentId: string;
  }): Promise<{ wikiNodeToken?: string; wikiUrl?: string }>;
};
```

The runner should locate the parent block by calling `getDocumentBlocks(documentId)` and reusing the existing `findPageBlock` behavior from `packages/cli/src/sync/block-state.ts`. It should not assume the document id is always the insertable parent block id.

### Feishu API Clients

Extend existing service clients instead of putting API paths in the CLI command.

Modify `packages/cli/src/services/feishu/drive-client.ts` only if needed for richer list metadata.

Create `packages/cli/src/services/feishu/wiki-client.ts` with:

- `listChildren(spaceId, parentNodeToken)` for same-title checks in wiki destinations;
- `moveDocxToWiki(spaceId, parentNodeToken, documentId)` for final placement;
- task polling if the move endpoint returns asynchronous task metadata.

Modify `packages/cli/src/feishu/client.ts` to expose the new wiki methods on `FeishuClient`.

### CLI Command

Modify `packages/cli/src/cli/commands/sync.ts` to register:

```bash
md2feishu publish-new <markdown-file>
```

Keep command normalization near the existing push/pull normalization code. The CLI should not construct API request paths directly; it should create the Feishu client, create the Markdown engine, call the publish runner, and print the result.

### Receipts

Reuse `SyncReceipt` fields so `status`, `push`, and future commands can reason about the publication baseline. Extend the JSON with optional publish metadata:

```ts
export type PublishReceiptMetadata = {
  workflow: 'publish-new';
  title: string;
  documentUrl?: string;
  wikiUrl?: string;
  wikiNodeToken?: string;
  destination: PublishDestination;
  creationStrategy: 'block-pipeline';
};
```

The receipt should be written at the existing path shape:

```text
.sync/feishu/<basename>.<doc-id>.json
```

Receipt write rules:

- Dry-run never writes a receipt.
- Write mode writes a receipt only after readback verification passes.
- Wiki move failure writes no receipt.
- Verification failure writes no receipt.

## Safety Gates

- Missing destination is a hard error before block conversion or writes.
- Dry-run is the default.
- Write mode requires `--write`.
- Interactive confirmation is required unless `--yes` is present.
- Duplicate titles are a hard error unless `--allow-duplicate-title` is present.
- The command never auto-pushes to an existing same-title document. It instructs the user to run `md2feishu push ./doc.md '<candidate-url>'`.
- Wiki move is part of successful publication. A failed move reports the created Drive doc, but the command exits as failed.
- Receipt creation is gated by readback verification.
- Pretty output must not print credentials, app secrets, or raw tenant tokens.

## Workflow Registry And Skill UX

Add workflow id `publish-new` to `packages/cli/src/workflows/registry.ts`.

Recipe:

1. `md2feishu doctor auth`
2. `md2feishu publish-new <doc.md>` for dry-run
3. review title, destination, duplicate candidates, and planned writes
4. `md2feishu publish-new <doc.md> --write -y`
5. inspect the returned Feishu URL
6. use `md2feishu push <doc.md> '<new-feishu-url>'` for later changes

Add `skills/feishu-publish-new/SKILL.md`.

Skill routing:

- Use `feishu-publish-new` when local Markdown has no existing Feishu target.
- Use `feishu-push` when a remote Feishu docx/wiki URL already exists.
- If same-title candidates are reported, stop and ask whether the user wants a separate new document or wants to push to one of the candidates.

## Documentation Updates

Update:

- `README.md`
- `packages/cli/README.md`
- `apps/docs/guide/workflows.md`
- `apps/docs/guide/configuration.md`
- `apps/docs/reference/commands.md`
- `apps/docs/reference/safety-gates.md`
- `apps/docs/internals/feishu-api-notes.md`
- `apps/docs/agent/skill-roadmap.md`

The docs should make the three-document lifecycle explicit:

| Situation | Command |
| --- | --- |
| No Feishu document exists yet | `md2feishu publish-new <doc.md>` |
| A Feishu document exists and local edits should be applied | `md2feishu push <doc.md> '<feishu-doc>'` |
| Feishu is source of truth and local Markdown needs a baseline | `md2feishu pull '<feishu-doc>' --output <doc.md> --write-receipt` |

## Testing Strategy

Add fake-client unit tests before implementation.

Primary tests:

- dry-run with configured folder destination creates no remote document and prints the resolved title/destination;
- dry-run with configured wiki destination requires space id, parent node token, and staging folder token;
- missing destination fails before remote writes;
- title resolution uses `--title`, first H1, then basename;
- duplicate title candidates in folder destination refuse write by default;
- duplicate title candidates in wiki destination refuse write by default;
- `--allow-duplicate-title` allows creation after duplicate reporting;
- write mode creates docx, inserts blocks, pulls readback, and writes receipt when verification passes;
- wiki write mode creates docx, inserts blocks, moves to wiki, pulls final document, and writes receipt with wiki metadata;
- wiki move failure reports created Drive doc URL and writes no receipt;
- readback verification failure writes no receipt;
- JSON output includes stable fields for automation;
- missing destination, missing wiki staging folder, missing wiki space id, duplicate title, successful write, and partial failure outputs include the guidance text described in "Command Guidance And Error UX";
- workflow registry exposes `publish-new`;
- CLI help exposes `publish-new` and does not imply `push` can create a new remote document.

Verification commands:

```bash
npm test -- publish-new
npm test -- workflow-registry cli-help-surface
npm test
npm run typecheck
npm run docs:build
```

Live smoke test:

1. Use a disposable Markdown file with heading, paragraph, list, table, and fenced code block.
2. Publish into a disposable folder destination.
3. Publish into a disposable wiki destination.
4. Confirm returned URLs open to the expected documents.
5. Confirm receipts are written only for verified writes.
6. Run `md2feishu push` against the returned URL with a one-line local edit and verify the normal push path works.

## Deferred Work

- Native Drive import strategy behind `--creation-strategy import-task`.
- Frontmatter mutation that writes the created Feishu URL back into the Markdown file.
- Automatic "push existing candidate" mode from inside `publish-new`.
- Destination config files beyond environment variables.
- Rich duplicate resolution UI beyond candidate reporting plus `--allow-duplicate-title`.

These are intentionally deferred because V1 should prove the first-publication lifecycle with the smallest API expansion that still satisfies safety and governance requirements.
