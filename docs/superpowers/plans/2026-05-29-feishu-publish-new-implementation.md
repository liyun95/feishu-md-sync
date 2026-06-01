# Feishu Publish-New Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-publication workflow that publishes a local Markdown file to a new Feishu docx when no remote Feishu document exists yet.

**Architecture:** Keep `feishu-push` scoped to existing remote documents. Add `publish-new` as a separate dry-run-first workflow that resolves a title and destination, creates an empty docx, converts Markdown to Feishu blocks, writes the initial blocks, optionally moves the docx into a configured wiki parent, verifies readback, writes a local receipt, and returns the new URL for future `feishu-push` runs. V1 uses the existing block pipeline instead of Drive import tasks because it reuses current Markdown engine, block insertion, readback, and receipt behavior.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, VitePress docs, Codex skills, Feishu docx/wiki/Drive APIs.

---

## V1 Decisions

- Add a new workflow id: `publish-new`.
- Add a new CLI command: `md2feishu publish-new <doc.md>`.
- Add a new skill: `feishu-publish-new`.
- Use the existing block pipeline for V1:
  1. Read local Markdown.
  2. Apply optional publish transform.
  3. Convert Markdown to Feishu blocks through the selected `MarkdownEngine`.
  4. Create an empty docx in a configured staging folder.
  5. Insert blocks into the new docx.
  6. If wiki destination is configured, move the docx into the configured wiki parent.
  7. Read back the docx, verify hash, pull Markdown snapshot, and write receipt.
- Require a destination before write:
  - folder-only destination: `--folder-token` or `FEISHU_PUBLISH_FOLDER_TOKEN`
  - wiki destination: `--wiki-space-id`/`FEISHU_PUBLISH_SPACE_ID` plus `--wiki-parent`/`FEISHU_PUBLISH_PARENT_NODE_TOKEN`; still requires a staging folder token for docx creation.
- Do not try to dedupe by title automatically. If same-title detection is added, it reports candidates and refuses by default.
- Keep Drive import task as a later implementation option after V1 has a live smoke test.

## User UX

Dry-run:

```bash
md2feishu publish-new ./doc.md
md2feishu publish-new ./doc.md --title "Doc Title"
md2feishu publish-new ./doc.md --title "Doc Title" --wiki-space-id <space-id> --wiki-parent <node-token>
md2feishu publish-new ./doc.md --title "Doc Title" --folder-token <folder-token>
```

Write:

```bash
md2feishu publish-new ./doc.md --write -y
```

Expected pretty output:

```text
Intent: publish new Feishu document from local Markdown
Title: Doc Title
Destination: wiki parent <node-token> in space <space-id>
Strategy: create-docx-blocks

Planned Feishu changes:
- create 1 docx document
- create 42 blocks
- move to wiki: yes

Run with --write to create the document.
```

Expected write output:

```text
Intent: publish new Feishu document from local Markdown
Title: Doc Title
Destination: wiki parent <node-token> in space <space-id>
Strategy: create-docx-blocks

Created Feishu document:
- document id: <docx-token>
- docx url: <url>
- wiki url: <url>
- receipt: .sync/feishu/doc.md.<docx-token>.json
Readback verification: passed
Next: md2feishu push ./doc.md '<new-feishu-url>'
```

## File Map

- Create `packages/cli/src/publish-new/plan.ts`
  - Resolve title, destination, mode, strategy, and operation counts.
- Create `packages/cli/src/publish-new/run-publish-new.ts`
  - Orchestrate dry-run/write, Feishu creation, block insertion, wiki move, readback, receipt writing.
- Create `packages/cli/src/publish-new/output.ts`
  - Pretty and JSON output helpers for CLI and tests.
- Create `packages/cli/src/services/feishu/wiki-client.ts`
  - Wiki move wrapper for `move_docs_to_wiki`.
- Modify `packages/cli/src/feishu/types.ts`
  - Add publish-new client/result types.
- Modify `packages/cli/src/feishu/client.ts`
  - Expose `moveDocxToWiki`.
- Modify `packages/cli/src/cli/commands/sync.ts`
  - Register `publish-new`.
- Modify `packages/cli/src/workflows/registry.ts`
  - Add `publish-new` workflow recipe.
- Modify harness files:
  - `packages/cli/src/harness/task.ts`
  - `packages/cli/src/harness/tools.ts`
  - `packages/cli/src/harness/grade.ts`
- Create tests:
  - `packages/cli/test/publish-new-plan.test.ts`
  - `packages/cli/test/publish-new.test.ts`
  - `packages/cli/test/publish-new-cli-output.test.ts`
- Modify tests:
  - `packages/cli/test/feishu-client.test.ts`
  - `packages/cli/test/cli-help-surface.test.ts`
  - `packages/cli/test/workflow-registry.test.ts`
  - `packages/cli/test/harness-tools.test.ts`
- Create skill:
  - `skills/feishu-publish-new/SKILL.md`
  - `apps/docs/agent/skills/feishu-publish-new.md`
- Modify docs:
  - `README.md`
  - `packages/cli/README.md`
  - `apps/docs/guide/quickstart.md`
  - `apps/docs/guide/workflows.md`
  - `apps/docs/guide/configuration.md`
  - `apps/docs/reference/commands.md`
  - `apps/docs/reference/safety-gates.md`
  - `apps/docs/internals/capability-inventory.md`
  - `scripts/install-codex-skills.sh`

---

### Task 1: Publish-New Plan Model

