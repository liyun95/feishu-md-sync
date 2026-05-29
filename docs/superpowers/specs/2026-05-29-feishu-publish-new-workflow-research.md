# Feishu Publish-New Workflow Research

## Question

When there is no existing remote Feishu document, how should the CLI publish a local Markdown file to Feishu?

## Recommendation

Do not fold this into `feishu-push`.

`feishu-push` should keep requiring an existing Feishu document because its job is to compare local Markdown with a known remote target, choose a patch strategy, and protect existing content.

Add a separate workflow, tentatively named `feishu-publish-new`, for the first publication of a local Markdown file. This workflow creates a new Feishu docx, places it under a configured Feishu destination, writes a local receipt, and returns the new Feishu URL. After that, normal edits use `feishu-push`.

## Destination Model

The CLI needs a stable destination. Otherwise newly created documents become hard to find and hard to govern.

Recommended default:

- Configure one team-owned wiki root, for example `CLI Drafts` or `Agent Drafts`.
- Add the Feishu app or bot as a member/admin with edit permission to that wiki space or parent node.
- Store the destination in environment/config:
  - `FEISHU_PUBLISH_SPACE_ID`
  - `FEISHU_PUBLISH_PARENT_NODE_TOKEN`
  - optional staging folder: `FEISHU_PUBLISH_FOLDER_TOKEN`

This is operationally close to "the app's own wiki", but more accurate: the app does not naturally own a personal wiki. The team creates or selects a wiki location and grants the app access.

## Official API Findings

Relevant official capabilities:

- Create docx document: `POST /open-apis/docx/v1/documents`
  - Creates an empty docx.
  - Does not support creating a document with content in the same call.
  - With `tenant_access_token`, `folder_token` can only target folders created by the app.
- Create wiki node: `POST /open-apis/wiki/v2/spaces/:space_id/nodes`
  - Creates a node at a wiki location.
  - Requires parent node container edit permission.
  - The documented create-node body is oriented around `doc` entity nodes.
- Move cloud document to wiki: `POST /open-apis/wiki/v2/spaces/:space_id/nodes/move_docs_to_wiki`
  - Supports `obj_type: "docx"`.
  - Requires document manage permission, original folder edit permission, and destination parent node edit permission.
  - May be asynchronous; callers may need to poll the wiki task result.
- Drive import task: `POST /open-apis/drive/v1/import_tasks`
  - Can import local files such as Markdown into online Feishu documents.
  - Supports target type `docx`.
  - Requires first uploading the source local file to get a `file_token`.

## Implementation Options

### Option A: Native Import Flow

Use Feishu Drive import tasks:

1. Upload local Markdown as a Drive import source file.
2. Create a Drive import task with `file_extension: "md"` and `type: "docx"`.
3. Poll import task result until a docx token and URL are available.
4. If the final destination is a wiki, move the docx to the configured wiki parent with `move_docs_to_wiki`.
5. Pull the newly created document back through the official Markdown export path.
6. Write a local receipt binding the source Markdown path to the new Feishu document.

Pros:

- Most native for "local file to new Feishu document".
- Lets Feishu own the initial Markdown import behavior.
- Avoids first-publication block granularity issues.

Cons:

- Requires adding Drive upload, import-task create, import-task polling, and possibly wiki move polling.
- Needs more permissions than the existing push path.
- Import behavior still needs live smoke testing for docs-team Markdown features.

### Option B: Existing Block Pipeline Flow

Use the existing docx and block APIs:

1. Create an empty docx in a configured app-created folder.
2. Convert Markdown to Feishu blocks using the official block convert API when available.
3. Insert the blocks into the empty document.
4. Move the docx to the configured wiki parent if needed.
5. Pull readback and write a local receipt.

Pros:

- Reuses the current Markdown engine, block insertion, readback, and receipt code.
- Smaller implementation.
- Easier to make behavior consistent with `feishu-push`.

Cons:

- Less native than Drive import for first publication.
- The initial content is still assembled block-by-block, so complex Markdown structures need the same rendering safeguards as push.

## UX Shape

Suggested command:

```bash
md2feishu publish-new ./doc.md --title "Doc Title"
md2feishu publish-new ./doc.md --title "Doc Title" --wiki-parent '<wiki-url-or-node-token>'
md2feishu publish-new ./doc.md --title "Doc Title" --folder-token '<folder-token>'
```

Default behavior:

- Dry-run first.
- Resolve title from explicit `--title`, then first H1, then file name.
- Show destination, import/create strategy, expected document type, and whether a wiki move will happen.
- Refuse write if no destination is configured.
- On write, output the final docx URL, wiki URL when available, document ID, wiki node token when available, and receipt path.

Subsequent workflow:

```bash
md2feishu push ./doc.md '<new-feishu-url>'
```

Skill UX:

- New skill: `feishu-publish-new`.
- Existing `feishu-push` skill should explicitly say it is for existing remote documents only.
- If the user asks to push local Markdown without a remote URL, the agent should choose `feishu-publish-new`, not `feishu-push`.

## Safety Gates

- Require a configured destination unless `--folder-token` or `--wiki-parent` is provided explicitly.
- Dry-run prints the destination and asks for approval before creating anything.
- Refuse overwriting or deduping by title automatically. If a same-title document exists, report candidates and ask the user to choose create-new vs push-existing.
- Write a receipt only after readback verification succeeds.
- Treat wiki move as part of the write: if move fails, report the Drive doc URL and do not pretend publication to wiki succeeded.

## Permission Additions

For the smaller block-pipeline implementation:

- Create and edit docx documents.
- Convert text/Markdown content to docx blocks.
- Create docx child blocks.
- Read docx content for readback.
- Create/list folders if the workflow manages an app-owned staging folder.
- Move cloud document to wiki and view/edit/manage wiki if publishing into a wiki.

For the native import implementation, add:

- Upload files or media for import source.
- Create Drive import tasks.
- Query Drive import task result.

## Open Decisions

1. Whether V1 should use native Drive import or the existing block pipeline.
2. Whether to require `FEISHU_PUBLISH_SPACE_ID` + `FEISHU_PUBLISH_PARENT_NODE_TOKEN` for the team default.
3. Whether to write the created Feishu URL into Markdown frontmatter or keep all binding state in `.sync/feishu` receipts only.
4. How to handle same-title documents in the target wiki or folder.
