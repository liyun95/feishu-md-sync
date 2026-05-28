# Feishu Block-Level Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace coarse section replacement with safe Feishu-native block-level sync for Markdown-authored documentation, while preserving official Markdown pull quality and preventing escaped Markdown pollution.

**Architecture:** Keep official Feishu Markdown export/import as representation adapters, not as the sync engine. The sync engine reads the remote docx block tree, extracts only the requested local Markdown section, converts that section to desired blocks, matches desired blocks against remote blocks, and applies Feishu Docx Block API operations (`batch_update`, `createChildren`, `batch_delete`) at the smallest safe scope.

**Tech Stack:** Node 20+, TypeScript ESM, Vitest, Commander, Feishu/Lark Docx Block API, Feishu Docs Content API, official block convert API, existing receipt and patch planning modules.

---

## Official API Model

Use these official Feishu/Lark API capabilities as the design boundary:

- `GET /open-apis/docx/v1/documents/:document_id/blocks`: read the docx block tree. The current client already wraps this in `FeishuDocxClient.getDocumentBlocksPage`.
- `POST /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children`: create child blocks under a parent block. The current client wraps this in `createChildren`.
- `DELETE /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children/batch_delete`: delete a contiguous child range. The current client wraps this in `deleteChildren`.
- `PATCH /open-apis/docx/v1/documents/:document_id/blocks/batch_update`: update existing blocks in place. The current client wraps this in `batchUpdateBlocks`.
- `GET /open-apis/docs/v1/content?content_type=markdown`: export Feishu content as Markdown. The current Markdown engine uses this through `DocsContentClient`.
- `POST /open-apis/docx/v1/documents/blocks/convert`: convert Markdown or HTML into docx blocks. The current Markdown engine uses this through `BlockConvertClient`.

Design rule: official Markdown conversion may produce the desired block shape, but it does not know remote `block_id`s and cannot produce a sync patch by itself. Block-level sync must be implemented with Docx Block APIs.

## Current Failure To Fix

The live test exposed two independent failures:

1. Official Markdown export returns escaped Markdown (`\.`, `\_`, `\&lt;`, `\&\#39;`). When official import fails and the CLI falls back to the local renderer, those escapes are written as literal text.
2. `sync --section` currently replaces the whole section range. It creates replacement blocks after the remote section and then deletes the old section. This preserves content on create failure, but Feishu history shows an entire section delete/recreate and block-level identity is lost.

## Target Behavior

For this workflow:

```bash
md2feishu pull <feishu-doc> --output doc.md
# user edits one paragraph or adds one line under ## FAQ
md2feishu sync doc.md <feishu-doc> --section FAQ
md2feishu sync doc.md <feishu-doc> --section FAQ --write -y
```

The dry-run should say:

```text
section: FAQ
plan: block-level
updates: 0
creates: 1
deletes: 0
fallback: none
```

If a paragraph changes in place, the plan should use `batch_update` and preserve the remote block ID. If a line is added, the plan should create only that block at the correct index. It should not delete and recreate the whole `FAQ` section unless the planner explicitly falls back with a clear reason.

## File Structure

Create focused modules rather than expanding `run-sync.ts` further.

- Create `packages/cli/src/markdown/official-normalize.ts`: normalizes official Markdown export for local editing and local fallback parsing.
- Create `packages/cli/src/markdown/section-extract.ts`: extracts a unique Markdown heading section from source text before block conversion.
- Create `packages/cli/src/sync/block-update.ts`: builds Feishu `batch_update` requests for text-like blocks.
- Create `packages/cli/src/sync/block-level-plan.ts`: plans in-section block operations.
- Create `packages/cli/src/sync/block-level-apply.ts`: applies in-section update/create/delete operations using Docx Block APIs.
- Modify `packages/cli/src/markdown/engine.ts`: normalize official export before returning Markdown.
- Modify `packages/cli/src/feishu/types.ts`: add block-level sync client methods and patch operation result types.
- Modify `packages/cli/src/sync/run-sync.ts`: route `--section` through section extraction and block-level planning.
- Modify `packages/cli/src/sync/preflight.ts`: reject raw official escaped Markdown before local writes.
- Add tests under `packages/cli/test/` for each new module and the integrated section-sync path.

---

### Task 1: Normalize Official Markdown Export

**Files:**
- Create: `packages/cli/src/markdown/official-normalize.ts`
- Modify: `packages/cli/src/markdown/engine.ts`
- Test: `packages/cli/test/official-markdown-normalize.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Create `packages/cli/test/official-markdown-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeOfficialMarkdownExport } from '../src/markdown/official-normalize.js';