**Files:**
- Create: `packages/cli/src/publish-new/plan.ts`
- Test: `packages/cli/test/publish-new-plan.test.ts`

- [ ] **Step 1: Write failing title and destination tests**

Create `packages/cli/test/publish-new-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPublishNewPlan, resolvePublishTitle } from '../src/publish-new/plan.js';

describe('publish-new plan', () => {
  it('resolves title from explicit title, first H1, then filename', () => {
    expect(resolvePublishTitle({
      sourcePath: '/tmp/local.md',
      markdown: '# Remote Title\n\nBody',
      title: 'Explicit Title'
    })).toBe('Explicit Title');

    expect(resolvePublishTitle({
      sourcePath: '/tmp/local.md',
      markdown: '# Remote Title\n\nBody'
    })).toBe('Remote Title');

    expect(resolvePublishTitle({
      sourcePath: '/tmp/my-doc.md',
      markdown: 'Body only'
    })).toBe('my-doc');
  });

  it('builds a wiki destination plan from explicit options', () => {
    const plan = buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {
        title: 'Doc',
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParentNodeToken: 'parent-node'
      },
      env: {}
    });

    expect(plan).toMatchObject({
      title: 'Doc',
      strategy: 'create-docx-blocks',
      destination: {
        kind: 'wiki',
        folderToken: 'folder-token',
        spaceId: 'space-id',
        parentNodeToken: 'parent-node'
      },
      creates: {
        documents: 1,
        blocks: 2,
        wikiMove: true
      }
    });
  });

  it('builds a folder destination plan from env fallback', () => {
    const plan = buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {},
      env: {
        FEISHU_PUBLISH_FOLDER_TOKEN: 'folder-token'
      }
    });

    expect(plan.destination).toEqual({
      kind: 'folder',
      folderToken: 'folder-token'
    });
  });

  it('fails when write would have no destination', () => {
    expect(() => buildPublishNewPlan({
      sourcePath: '/tmp/doc.md',
      markdown: '# Doc\n\nBody',
      blockCount: 2,
      options: {},
      env: {}
    })).toThrow(/No publish-new destination configured/);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- publish-new-plan
```

Expected: fail because `../src/publish-new/plan.js` does not exist.

- [ ] **Step 3: Implement the plan model**

Create `packages/cli/src/publish-new/plan.ts`:

```ts
import path from 'node:path';

export type PublishNewDestination =
  | {
      kind: 'folder';
      folderToken: string;
    }
  | {
      kind: 'wiki';
      folderToken: string;
      spaceId: string;
      parentNodeToken: string;
    };

export type PublishNewPlan = {
  intent: 'publish new Feishu document from local Markdown';
  title: string;
  strategy: 'create-docx-blocks';
  destination: PublishNewDestination;
  creates: {
    documents: 1;
    blocks: number;
    wikiMove: boolean;
  };
  approvalMessage: string;
};

export type PublishNewOptions = {
  title?: string;
  folderToken?: string;
  wikiSpaceId?: string;
  wikiParentNodeToken?: string;
};

export function resolvePublishTitle(input: {
  sourcePath: string;
  markdown: string;
  title?: string;
}): string {
  const explicit = input.title?.trim();
  if (explicit) return explicit;

  const firstH1 = input.markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (firstH1) return firstH1;

  const parsed = path.parse(input.sourcePath);
  return parsed.name || 'Untitled';
}

export function buildPublishNewPlan(input: {
  sourcePath: string;
  markdown: string;
  blockCount: number;
  options: PublishNewOptions;
  env: NodeJS.ProcessEnv;
}): PublishNewPlan {
  const title = resolvePublishTitle({
    sourcePath: input.sourcePath,
    markdown: input.markdown,
    title: input.options.title
  });
  const folderToken = value(input.options.folderToken, input.env.FEISHU_PUBLISH_FOLDER_TOKEN);
  const spaceId = value(input.options.wikiSpaceId, input.env.FEISHU_PUBLISH_SPACE_ID);
  const parentNodeToken = value(input.options.wikiParentNodeToken, input.env.FEISHU_PUBLISH_PARENT_NODE_TOKEN);

  if (!folderToken) {
    throw new Error(
      'No publish-new destination configured. Set FEISHU_PUBLISH_FOLDER_TOKEN or pass --folder-token.'
    );
  }

  const destination: PublishNewDestination = spaceId && parentNodeToken
    ? { kind: 'wiki', folderToken, spaceId, parentNodeToken }
    : { kind: 'folder', folderToken };

  return {
    intent: 'publish new Feishu document from local Markdown',
    title,
    strategy: 'create-docx-blocks',
    destination,
    creates: {
      documents: 1,
      blocks: input.blockCount,
      wikiMove: destination.kind === 'wiki'
    },
    approvalMessage: 'Run with --write to create the document.'
  };
}

function value(primary: string | undefined, fallback: string | undefined): string | undefined {
  const resolved = primary?.trim() || fallback?.trim();
  return resolved || undefined;
}
```

- [ ] **Step 4: Verify the plan tests pass**

Run:

```bash
npm test -- publish-new-plan
```

Expected: pass.

### Task 2: Feishu Wiki Move Client

**Files:**
- Create: `packages/cli/src/services/feishu/wiki-client.ts`
- Modify: `packages/cli/src/feishu/types.ts`
- Modify: `packages/cli/src/feishu/client.ts`
- Test: `packages/cli/test/feishu-client.test.ts`

- [ ] **Step 1: Add failing client tests**

Append to `packages/cli/test/feishu-client.test.ts`:

```ts
  it('moves a docx document to a wiki parent', async () => {
    const tokenProvider = { token: vi.fn().mockResolvedValue('token') } as unknown as FeishuTokenProvider;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      code: 0,
      data: {
        node: {
          token: 'wiki-node-token',
          obj_token: 'DocxObjToken123',
          obj_type: 'docx',
          url: 'https://example.feishu.cn/wiki/wiki-node-token'
        }
      }
    }));
    const client = new FeishuClient({ tokenProvider, fetchImpl });

    await expect(client.moveDocxToWiki({
      spaceId: 'space-id',
      parentNodeToken: 'parent-node-token',
      documentId: 'DocxObjToken123',
      title: 'Doc Title'
    })).resolves.toEqual({
      nodeToken: 'wiki-node-token',
      documentId: 'DocxObjToken123',
      url: 'https://example.feishu.cn/wiki/wiki-node-token'
    });

    expect(fetchImpl.mock.calls[0][0]).toContain('/open-apis/wiki/v2/spaces/space-id/nodes/move_docs_to_wiki');
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      parent_node_token: 'parent-node-token',
      obj_type: 'docx',
      obj_token: 'DocxObjToken123',
      title: 'Doc Title'
    });
  });
```

- [ ] **Step 2: Run the failing client test**

Run:

```bash
npm test -- feishu-client
```

Expected: fail because `moveDocxToWiki` does not exist.

- [ ] **Step 3: Add wiki client types**

Modify `packages/cli/src/feishu/types.ts`:

```ts
export type FeishuWikiMoveInput = {
  spaceId: string;
  parentNodeToken: string;
  documentId: string;
  title?: string;
};

export type FeishuWikiMoveResult = {
  nodeToken?: string;
  documentId?: string;
  url?: string;
  taskId?: string;
};
```

- [ ] **Step 4: Implement the wiki client wrapper**

Create `packages/cli/src/services/feishu/wiki-client.ts`:

```ts
import type { FeishuWikiMoveInput, FeishuWikiMoveResult } from '../../feishu/types.js';

type WikiMoveResponse = {
  node?: {
    token?: string;
    node_token?: string;
    obj_token?: string;
    obj_type?: string;
    url?: string;
  };
  task?: {
    task_id?: string;
  };
  task_id?: string;
};

export class FeishuWikiClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async moveDocxToWiki(input: FeishuWikiMoveInput): Promise<FeishuWikiMoveResult> {
    const data = await this.request<WikiMoveResponse>(
      'POST',
      `/open-apis/wiki/v2/spaces/${input.spaceId}/nodes/move_docs_to_wiki`,
      {
        parent_node_token: input.parentNodeToken,
        obj_type: 'docx',
        obj_token: input.documentId,
        ...(input.title ? { title: input.title } : {})
      }
    );
    return {
      nodeToken: data.node?.token ?? data.node?.node_token,
      documentId: data.node?.obj_token ?? input.documentId,
      url: data.node?.url,
      taskId: data.task?.task_id ?? data.task_id
    };
  }
}
```

- [ ] **Step 5: Wire the wiki client into `FeishuClient`**

Modify `packages/cli/src/feishu/client.ts`:

```ts
import { FeishuWikiClient } from '../services/feishu/wiki-client.js';
import type { FeishuWikiMoveInput, FeishuWikiMoveResult } from './types.js';
```

Add a private field:

```ts
  private readonly wiki: FeishuWikiClient;
```

Initialize it in the constructor:

```ts
    this.wiki = new FeishuWikiClient(request);
```

Add the public method:

```ts
  async moveDocxToWiki(input: FeishuWikiMoveInput): Promise<FeishuWikiMoveResult> {
    return this.wiki.moveDocxToWiki(input);
  }
```

- [ ] **Step 6: Verify client tests**

Run:

```bash
npm test -- feishu-client
```

Expected: pass.

### Task 3: Publish-New Runner

**Files:**
- Create: `packages/cli/src/publish-new/run-publish-new.ts`
- Test: `packages/cli/test/publish-new.test.ts`

- [ ] **Step 1: Write failing dry-run and write tests**