describe('normalizeOfficialMarkdownExport', () => {
  it('decodes escaped Feishu HTML entities and Markdown punctuation outside code fences', () => {
    const input = [
      'Start with `AUTOINDEX`\\. It covers text\\-match and data\\&\\#39;s cardinality\\.',
      '',
      '\\&lt;include target=\\&\\#34;milvus\\&\\#34;\\&gt;Milvus\\&lt;/include\\&gt;',
      '',
      '```python',
      'print(\"keep\\\\_literal\")',
      '```'
    ].join('\n');

    expect(normalizeOfficialMarkdownExport(input)).toBe([
      "Start with `AUTOINDEX`. It covers text-match and data's cardinality.",
      '',
      '<include target=\"milvus\">Milvus</include>',
      '',
      '```python',
      'print(\"keep\\\\_literal\")',
      '```'
    ].join('\n'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- official-markdown-normalize
```

Expected: FAIL with a missing module or missing export error.

- [ ] **Step 3: Implement normalization**

Create `packages/cli/src/markdown/official-normalize.ts`:

```ts
const ESCAPED_HTML_ENTITIES: Array<[RegExp, string]> = [
  [/\\&amp;/g, '&'],
  [/\\&lt;/g, '<'],
  [/\\&gt;/g, '>'],
  [/\\&quot;/g, '"'],
  [/\\&#34;/g, '"'],
  [/\\&#39;/g, "'"],
  [/\\&apos;/g, "'"]
];

const COMMONMARK_ESCAPED_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

export function normalizeOfficialMarkdownExport(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  return lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return decodeEscapedHtmlEntities(line).replace(COMMONMARK_ESCAPED_PUNCTUATION, '$1');
  }).join('\n');
}

function decodeEscapedHtmlEntities(value: string): string {
  return ESCAPED_HTML_ENTITIES.reduce((current, [pattern, replacement]) => {
    return current.replace(pattern, replacement);
  }, value);
}
```

- [ ] **Step 4: Wire official export through normalization**

Modify `packages/cli/src/markdown/engine.ts`:

```ts
import { normalizeOfficialMarkdownExport } from './official-normalize.js';
```

Change the successful official export return block:

```ts
const markdown = await official.getMarkdownContent(input.documentId);
return {
  markdown: normalizeOfficialMarkdownExport(markdown),
  engine: 'official',
  warnings: []
};
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm test -- official-markdown-normalize official-markdown-engine
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/markdown/official-normalize.ts packages/cli/src/markdown/engine.ts packages/cli/test/official-markdown-normalize.test.ts
git commit -m "Normalize official Feishu Markdown export"
```

---

### Task 2: Extract Local Markdown Section Before Conversion

**Files:**
- Create: `packages/cli/src/markdown/section-extract.ts`
- Test: `packages/cli/test/markdown-section-extract.test.ts`

- [ ] **Step 1: Write failing section extraction tests**

Create `packages/cli/test/markdown-section-extract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractUniqueMarkdownSection } from '../src/markdown/section-extract.js';

describe('extractUniqueMarkdownSection', () => {
  it('extracts a heading section including nested subsections', () => {
    const markdown = [
      '# Title',
      '',
      'Intro',
      '',
      '## FAQ',
      '',
      'A',
      '',
      '### Child',
      '',
      'B',
      '',
      '## Other',
      '',
      'C'
    ].join('\n');

    expect(extractUniqueMarkdownSection(markdown, 'FAQ')).toEqual({
      title: 'FAQ',
      level: 2,
      startLine: 4,
      endLine: 11,
      markdown: '## FAQ\n\nA\n\n### Child\n\nB\n'
    });
  });

  it('ignores headings inside fenced code blocks', () => {
    const markdown = [
      '```md',
      '## FAQ',
      '```',
      '',
      '## FAQ',
      '',
      'Visible'
    ].join('\n');

    expect(extractUniqueMarkdownSection(markdown, 'FAQ').markdown).toBe('## FAQ\n\nVisible\n');
  });

  it('fails when the section is missing or duplicated', () => {
    expect(() => extractUniqueMarkdownSection('# Title\n', 'FAQ')).toThrow(/Could not find local section "FAQ"/);
    expect(() => extractUniqueMarkdownSection('## FAQ\nA\n\n## FAQ\nB\n', 'FAQ')).toThrow(/Found 2 local sections named "FAQ"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- markdown-section-extract
```

Expected: FAIL with a missing module or missing export error.

- [ ] **Step 3: Implement section extraction**

Create `packages/cli/src/markdown/section-extract.ts`:

```ts
export type MarkdownSection = {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
  markdown: string;
};

type HeadingMatch = {
  title: string;
  level: number;
  lineIndex: number;
};

export function extractUniqueMarkdownSection(markdown: string, sectionTitle: string): MarkdownSection {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headings = collectHeadings(lines);
  const normalizedTarget = normalizeHeading(sectionTitle);
  const matches = headings.filter((heading) => normalizeHeading(heading.title) === normalizedTarget);

  if (matches.length === 0) {
    throw new Error(`Could not find local section "${sectionTitle}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} local sections named "${sectionTitle}". Section sync requires a unique heading.`);
  }

  const match = matches[0];
  let endLine = lines.length;
  for (const heading of headings) {
    if (heading.lineIndex > match.lineIndex && heading.level <= match.level) {
      endLine = heading.lineIndex;
      break;
    }
  }

  return {
    title: match.title,
    level: match.level,
    startLine: match.lineIndex,
    endLine,
    markdown: `${lines.slice(match.lineIndex, endLine).join('\n').replace(/\n*$/, '')}\n`
  };
}

function collectHeadings(lines: string[]): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) return;
    headings.push({
      level: match[1].length,
      title: stripHeadingAnchor(match[2]),
      lineIndex
    });
  });

  return headings;
}

function stripHeadingAnchor(value: string): string {
  return value.trim().replace(/\s*\{#[A-Za-z0-9_-]+\}\s*$/, '').trim();
}

function normalizeHeading(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- markdown-section-extract
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/markdown/section-extract.ts packages/cli/test/markdown-section-extract.test.ts
git commit -m "Extract Markdown sections before conversion"
```

---

### Task 3: Add Preflight Guard Against Raw Escaped Official Markdown

**Files:**
- Modify: `packages/cli/src/sync/preflight.ts`
- Test: `packages/cli/test/preflight.test.ts`

- [ ] **Step 1: Add failing preflight tests**

Update the existing import in `packages/cli/test/preflight.test.ts`:

```ts
import { assertFeishuBlocksWritable, assertMarkdownSourceSafeForLocalRenderer, validateFeishuBlocksForWrite } from '../src/sync/preflight.js';
```

Then append:

```ts
describe('Markdown source preflight', () => {
  it('rejects likely raw official Feishu escaped Markdown before local rendering', () => {
    const markdown = [
      '## FAQ',
      '',
      'Start with `AUTOINDEX`\\. It covers data\\&\\#39;s cardinality\\.',
      'Use \\&lt;include target=\\&\\#34;milvus\\&\\#34;\\&gt;Milvus\\&lt;/include\\&gt;.'
    ].join('\n');

    expect(() => assertMarkdownSourceSafeForLocalRenderer(markdown)).toThrow(/escaped Feishu Markdown/);
  });

  it('allows ordinary Markdown with a small number of intentional escapes', () => {
    expect(() => assertMarkdownSourceSafeForLocalRenderer('Use \\*literal stars\\* here.\n')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- preflight
```

Expected: FAIL because `assertMarkdownSourceSafeForLocalRenderer` does not exist.

- [ ] **Step 3: Implement the guard**

Add to `packages/cli/src/sync/preflight.ts`:

```ts
export function assertMarkdownSourceSafeForLocalRenderer(markdown: string): void {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, '');
  const escapedEntityCount = (withoutCode.match(/\\&(?:lt|gt|amp|quot|#34|#39);/g) ?? []).length;
  const escapedPunctuationCount = (withoutCode.match(/\\[._\-()[\]{}]/g) ?? []).length;

  if (escapedEntityCount >= 2 || escapedPunctuationCount >= 12) {
    throw new Error(
      'Refusing to render likely raw escaped Feishu Markdown with the local renderer. ' +
      'Run pull again after official Markdown normalization, or use --markdown-engine official after dry-run safety checks pass.'
    );
  }
}
```

- [ ] **Step 4: Call the guard when local import is used**

Modify `packages/cli/src/markdown/engine.ts` local import path:

```ts
import { assertMarkdownSourceSafeForLocalRenderer } from '../sync/preflight.js';
```

Change `localImport`:

```ts
function localImport(input: MarkdownImportInput): { blocks: FeishuBlock[]; engine: 'local'; warnings: string[] } {
  assertMarkdownSourceSafeForLocalRenderer(input.markdown);
  return {
    blocks: markdownToFeishuBlocks(input.markdown),
    engine: 'local',
    warnings: []
  };
}
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm test -- preflight official-markdown-engine markdown
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/sync/preflight.ts packages/cli/src/markdown/engine.ts packages/cli/test/preflight.test.ts
git commit -m "Guard local rendering from escaped Feishu Markdown"
```

---

### Task 4: Build Text-Like Block Update Requests

**Files:**
- Create: `packages/cli/src/sync/block-update.ts`
- Modify: `packages/cli/src/feishu/types.ts`
- Test: `packages/cli/test/block-update.test.ts`

- [ ] **Step 1: Write failing block update tests**

Create `packages/cli/test/block-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTextLikeBlockUpdateRequest, isTextLikeBlockPairUpdateable } from '../src/sync/block-update.js';

describe('block update planning', () => {
  it('builds a paragraph update request that preserves the remote block id', () => {
    const remote = {
      block_id: 'remote-1',
      block_type: 2,
      text: { elements: [{ text_run: { content: 'Old', text_element_style: {} } }] }
    };
    const desired = {
      block_type: 2,
      text: { elements: [{ text_run: { content: 'New', text_element_style: { bold: true } } }] }
    };

    expect(isTextLikeBlockPairUpdateable(remote, desired)).toBe(true);
    expect(buildTextLikeBlockUpdateRequest(remote, desired)).toEqual({
      block_id: 'remote-1',
      update_text_elements: {
        elements: [{ text_run: { content: 'New', text_element_style: { bold: true } } }]
      }
    });
  });

  it('refuses different block types and blocks without ids', () => {
    expect(isTextLikeBlockPairUpdateable({ block_type: 2 }, { block_type: 2 })).toBe(false);
    expect(isTextLikeBlockPairUpdateable({ block_id: 'a', block_type: 2 }, { block_type: 31 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- block-update
```

Expected: FAIL with missing module error.

- [ ] **Step 3: Extend client type for batch updates**

Modify `packages/cli/src/feishu/types.ts`:

```ts
export interface FeishuDocClient {
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
  deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
  createChildren(
    documentId: string,
    parentBlockId: string,
    blocks: FeishuBlock[],
    options?: { index?: number }
  ): Promise<FeishuBlock[]>;
  batchUpdateBlocks?(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
}
```

- [ ] **Step 4: Implement text-like request builder**

Create `packages/cli/src/sync/block-update.ts`:

```ts
import type { FeishuBlock, FeishuBlockUpdateRequest, TextElement } from '../feishu/types.js';

const TEXT_LIKE_KEYS: Record<number, string> = {
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  12: 'bullet',
  13: 'ordered',
  14: 'code'
};

export function isTextLikeBlockPairUpdateable(remote: FeishuBlock, desired: FeishuBlock): boolean {
  if (!remote.block_id) return false;
  if (remote.block_type !== desired.block_type) return false;
  return Boolean(TEXT_LIKE_KEYS[remote.block_type] && elementsForBlock(desired));
}

export function buildTextLikeBlockUpdateRequest(remote: FeishuBlock, desired: FeishuBlock): FeishuBlockUpdateRequest {
  if (!remote.block_id || !isTextLikeBlockPairUpdateable(remote, desired)) {
    throw new Error(`Block ${remote.block_id ?? '<missing id>'} cannot be updated in place.`);
  }
  return {
    block_id: remote.block_id,
    update_text_elements: {
      elements: elementsForBlock(desired) ?? []
    }
  };
}

export function elementsForBlock(block: FeishuBlock): TextElement[] | null {
  const key = TEXT_LIKE_KEYS[block.block_type];
  if (!key) return null;
  const value = block[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const elements = (value as { elements?: unknown }).elements;
  return Array.isArray(elements) ? elements as TextElement[] : null;
}
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npm test -- block-update
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/sync/block-update.ts packages/cli/src/feishu/types.ts packages/cli/test/block-update.test.ts
git commit -m "Build in-place Feishu block update requests"
```

---

### Task 5: Plan Section-Scoped Block-Level Operations

**Files:**
- Create: `packages/cli/src/sync/block-level-plan.ts`
- Test: `packages/cli/test/block-level-plan.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `packages/cli/test/block-level-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planBlockLevelSectionPatch } from '../src/sync/block-level-plan.js';

describe('planBlockLevelSectionPatch', () => {
  it('plans an in-place update for a changed text block', () => {
    const remote = [
      heading(2, 'FAQ', 'h1'),
      text('Old answer', 'p1'),
      heading(2, 'Other', 'h2')
    ];
    const desired = [
      heading(2, 'FAQ'),
      text('New answer')
    ];

    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: remote.slice(0, 2),
      desiredSectionBlocks: desired,
      parentBlockId: 'page',
      remoteStartIndex: 0
    });

    expect(plan.kind).toBe('block-level-section-patch');
    expect(plan.operations).toEqual([
      {
        kind: 'update',
        remoteBlockId: 'p1',
        remoteIndex: 1,
        desiredIndex: 1,
        blockType: 2
      }
    ]);
  });

  it('plans an insert without deleting the section', () => {
    const plan = planBlockLevelSectionPatch({
      remoteSectionBlocks: [heading(2, 'FAQ', 'h1')],
      desiredSectionBlocks: [heading(2, 'FAQ'), text('New line')],
      parentBlockId: 'page',
      remoteStartIndex: 4
    });

    expect(plan.operations).toEqual([
      {
        kind: 'create',
        parentBlockId: 'page',
        index: 5,
        desiredStartIndex: 1,
        desiredEndIndex: 2,
        blocks: [text('New line')]
      }
    ]);
  });
});

function heading(level: number, title: string, blockId?: string) {
  return {
    block_id: blockId,
    block_type: level + 2,
    [`heading${level}`]: { elements: [{ text_run: { content: title, text_element_style: {} } }] }
  };
}

function text(content: string, blockId?: string) {
  return {
    block_id: blockId,
    block_type: 2,
    text: { elements: [{ text_run: { content, text_element_style: {} } }] }
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- block-level-plan
```

Expected: FAIL with missing module error.

- [ ] **Step 3: Implement minimal text-like planner**

Create `packages/cli/src/sync/block-level-plan.ts`:

```ts
import { hashBlocks } from '../core/hash.js';
import type { FeishuBlock } from '../feishu/types.js';
import { isTextLikeBlockPairUpdateable } from './block-update.js';

export type BlockLevelOperation =
  | {
    kind: 'update';
    remoteBlockId: string;
    remoteIndex: number;
    desiredIndex: number;
    blockType: number;
  }
  | {
    kind: 'create';
    parentBlockId: string;
    index: number;
    desiredStartIndex: number;
    desiredEndIndex: number;
    blocks: FeishuBlock[];
  }
  | {
    kind: 'delete';
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
  }
  | {
    kind: 'replace-range';
    parentBlockId: string;
    startIndex: number;
    endIndex: number;
    blocks: FeishuBlock[];
    reason: string;
  };

export type BlockLevelSectionPatch = {
  kind: 'block-level-section-patch';
  operations: BlockLevelOperation[];
  fallbackReason?: string;
};

export function planBlockLevelSectionPatch(input: {
  remoteSectionBlocks: FeishuBlock[];
  desiredSectionBlocks: FeishuBlock[];
  parentBlockId: string;
  remoteStartIndex: number;
}): BlockLevelSectionPatch {
  const operations: BlockLevelOperation[] = [];
  const maxLength = Math.max(input.remoteSectionBlocks.length, input.desiredSectionBlocks.length);

  for (let index = 0; index < maxLength; index += 1) {
    const remote = input.remoteSectionBlocks[index];
    const desired = input.desiredSectionBlocks[index];
    if (remote && desired && hashBlocks([remote]) === hashBlocks([desired])) continue;

    if (remote && desired && isTextLikeBlockPairUpdateable(remote, desired)) {
      operations.push({
        kind: 'update',
        remoteBlockId: remote.block_id as string,
        remoteIndex: input.remoteStartIndex + index,
        desiredIndex: index,
        blockType: remote.block_type
      });
      continue;
    }

    if (!remote && desired) {
      const start = index;
      const blocks = input.desiredSectionBlocks.slice(start);
      operations.push({
        kind: 'create',
        parentBlockId: input.parentBlockId,
        index: input.remoteStartIndex + input.remoteSectionBlocks.length,
        desiredStartIndex: start,
        desiredEndIndex: input.desiredSectionBlocks.length,
        blocks
      });
      break;
    }

    if (remote && !desired) {
      operations.push({
        kind: 'delete',
        parentBlockId: input.parentBlockId,
        startIndex: input.remoteStartIndex + index,
        endIndex: input.remoteStartIndex + input.remoteSectionBlocks.length
      });
      break;
    }

    return {
      kind: 'block-level-section-patch',
      operations: [{
        kind: 'replace-range',
        parentBlockId: input.parentBlockId,
        startIndex: input.remoteStartIndex + index,
        endIndex: input.remoteStartIndex + input.remoteSectionBlocks.length,
        blocks: input.desiredSectionBlocks.slice(index),
        reason: 'block type or structure changed'
      }],
      fallbackReason: 'block type or structure changed'
    };
  }

  return { kind: 'block-level-section-patch', operations };
}
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- block-level-plan block-update
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/block-level-plan.ts packages/cli/test/block-level-plan.test.ts
git commit -m "Plan block-level section patches"
```

---

### Task 6: Apply Block-Level Operations

**Files:**
- Create: `packages/cli/src/sync/block-level-apply.ts`
- Test: `packages/cli/test/block-level-apply.test.ts`

- [ ] **Step 1: Write failing apply tests**

Create `packages/cli/test/block-level-apply.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyBlockLevelSectionPatch } from '../src/sync/block-level-apply.js';

describe('applyBlockLevelSectionPatch', () => {
  it('updates blocks before creating or deleting ranges', async () => {
    const calls: string[] = [];
    const client = {
      batchUpdateBlocks: vi.fn(async () => {
        calls.push('update');
        return [];
      }),
      createChildren: vi.fn(async () => {
        calls.push('create');
        return [{ block_id: 'created', block_type: 2 }];
      }),
      deleteChildren: vi.fn(async () => {
        calls.push('delete');
      })
    };

    await applyBlockLevelSectionPatch(client, 'doc', {
      remoteSectionBlocks: [
        { block_id: 'p1', block_type: 2, text: { elements: [] } }
      ],
      desiredSectionBlocks: [
        { block_type: 2, text: { elements: [] } },
        { block_type: 2, text: { elements: [] } }
      ],
      operations: [
        { kind: 'update', remoteBlockId: 'p1', remoteIndex: 0, desiredIndex: 0, blockType: 2 },
        { kind: 'create', parentBlockId: 'page', index: 1, desiredStartIndex: 1, desiredEndIndex: 2, blocks: [{ block_type: 2, text: { elements: [] } }] }
      ]
    });

    expect(calls).toEqual(['update', 'create']);
    expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc', [
      { block_id: 'p1', update_text_elements: { elements: [] } }
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- block-level-apply
```

Expected: FAIL with missing module error.

- [ ] **Step 3: Implement apply module**

Create `packages/cli/src/sync/block-level-apply.ts`:

```ts
import type { FeishuBlock, FeishuBlockUpdateRequest } from '../feishu/types.js';
import { buildTextLikeBlockUpdateRequest } from './block-update.js';
import type { BlockLevelOperation } from './block-level-plan.js';

export type BlockLevelApplyClient = {
  batchUpdateBlocks?(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
  createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[], options?: { index?: number }): Promise<FeishuBlock[]>;
  deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
};

export type BlockLevelApplyResult = {
  updated: number;
  created: number;
  deleted: number;
};

export async function applyBlockLevelSectionPatch(
  client: BlockLevelApplyClient,
  documentId: string,
  input: {
    remoteSectionBlocks: FeishuBlock[];
    desiredSectionBlocks: FeishuBlock[];
    operations: BlockLevelOperation[];
  }
): Promise<BlockLevelApplyResult> {
  const updateRequests = buildUpdateRequests(input);
  if (updateRequests.length > 0) {
    if (!client.batchUpdateBlocks) {
      throw new Error('Feishu client does not support batchUpdateBlocks; cannot apply block-level updates.');
    }
    await client.batchUpdateBlocks(documentId, updateRequests);
  }

  let created = 0;
  let deleted = 0;

  for (const operation of input.operations) {
    if (operation.kind === 'create') {
      const result = await client.createChildren(documentId, operation.parentBlockId, operation.blocks, { index: operation.index });
      created += result.length;
    }
    if (operation.kind === 'delete') {
      await client.deleteChildren(documentId, operation.parentBlockId, operation.startIndex, operation.endIndex);
      deleted += operation.endIndex - operation.startIndex;
    }
    if (operation.kind === 'replace-range') {
      const result = await client.createChildren(documentId, operation.parentBlockId, operation.blocks, { index: operation.endIndex });
      await client.deleteChildren(documentId, operation.parentBlockId, operation.startIndex, operation.endIndex);
      created += result.length;
      deleted += operation.endIndex - operation.startIndex;
    }
  }

  return { updated: updateRequests.length, created, deleted };
}

function buildUpdateRequests(input: {
  remoteSectionBlocks: FeishuBlock[];
  desiredSectionBlocks: FeishuBlock[];
  operations: BlockLevelOperation[];
}): FeishuBlockUpdateRequest[] {
  return input.operations.flatMap((operation) => {
    if (operation.kind !== 'update') return [];
    const remote = input.remoteSectionBlocks[operation.desiredIndex];
    const desired = input.desiredSectionBlocks[operation.desiredIndex];
    return remote && desired ? [buildTextLikeBlockUpdateRequest(remote, desired)] : [];
  });
}
```

- [ ] **Step 4: Run targeted tests and typecheck**

Run:

```bash
npm test -- block-level-apply block-level-plan block-update
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/block-level-apply.ts packages/cli/test/block-level-apply.test.ts
git commit -m "Apply block-level section patches"
```

---

### Task 7: Wire Section Sync To Block-Level Planner

**Files:**
- Modify: `packages/cli/src/sync/run-sync.ts`
- Modify: `packages/cli/src/sync/patch.ts`
- Modify: `packages/cli/src/cli/commands/sync.ts`
- Test: `packages/cli/test/sync.test.ts`

- [ ] **Step 1: Add failing integration test**

Append to `packages/cli/test/sync.test.ts`:

```ts
it('uses block-level section patch for a single paragraph update', async () => {
  const remote = markdownToFeishuBlocks('## FAQ\n\nOld answer\n\n## Other\n\nKeep\n');
  remote[0].block_id = 'faq-heading';
  remote[1].block_id = 'answer';
  remote[2].block_id = 'other-heading';
  remote[3].block_id = 'keep';

  const client = fakeClient(remote);
  client.batchUpdateBlocks = vi.fn(async () => []);

  const result = await runSync(client, {
    sourcePath: await writeTempMarkdown('## FAQ\n\nNew answer\n\n## Other\n\nLocal ignored\n'),
    documentId: 'doc',
    dryRun: false,
    yes: true,
    section: 'FAQ'
  });

  expect(client.batchUpdateBlocks).toHaveBeenCalledWith('doc', [
    expect.objectContaining({ block_id: 'answer' })
  ]);
  expect(client.deleteChildren).not.toHaveBeenCalled();
  expect(result.blockLevelSectionPatch?.operations).toEqual([
    expect.objectContaining({ kind: 'update', remoteBlockId: 'answer' })
  ]);
  expect(result.patchPlan.operation).toBe('replace-section');
  expect(result.warnings).toContain('Section sync used Feishu block-level patching.');
});
```

If existing helpers differ, reuse the local `fakeClient` and temp file helper patterns already present in `sync.test.ts`; keep the assertions above.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- sync
```

Expected: FAIL because `runSync` still calls `applyPatch` for section replacement.

- [ ] **Step 3: Import new helpers in `run-sync.ts`**

Add imports:

```ts
import { extractUniqueMarkdownSection } from '../markdown/section-extract.js';
import { applyBlockLevelSectionPatch } from './block-level-apply.js';
import { planBlockLevelSectionPatch, type BlockLevelSectionPatch } from './block-level-plan.js';
```

- [ ] **Step 4: Add block-level plan metadata to sync results**

Modify `SyncRunResult` in `packages/cli/src/sync/run-sync.ts`:

```ts
export type SyncRunResult = {
  mode: 'dry-run' | 'write';
  receiptPath: string;
  patchPlan: PatchPlan;
  blockLevelSectionPatch?: BlockLevelSectionPatch | null;
  receipt: SyncReceipt;
  warnings: string[];
  receiptWritten: boolean;
  preflight: MarkdownPreflightReport;
};
```

- [ ] **Step 5: Convert only the requested local section**

Replace this line:

```ts
const desiredImport = await markdownEngine.importMarkdown({ markdown: effectiveSourceContent });
```

With:

```ts
const effectiveMarkdownForImport = options.section
  ? extractUniqueMarkdownSection(effectiveSourceContent, options.section).markdown
  : effectiveSourceContent;
const desiredImport = await markdownEngine.importMarkdown({ markdown: effectiveMarkdownForImport });
```

- [ ] **Step 6: Plan block-level patch before dry-run/write branching**

After `sectionPatch` is computed, create:

```ts
const blockLevelSectionPatch = options.section && sectionPatch
  ? planBlockLevelSectionPatch({
    remoteSectionBlocks: sectionPatch.remoteRange.blocks,
    desiredSectionBlocks: sectionPatch.localRange.blocks,
    parentBlockId: pageBlock.block_id,
    remoteStartIndex: sectionPatch.remoteRange.startIndex
  })
  : null;
```

- [ ] **Step 7: Return block-level plan metadata**

In the final returned object from `runSync`, add:

```ts
blockLevelSectionPatch,
```

- [ ] **Step 8: Apply the same block-level plan in write mode**

In the `mode === 'write'` block, before calling `applyPatch`, use the already-computed plan:

```ts
if (blockLevelSectionPatch && blockLevelSectionPatch.fallbackReason === undefined) {
  const blockLevelResult = await applyBlockLevelSectionPatch(client, options.documentId, {
    remoteSectionBlocks: sectionPatch?.remoteRange.blocks ?? [],
    desiredSectionBlocks: sectionPatch?.localRange.blocks ?? [],
    operations: blockLevelSectionPatch.operations
  });
  writeResult = {
    deleted: blockLevelResult.deleted,
    created: blockLevelResult.created,
    skipped: blockLevelResult.updated === 0 && blockLevelResult.created === 0 && blockLevelResult.deleted === 0
  };
  warnings.push('Section sync used Feishu block-level patching.');
} else {
  writeResult = await applyPatch(client, options.documentId, pageBlock.block_id, patchPlan, patchBlocks);
}
```

- [ ] **Step 9: Print dry-run block-level plan details**

Modify `packages/cli/src/cli/commands/sync.ts` `printResult`:

```ts
if (result.blockLevelSectionPatch) {
  const operations = result.blockLevelSectionPatch.operations;
  console.log('patch mode: block-level');
  console.log(`block updates: ${operations.filter((operation) => operation.kind === 'update').length}`);
  console.log(`block creates: ${operations.filter((operation) => operation.kind === 'create').length}`);
  console.log(`block deletes: ${operations.filter((operation) => operation.kind === 'delete').length}`);
  if (result.blockLevelSectionPatch.fallbackReason) {
    console.log(`block fallback: ${result.blockLevelSectionPatch.fallbackReason}`);
  }
}
```

- [ ] **Step 10: Run targeted tests**

Run:

```bash
npm test -- sync section block-level-plan block-level-apply block-update
npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/cli/src/sync/run-sync.ts packages/cli/src/cli/commands/sync.ts packages/cli/test/sync.test.ts
git commit -m "Use block-level patching for section sync"
```

---

### Task 8: Add Patch Safety Gates And Better Dry-Run Output

**Files:**
- Modify: `packages/cli/src/sync/block-level-plan.ts`
- Test: `packages/cli/test/block-level-plan.test.ts`
- Test: `packages/cli/test/harness-cli.test.ts`

- [ ] **Step 1: Add failing safety tests**

Append to `packages/cli/test/block-level-plan.test.ts`:

```ts
it('falls back when create count is much larger than the remote section', () => {
  const remote = [heading(2, 'FAQ', 'h1'), text('Old', 'p1')];
  const desired = [heading(2, 'FAQ'), ...Array.from({ length: 30 }, (_, index) => text(`Line ${index}`))];

  const plan = planBlockLevelSectionPatch({
    remoteSectionBlocks: remote,
    desiredSectionBlocks: desired,
    parentBlockId: 'page',
    remoteStartIndex: 0
  });

  expect(plan.fallbackReason).toMatch(/unsafe create volume/);
  expect(plan.operations[0]).toMatchObject({ kind: 'replace-range' });
});
```

- [ ] **Step 2: Implement guard**

In `packages/cli/src/sync/block-level-plan.ts`, add near the start of `planBlockLevelSectionPatch`:

```ts
if (input.desiredSectionBlocks.length > Math.max(20, input.remoteSectionBlocks.length * 3)) {
  return {
    kind: 'block-level-section-patch',
    operations: [{
      kind: 'replace-range',
      parentBlockId: input.parentBlockId,
      startIndex: input.remoteStartIndex,
      endIndex: input.remoteStartIndex + input.remoteSectionBlocks.length,
      blocks: input.desiredSectionBlocks,
      reason: 'unsafe create volume'
    }],
    fallbackReason: 'unsafe create volume'
  };
}
```

- [ ] **Step 3: Add a CLI output assertion for fallback details**

Update `packages/cli/test/harness-cli.test.ts` or the existing sync CLI output test to assert that dry-run output contains `patch mode: block-level` and `block fallback:` when `blockLevelSectionPatch.fallbackReason` is present.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- block-level-plan harness-cli
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/sync/block-level-plan.ts packages/cli/src/cli/commands/sync.ts packages/cli/test/block-level-plan.test.ts packages/cli/test/harness-cli.test.ts
git commit -m "Add block-level section sync safety gates"
```

---

### Task 9: Document The New Workflow And Restore Live-Test Guidance

**Files:**
- Modify: `apps/docs/guide/section-sync.md`
- Modify: `apps/docs/reference/safety-gates.md`
- Modify: `apps/docs/reference/markdown-support.md`
- Modify: `apps/docs/internals/feishu-api-notes.md`

- [ ] **Step 1: Update section sync guide**

In `apps/docs/guide/section-sync.md`, describe the new workflow:

```md
## How section sync writes

`sync --section` reads the current Feishu block tree, extracts the matching local Markdown heading section, converts only that section to desired blocks, and writes the smallest safe patch.

For text-like blocks, the CLI updates existing Feishu blocks in place. This preserves block IDs and keeps Feishu edit history focused. When the block type changes or a complex block cannot be updated safely, the CLI falls back to replacing a small contiguous range and explains the fallback in dry-run output.
```

- [ ] **Step 2: Document official Markdown normalization**

In `apps/docs/reference/markdown-support.md`, add:

```md
## Official Feishu Markdown export

When `--markdown-engine auto` can use Feishu's official Markdown export, `pull` normalizes Feishu's escaped Markdown before writing the local file. This prevents raw sequences such as `\.` or `\&\#39;` from being written back as visible text when the local renderer is used as a fallback.
```

- [ ] **Step 3: Document safety gates**

In `apps/docs/reference/safety-gates.md`, add:

```md
## Section sync block-level gates

Section sync refuses unsafe block-level writes when:

- The local section heading is missing or duplicated.
- The remote section heading is missing or duplicated.
- The desired section expands far beyond the current remote section.
- Local rendering sees raw escaped Feishu Markdown that should have been normalized during pull.
- A block type or nested structure cannot be updated in place and the fallback range is too large for an automatic write.
```

- [ ] **Step 4: Update Feishu API notes**

In `apps/docs/internals/feishu-api-notes.md`, add the API boundary:

```md
## Block-level sync boundary

Official Markdown export/import is used as a representation layer. The sync engine uses Docx block APIs for writes:

- `GET /docx/v1/documents/:document_id/blocks`
- `PATCH /docx/v1/documents/:document_id/blocks/batch_update`
- `POST /docx/v1/documents/:document_id/blocks/:block_id/children`
- `DELETE /docx/v1/documents/:document_id/blocks/:block_id/children/batch_delete`

Do not treat Markdown convert as a sync engine. It does not provide remote block IDs or an edit script.
```

- [ ] **Step 5: Build docs**

Run:

```bash
npm run docs:build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/guide/section-sync.md apps/docs/reference/safety-gates.md apps/docs/reference/markdown-support.md apps/docs/internals/feishu-api-notes.md
git commit -m "Document Feishu block-level section sync"
```

---

### Task 10: Live Smoke Test And Repair The Test Document

**Files:**
- No source files unless the smoke test reveals a bug.
- Artifacts under `/private/tmp` and `/Users/liyun/Downloads`.

- [ ] **Step 1: Pull a fresh baseline**

Run:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --markdown-engine auto --output /Users/liyun/Downloads/feishu-md-sync-block-level-baseline.md
```

Expected: output file exists and does not contain visible `\&\#39;` or high-density `\.` escapes in normal paragraphs.

- [ ] **Step 2: Create a small FAQ edit**

Copy the baseline to `/private/tmp/feishu-md-sync-block-level-edited.md` and insert one plain sentence immediately below `## FAQ`:

```md
Live sync acceptance note: block-level section sync wrote this line from local Markdown on 2026-05-28.
```

- [ ] **Step 3: Dry-run section sync**

Run:

```bash
npm exec -- md2feishu sync /private/tmp/feishu-md-sync-block-level-edited.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --section FAQ --markdown-engine auto --format json
```

Expected:

- The plan imports only the `FAQ` section.
- The plan does not show `createCount` near the full document size.
- The plan uses block-level patching or a small bounded fallback.
- The dry-run does not propose deleting the whole section for a one-line insert.

- [ ] **Step 4: Write after dry-run looks safe**

Run:

```bash
npm exec -- md2feishu sync /private/tmp/feishu-md-sync-block-level-edited.md 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --section FAQ --markdown-engine auto --write --yes --format json
```

Expected:

- `verificationResult.ok` is `true`.
- The Feishu edit history does not show the entire `FAQ` section deleted and recreated.
- The rendered document does not show literal `\.` or `\&\#39;` in the changed section.

- [ ] **Step 5: Read back**

Run:

```bash
npm exec -- md2feishu pull 'https://zilliverse.feishu.cn/wiki/ZxQkwC3r6iy3s5kSdgwc2J2nnTf?renamingWikiNode=true' --markdown-engine auto --output /private/tmp/feishu-md-sync-block-level-readback.md
rg -n "block-level section sync|^## FAQ|\\\\&\\\\#39;|\\\\\\." /private/tmp/feishu-md-sync-block-level-readback.md
```

Expected: the acceptance note is present under `## FAQ`; no new visible escape pollution appears in normal FAQ paragraphs.

- [ ] **Step 6: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run docs:build
```

Expected: PASS.

- [ ] **Step 7: Commit any smoke-test fixes**

If implementation changes were needed:

```bash
git add packages apps docs
git commit -m "Stabilize Feishu block-level sync smoke test"
```

If no implementation changes were needed, do not commit generated `/private/tmp` or `/Users/liyun/Downloads` files.

---

## Rollout Policy

1. Keep `--markdown-engine local` and `--markdown-engine official` available.
2. Default `auto` remains official-first for pull, but section write must pass block-level safety gates before using official import output.
3. For the first release, text-like block-level sync is the default for `--section`; complex blocks may fallback to bounded range replacement.
4. Whole-document sync behavior remains unchanged unless explicitly requested.
5. Do not remove replace-section fallback until live smoke tests cover text, headings, lists, code blocks, tables, callouts, and cross-reference links.

## Verification Matrix

| Requirement | Evidence |
| --- | --- |
| Official pull no longer creates local escaped Markdown pollution | `official-markdown-normalize.test.ts` and live readback grep |
| Local renderer refuses raw official escaped Markdown | `preflight.test.ts` |
| Local section is extracted before conversion | `markdown-section-extract.test.ts` and sync integration test |
| One paragraph edit uses `batch_update` | `block-update.test.ts`, `block-level-apply.test.ts`, `sync.test.ts` |
| One-line insert does not delete whole section | `block-level-plan.test.ts` and live Feishu history check |
| Dangerous section expansion is blocked or bounded | `block-level-plan.test.ts` |
| Docs explain API boundaries and workflow | `npm run docs:build` |
| Existing behavior remains stable | `npm test` and `npm run typecheck` |

## Open Risks

- Feishu block update support differs by block type. Start with text-like blocks only and fallback for tables/callouts/media.
- Official Markdown convert may still emit blocks that cannot be created directly. Keep `assertFeishuBlocksWritable` and create error enrichment.
- First sync without receipts has weaker matching. Use position plus content fingerprints, then record block mapping in receipts in a later enhancement.
- Feishu edit history is not fully machine-verifiable through current CLI. The live smoke test requires human visual confirmation for the history quality.