Create `packages/cli/test/publish-new.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeishuBlock, FeishuDriveFile, FeishuWikiMoveInput, FeishuWikiMoveResult } from '../src/feishu/types.js';
import { createMarkdownEngine } from '../src/markdown/engine.js';
import { runPublishNew } from '../src/publish-new/run-publish-new.js';

describe('publish-new runner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'publish-new-'));
  });

  it('dry-runs a new document publication without Feishu writes', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const client = fakePublishClient();

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      write: false,
      options: { folderToken: 'folder-token' },
      env: {},
      markdownEngine: createMarkdownEngine({ mode: 'local' })
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.creates).toMatchObject({ documents: 1, blocks: 2, wikiMove: false });
    expect(client.createDocxDocument).not.toHaveBeenCalled();
    expect(result.receiptWritten).toBe(false);
  });

  it('creates a docx, writes blocks, verifies readback, and writes a receipt', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const client = fakePublishClient({
      createdDocument: {
        document_id: 'doc1234567890123',
        url: 'https://example.feishu.cn/docx/doc1234567890123'
      },
      readbackBlocks: [
        { block_id: 'doc1234567890123', block_type: 1, children: ['h1', 'p1'] },
        { block_id: 'h1', block_type: 3, heading1: { elements: [{ text_run: { content: 'Doc', text_element_style: {} } }], style: {} } },
        { block_id: 'p1', block_type: 2, text: { elements: [{ text_run: { content: 'Body', text_element_style: {} } }], style: {} } }
      ]
    });

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      write: true,
      yes: true,
      options: { folderToken: 'folder-token' },
      env: {},
      markdownEngine: createMarkdownEngine({ mode: 'local' })
    });

    expect(client.createDocxDocument).toHaveBeenCalledWith('Doc', 'folder-token');
    expect(client.createChildren).toHaveBeenCalledWith('doc1234567890123', 'doc1234567890123', expect.any(Array));
    expect(result.readbackVerification.ok).toBe(true);
    expect(result.receiptWritten).toBe(true);
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    expect(receipt.feishuDocId).toBe('doc1234567890123');
    expect(receipt.writeResult).toMatchObject({ mode: 'write', created: 2 });
  });

  it('moves the created docx to wiki when a wiki destination is configured', async () => {
    const sourcePath = path.join(dir, 'doc.md');
    await writeFile(sourcePath, '# Doc\n\nBody\n');
    const client = fakePublishClient({
      createdDocument: {
        document_id: 'doc1234567890123',
        url: 'https://example.feishu.cn/docx/doc1234567890123'
      },
      wikiMove: {
        nodeToken: 'wiki-node',
        documentId: 'doc1234567890123',
        url: 'https://example.feishu.cn/wiki/wiki-node'
      },
      readbackBlocks: [
        { block_id: 'doc1234567890123', block_type: 1, children: ['h1', 'p1'] },
        { block_id: 'h1', block_type: 3, heading1: { elements: [{ text_run: { content: 'Doc', text_element_style: {} } }], style: {} } },
        { block_id: 'p1', block_type: 2, text: { elements: [{ text_run: { content: 'Body', text_element_style: {} } }], style: {} } }
      ]
    });

    const result = await runPublishNew(client, {
      sourcePath,
      rootDir: dir,
      write: true,
      yes: true,
      options: {
        folderToken: 'folder-token',
        wikiSpaceId: 'space-id',
        wikiParentNodeToken: 'parent-node'
      },
      env: {},
      markdownEngine: createMarkdownEngine({ mode: 'local' })
    });

    expect(client.moveDocxToWiki).toHaveBeenCalledWith({
      spaceId: 'space-id',
      parentNodeToken: 'parent-node',
      documentId: 'doc1234567890123',
      title: 'Doc'
    });
    expect(result.created.wikiUrl).toBe('https://example.feishu.cn/wiki/wiki-node');
  });
});

function fakePublishClient(input: {
  createdDocument?: FeishuDriveFile;
  readbackBlocks?: FeishuBlock[];
  wikiMove?: FeishuWikiMoveResult;
} = {}) {
  return {
    createDocxDocument: vi.fn(async () => input.createdDocument ?? {
      document_id: 'doc1234567890123',
      url: 'https://example.feishu.cn/docx/doc1234567890123'
    }),
    createChildren: vi.fn(async (_documentId: string, _parentBlockId: string, blocks: FeishuBlock[]) => blocks),
    getDocumentBlocks: vi.fn(async () => input.readbackBlocks ?? [
      { block_id: 'doc1234567890123', block_type: 1, children: [] }
    ]),
    moveDocxToWiki: vi.fn(async (_move: FeishuWikiMoveInput) => input.wikiMove ?? {})
  };
}
```

- [ ] **Step 2: Run the failing runner tests**

Run:

```bash
npm test -- publish-new
```

Expected: fail because `run-publish-new.ts` does not exist.

- [ ] **Step 3: Implement the runner types and orchestration**

Create `packages/cli/src/publish-new/run-publish-new.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashBlocks, hashSource } from '../core/hash.js';
import type {
  FeishuBlock,
  FeishuDriveFile,
  FeishuWikiMoveInput,
  FeishuWikiMoveResult
} from '../feishu/types.js';
import type { MarkdownEngine } from '../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions } from '../markdown/publish-transform.js';
import { receiptPath, writeReceipt, type SyncReceipt } from '../receipts/receipt.js';
import { comparableDirectChildBlocks, findPageBlock } from '../sync/block-state.js';
import { buildPublishNewPlan, type PublishNewOptions, type PublishNewPlan } from './plan.js';

export type PublishNewClient = {
  createDocxDocument(title: string, folderToken: string): Promise<FeishuDriveFile>;
  createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[]): Promise<FeishuBlock[]>;
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
  moveDocxToWiki?(input: FeishuWikiMoveInput): Promise<FeishuWikiMoveResult>;
};

export type PublishNewRunResult = {
  mode: 'dry-run' | 'write';
  sourcePath: string;
  plan: PublishNewPlan;
  receiptPath: string;
  receiptWritten: boolean;
  created: {
    documentId?: string;
    docxUrl?: string;
    wikiUrl?: string;
    wikiNodeToken?: string;
  };
  readbackVerification: {
    ok: boolean;
    expectedHash: string;
    actualHash: string;
  };
  warnings: string[];
};

export async function runPublishNew(
  client: PublishNewClient,
  options: {
    sourcePath: string;
    rootDir?: string;
    write?: boolean;
    yes?: boolean;
    options: PublishNewOptions;
    env?: NodeJS.ProcessEnv;
    markdownEngine: MarkdownEngine;
    publishTransform?: PublishTransformOptions;
  }
): Promise<PublishNewRunResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const sourcePath = resolve(options.sourcePath);
  const rawMarkdown = await readFile(sourcePath, 'utf8');
  const effectiveMarkdown = applyPublishTransform(rawMarkdown, options.publishTransform);
  const imported = await options.markdownEngine.importMarkdown({ markdown: effectiveMarkdown });
  const desiredBlocks = imported.blocks;
  const plan = buildPublishNewPlan({
    sourcePath,
    markdown: effectiveMarkdown,
    blockCount: desiredBlocks.length,
    options: options.options,
    env: options.env ?? process.env
  });
  const statePath = receiptPath(rootDir, sourcePath, 'new');

  if (!options.write) {
    return {
      mode: 'dry-run',
      sourcePath,
      plan,
      receiptPath: statePath,
      receiptWritten: false,
      created: {},
      readbackVerification: {
        ok: true,
        expectedHash: hashBlocks(desiredBlocks),
        actualHash: hashBlocks(desiredBlocks)
      },
      warnings: imported.warnings
    };
  }

  if (!options.yes) {
    throw new Error('Publish-new write requires --yes in non-interactive mode.');
  }

  const created = await client.createDocxDocument(plan.title, plan.destination.folderToken);
  const documentId = docToken(created);
  if (!documentId) {
    throw new Error('Feishu create document response did not include a document token.');
  }

  const createdBlocks = desiredBlocks.length > 0
    ? await client.createChildren(documentId, documentId, desiredBlocks)
    : [];

  let wikiMove: FeishuWikiMoveResult = {};
  if (plan.destination.kind === 'wiki') {
    if (!client.moveDocxToWiki) {
      throw new Error('Feishu client does not support moving docx documents to wiki.');
    }
    wikiMove = await client.moveDocxToWiki({
      spaceId: plan.destination.spaceId,
      parentNodeToken: plan.destination.parentNodeToken,
      documentId,
      title: plan.title
    });
  }

  const readbackBlocks = await client.getDocumentBlocks(documentId);
  const page = findPageBlock(readbackBlocks, documentId);
  const readbackChildren = comparableDirectChildBlocks(readbackBlocks, page);
  const expectedHash = hashBlocks(desiredBlocks);
  const actualHash = hashBlocks(readbackChildren);
  if (expectedHash !== actualHash) {
    throw new Error(`Verification mismatch after publish-new. Expected ${expectedHash}, got ${actualHash}.`);
  }

  const finalReceiptPath = receiptPath(rootDir, sourcePath, documentId);
  const receipt: SyncReceipt = {
    sourcePath,
    sourceHash: hashSource(effectiveMarkdown),
    sourceSnapshot: effectiveMarkdown,
    feishuDocId: documentId,
    feishuStateHash: actualHash,
    feishuMarkdownSnapshot: (await options.markdownEngine.exportMarkdown({
      documentId,
      fallbackBlocks: readbackChildren
    })).markdown,
    timestamp: new Date().toISOString(),
    blockCounts: {
      source: desiredBlocks.length,
      feishuBefore: 0,
      feishuAfter: readbackChildren.length
    },
    warnings: imported.warnings,
    writeResult: {
      mode: 'write',
      deleted: 0,
      created: createdBlocks.length,
      skipped: false
    },
    verificationResult: {
      ok: true,
      expectedHash,
      actualHash
    }
  };
  await writeReceipt(finalReceiptPath, receipt);

  return {
    mode: 'write',
    sourcePath,
    plan,
    receiptPath: finalReceiptPath,
    receiptWritten: true,
    created: {
      documentId,
      docxUrl: docUrl(created),
      wikiUrl: wikiMove.url,
      wikiNodeToken: wikiMove.nodeToken
    },
    readbackVerification: {
      ok: true,
      expectedHash,
      actualHash
    },
    warnings: imported.warnings
  };
}

function docToken(file: FeishuDriveFile): string | undefined {
  return file.document_id ?? file.obj_token ?? file.token;
}

function docUrl(file: FeishuDriveFile): string | undefined {
  return typeof file.url === 'string' ? file.url : undefined;
}
```

- [ ] **Step 4: Verify runner tests**

Run:

```bash
npm test -- publish-new
```

Expected: pass. If hash verification fails because local renderer output differs from test fixture, update the fixture to match `markdownToFeishuBlocks('# Doc\n\nBody\n')`.

### Task 4: CLI Command And Output

**Files:**
- Create: `packages/cli/src/publish-new/output.ts`
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Test: `packages/cli/test/publish-new-cli-output.test.ts`
- Test: `packages/cli/test/cli-help-surface.test.ts`

- [ ] **Step 1: Add CLI output tests**

Create `packages/cli/test/publish-new-cli-output.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { publishNewSummaryLines } from '../src/publish-new/output.js';
import type { PublishNewRunResult } from '../src/publish-new/run-publish-new.js';

describe('publish-new CLI output', () => {
  it('prints a dry-run creation plan', () => {
    expect(publishNewSummaryLines(result())).toEqual([
      'Intent: publish new Feishu document from local Markdown',
      'Title: Doc',
      'Destination: folder folder-token',
      'Strategy: create-docx-blocks',
      '',
      'Planned Feishu changes:',
      '- create 1 docx document',
      '- create 2 blocks',
      '- move to wiki: no',
      '',
      'Run with --write to create the document.'
    ]);
  });

  it('prints write result and next push command', () => {
    expect(publishNewSummaryLines(result({
      mode: 'write',
      receiptWritten: true,
      receiptPath: '/tmp/.sync/feishu/doc.md.doc123.json',
      sourcePath: '/tmp/doc.md',
      created: {
        documentId: 'doc123',
        docxUrl: 'https://example.feishu.cn/docx/doc123'
      }
    }))).toContain("Next: md2feishu push /tmp/doc.md 'https://example.feishu.cn/docx/doc123'");
  });
});

function result(overrides: Partial<PublishNewRunResult> = {}): PublishNewRunResult {
  return {
    mode: 'dry-run',
    sourcePath: '/tmp/doc.md',
    plan: {
      intent: 'publish new Feishu document from local Markdown',
      title: 'Doc',
      strategy: 'create-docx-blocks',
      destination: {
        kind: 'folder',
        folderToken: 'folder-token'
      },
      creates: {
        documents: 1,
        blocks: 2,
        wikiMove: false
      },
      approvalMessage: 'Run with --write to create the document.'
    },
    receiptPath: '/tmp/.sync/feishu/doc.md.new.json',
    receiptWritten: false,
    created: {},
    readbackVerification: {
      ok: true,
      expectedHash: 'hash',
      actualHash: 'hash'
    },
    warnings: [],
    ...overrides
  };
}
```

- [ ] **Step 2: Implement output helper**

Create `packages/cli/src/publish-new/output.ts`:

```ts
import type { PublishNewDestination } from './plan.js';
import type { PublishNewRunResult } from './run-publish-new.js';

export function publishNewSummaryLines(result: PublishNewRunResult): string[] {
  const lines = [
    'Intent: publish new Feishu document from local Markdown',
    `Title: ${result.plan.title}`,
    `Destination: ${destinationLabel(result.plan.destination)}`,
    `Strategy: ${result.plan.strategy}`,
    ''
  ];

  if (result.mode === 'dry-run') {
    lines.push(
      'Planned Feishu changes:',
      `- create ${result.plan.creates.documents} docx document`,
      `- create ${result.plan.creates.blocks} blocks`,
      `- move to wiki: ${result.plan.creates.wikiMove ? 'yes' : 'no'}`,
      '',
      result.plan.approvalMessage
    );
    return lines;
  }

  lines.push(
    'Created Feishu document:',
    `- document id: ${result.created.documentId ?? '(unknown)'}`,
    `- docx url: ${result.created.docxUrl ?? '(not returned)'}`,
    `- wiki url: ${result.created.wikiUrl ?? '(not moved to wiki)'}`,
    `- receipt: ${result.receiptPath}`,
    `Readback verification: ${result.readbackVerification.ok ? 'passed' : 'failed'}`
  );

  const nextUrl = result.created.wikiUrl ?? result.created.docxUrl;
  if (nextUrl) {
    lines.push(`Next: md2feishu push ${result.sourcePath} '${nextUrl}'`);
  }

  return lines;
}

function destinationLabel(destination: PublishNewDestination): string {
  if (destination.kind === 'folder') return `folder ${destination.folderToken}`;
  return `wiki parent ${destination.parentNodeToken} in space ${destination.spaceId}`;
}
```

- [ ] **Step 3: Wire `publish-new` into Commander**

Modify `packages/cli/src/cli/commands/sync.ts`:

```ts
import { runPublishNew } from '../../publish-new/run-publish-new.js';
import { publishNewSummaryLines } from '../../publish-new/output.js';
```

Add command option types:

```ts
type PublishNewCommandOptions = BaseCommandOptions & {
  title?: string;
  folderToken?: string;
  wikiSpaceId?: string;
  wikiParent?: string;
  write?: boolean;
  yes?: boolean;
  publishProfile?: string;
  markdownEngine?: string;
  format?: string;
};
```

Register the command after `push`:

```ts
  program
    .command('publish-new')
    .description('publish local Markdown to a new Feishu document')
    .argument('<markdown-file>', 'local Markdown file')
    .option('--title <title>', 'Feishu document title; defaults to first H1 or file name')
    .option('--folder-token <token>', 'Feishu Drive staging folder token')
    .option('--wiki-space-id <space-id>', 'Feishu wiki space ID for final placement')
    .option('--wiki-parent <node-token>', 'Feishu wiki parent node token for final placement')
    .option('--write', 'create and write the new Feishu document; omitted means dry-run')
    .option('-y, --yes', 'skip write confirmation')
    .option('--publish-profile <profile>', 'apply a publish transform profile: milvus')
    .option('--markdown-engine <engine>', 'Markdown conversion engine: auto | official | local', 'auto')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .option('--env-file <file>', 'load credentials from an explicit dotenv file')
    .option('--host <url>', 'Feishu API host', process.env.FEISHU_HOST ?? 'https://open.feishu.cn')
    .option('--timeout-ms <number>', 'Feishu API timeout in milliseconds', parseIntOption, 20_000)
    .action(async (markdownFile: string, opts: PublishNewCommandOptions) => {
      await runPublishNewCommand(context, markdownFile, normalizePublishNewOptions(program, opts));
    });
```

Add `normalizePublishNewOptions` and `runPublishNewCommand` beside existing push helpers. The normalized options must map `--wiki-parent` to `wikiParentNodeToken`.

- [ ] **Step 4: Add CLI help test expectations**

Modify `packages/cli/test/cli-help-surface.test.ts` so top-level help includes:

```ts
expect(stdout).toContain('publish-new');
```

Add a subcommand help assertion:

```ts
it('documents publish-new as first publication', async () => {
  const help = await execCli(['publish-new', '--help']);
  expect(help.stdout).toContain('publish local Markdown to a new Feishu document');
  expect(help.stdout).toContain('--wiki-parent');
  expect(help.stdout).toContain('--folder-token');
});
```

- [ ] **Step 5: Verify CLI tests**

Run:

```bash
npm test -- publish-new-cli-output cli-help-surface
```

Expected: pass.

### Task 5: Workflow Registry, Harness, And Skill

**Files:**
- Modify: `packages/cli/src/workflows/registry.ts`
- Modify: `packages/cli/src/harness/task.ts`
- Modify: `packages/cli/src/harness/tools.ts`
- Modify: `packages/cli/src/harness/grade.ts`
- Create: `skills/feishu-publish-new/SKILL.md`
- Create: `apps/docs/agent/skills/feishu-publish-new.md`
- Modify: `scripts/install-codex-skills.sh`
- Test: `packages/cli/test/workflow-registry.test.ts`
- Test: `packages/cli/test/harness-tools.test.ts`

- [ ] **Step 1: Add workflow registry tests**

Modify `packages/cli/test/workflow-registry.test.ts`:

```ts
expect(listWorkflowRecipes().map((recipe) => recipe.id)).toEqual([
  'baseline-sync',
  'publish-new',
  'push',
  'multisdk-examples',
  'sdk-reference-authoring',
  'sdk-reference-web-content-release',
  'release-notes'
]);
```

Add:

```ts
it('describes publish-new as the first-publication workflow', () => {
  const recipe = getWorkflowRecipe('publish-new');
  expect(recipe.title).toBe('Publish local Markdown to a new Feishu document');
  expect(recipe.steps.map((step) => step.id)).toEqual([
    'dry-run',
    'write',
    'visual-verify',
    'next-push'
  ]);
  expect(recipe.steps[0].command).toBe('md2feishu publish-new <doc.md>');
  expect(recipe.steps[1].command).toContain('--write');
});
```

- [ ] **Step 2: Add the workflow recipe**

Modify `packages/cli/src/workflows/registry.ts`:

```ts
export type WorkflowId =
  | 'baseline-sync'
  | 'publish-new'
  | 'push'
  | 'multisdk-examples'
  | 'sdk-reference-authoring'
  | 'sdk-reference-web-content-release'
  | 'release-notes';
```

Add a recipe after `baseline-sync`:

```ts
  {
    id: 'publish-new',
    title: 'Publish local Markdown to a new Feishu document',
    whenToUse: 'A local Markdown file does not yet have a corresponding Feishu document and needs a stable Feishu URL for future pushes.',
    primaryArtifacts: ['new Feishu docx URL', 'optional wiki URL', '.sync/feishu receipt'],
    steps: [
      { id: 'dry-run', purpose: 'Plan the new document title, destination, and block creation.', command: 'md2feishu publish-new <doc.md>', writes: 'none', verifies: 'Title, destination, strategy, and block count are clear.' },
      { id: 'write', purpose: 'Create the new Feishu document after approval.', command: 'md2feishu publish-new <doc.md> --write -y', writes: 'feishu', verifies: 'Readback verification passes and a receipt is written.' },
      { id: 'visual-verify', purpose: 'Inspect the created Feishu document.', command: 'Open the returned Feishu URL.', writes: 'none', verifies: 'Rendered content and destination are correct.' },
      { id: 'next-push', purpose: 'Use the returned URL for future edits.', command: "md2feishu push <doc.md> '<new-feishu-url>'", writes: 'none', verifies: 'Future edits use the existing-document push workflow.' }
    ]
  },
```

- [ ] **Step 3: Add the skill**

Create `skills/feishu-publish-new/SKILL.md`:

```markdown
---
name: feishu-publish-new
description: Use when local Markdown should be published to Feishu and no remote Feishu document exists yet.
---

# Feishu Publish New

Use this when the user has a local Markdown file but no existing Feishu docx or wiki URL.

Do not use this for normal edits to an existing Feishu document. Use `feishu-push` when the user provides a Feishu document URL or token.

## Required Discovery

Run:

```bash
md2feishu workflow show publish-new --format json
```

If `md2feishu` is not linked globally, run:

```bash
npm exec -- md2feishu workflow show publish-new --format json
```

Follow the returned steps.

## Safety Rules

- Start with a dry-run.
- Summarize title, destination, strategy, block count, and whether the document will be moved to wiki.
- Do not write if no destination is configured.
- If a write succeeds, preserve the returned URL and receipt path.
- Future edits must use `feishu-push` with the returned Feishu URL.

## Completion

Finish only when readback verification passes and the user has the new Feishu URL.
```

- [ ] **Step 4: Install script update**

Modify `scripts/install-codex-skills.sh` so `skills_to_install` includes:

```bash
  feishu-publish-new
```

- [ ] **Step 5: Verify registry and skill tests**

Run:

```bash
npm test -- workflow-registry harness-tools
```

Expected: pass.

### Task 6: User Documentation

**Files:**
- Create: `apps/docs/guide/publish-new.md`
- Create: `apps/docs/agent/skills/feishu-publish-new.md`
- Modify: `apps/docs/.vitepress/config.ts`
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `apps/docs/index.md`
- Modify: `apps/docs/guide/quickstart.md`
- Modify: `apps/docs/guide/workflows.md`
- Modify: `apps/docs/guide/configuration.md`
- Modify: `apps/docs/reference/commands.md`
- Modify: `apps/docs/reference/safety-gates.md`
- Modify: `apps/docs/internals/capability-inventory.md`

- [ ] **Step 1: Add guide page**

Create `apps/docs/guide/publish-new.md`:

```markdown
# Publish New

Publish New creates the first Feishu document for a local Markdown file.

Use it when there is no existing Feishu docx or wiki URL yet. If a Feishu document already exists, use [Feishu Push](/guide/push).

## Workflow

Dry-run first:

```bash
md2feishu publish-new doc.md
```

Write only after the title and destination are correct:

```bash
md2feishu publish-new doc.md --write -y
```

The command returns a new Feishu URL and writes a local `.sync/feishu` receipt after readback verification passes.

## Destination

Configure a default destination:

```bash
FEISHU_PUBLISH_FOLDER_TOKEN=...
FEISHU_PUBLISH_SPACE_ID=...
FEISHU_PUBLISH_PARENT_NODE_TOKEN=...
```

The folder token is the staging location used to create the docx. The wiki space and parent node place the created docx under a stable team-owned wiki location.

You can also pass the destination explicitly:

```bash
md2feishu publish-new doc.md --folder-token <folder-token>
md2feishu publish-new doc.md --folder-token <folder-token> --wiki-space-id <space-id> --wiki-parent <node-token>
```

## After Creation

Use the returned URL for later edits:

```bash
md2feishu push doc.md '<new-feishu-url>'
```
```

- [ ] **Step 2: Add agent skill page**

Create `apps/docs/agent/skills/feishu-publish-new.md`:

```markdown
# feishu-publish-new

Installable skill source: `skills/feishu-publish-new/SKILL.md`.

Use this skill when local Markdown needs a new Feishu document.

Do not use it when the user already has a Feishu URL. Use `feishu-push` for existing documents.
```

- [ ] **Step 3: Update docs navigation and references**

Update:

- `apps/docs/.vitepress/config.ts` to add `/guide/publish-new` and `/agent/skills/feishu-publish-new`.
- `README.md` and `packages/cli/README.md` workflow tables to include `feishu-publish-new`.
- `apps/docs/guide/quickstart.md` workflow table to separate:
  - publish new local Markdown -> `feishu-publish-new`
  - push edits to existing Feishu doc -> `feishu-push`
- `apps/docs/guide/configuration.md` with:
  - `FEISHU_PUBLISH_FOLDER_TOKEN`
  - `FEISHU_PUBLISH_SPACE_ID`
  - `FEISHU_PUBLISH_PARENT_NODE_TOKEN`
  - extra wiki/Drive/docx permissions.
- `apps/docs/reference/commands.md` with the `publish-new` command and options.
- `apps/docs/reference/safety-gates.md` with the destination gate and readback gate.

- [ ] **Step 4: Verify docs build**

Run:

```bash
npm run docs:build
```

Expected: pass.

### Task 7: Live Smoke Test Plan

**Files:**
- Create: `docs/superpowers/plans/2026-05-29-feishu-publish-new-live-test.md`

- [ ] **Step 1: Add live test plan**

Create `docs/superpowers/plans/2026-05-29-feishu-publish-new-live-test.md`:

```markdown
# Feishu Publish-New Live Test Plan

> **For agentic workers:** This tests first publication against a disposable Feishu destination. Do not use the shared wiki page used for push acceptance.

**Goal:** Verify that `feishu-publish-new` creates a new Feishu docx from local Markdown, optionally places it under the configured wiki parent, writes a receipt, and enables a follow-up `feishu-push` dry-run against the returned URL.

**Local file:** `/private/tmp/feishu-md-sync-publish-new-live.md`

**Acceptance content:**

```markdown
# Publish New Acceptance

Live publish-new acceptance note: created from local Markdown on 2026-05-29.
```

## Workflow

1. Create the local Markdown file.
2. Run `md2feishu publish-new /private/tmp/feishu-md-sync-publish-new-live.md`.
3. Confirm title, destination, block count, and wiki move plan.
4. Run `md2feishu publish-new /private/tmp/feishu-md-sync-publish-new-live.md --write -y`.
5. Confirm readback verification passes.
6. Pull the returned URL with `md2feishu pull '<new-url>' --output /private/tmp/feishu-md-sync-publish-new-live.readback.md --overwrite`.
7. Confirm the acceptance note appears once.
8. Run `md2feishu push /private/tmp/feishu-md-sync-publish-new-live.md '<new-url>'`.
9. Confirm push dry-run is clean or explains only harmless normalization differences.

## Results

Fill after execution.
```

### Task 8: Full Verification

**Files:**
- All touched files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- publish-new publish-new-plan publish-new-cli-output feishu-client workflow-registry cli-help-surface harness-tools
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 4: Run docs build**

Run:

```bash
npm run docs:build
```

Expected: pass.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

## Completion Criteria

- `md2feishu publish-new` exists and dry-runs by default.
- Write mode creates a new docx, writes Markdown blocks, verifies readback, and writes a receipt.
- Wiki destination is supported when configured.
- The command output gives the user the new URL and the next `md2feishu push` command.
- Workflow registry and installable skill include `publish-new`.
- Docs explain when to use `publish-new` versus `push`.
- Unit tests, typecheck, and docs build pass.
- A disposable live Feishu smoke test plan exists before any real write.
