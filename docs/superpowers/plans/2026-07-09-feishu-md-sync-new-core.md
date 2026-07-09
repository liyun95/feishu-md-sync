# Feishu Markdown Sync New Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first new-core vertical slice: `feishu-md-sync publish <file.md> --target <existing-doc> --profile zilliz`, with dry-run planning, guarded document replacement, Lark CLI adapter boundary, publish receipts, and live Feishu CI.

**Architecture:** Add a new core alongside legacy commands instead of rewriting old sync internals in place. The new core owns config, publish profiles, transforms, planning, receipts, and safety gates; Feishu/Lark operations go through a Lark CLI adapter interface. Existing legacy commands remain available but are not used by the new publish path.

**Tech Stack:** Node 20+, TypeScript ESM, Commander, Vitest, official `lark-cli` as runtime adapter, JSON config, GitHub Actions or equivalent CI for live Feishu checks.

---

## Confirmed Scope

This plan implements only the first vertical slice.

Included:
- Existing online document target only.
- `zilliz` publish profile.
- `none` and `milvus` profile parsing so CLI/config are stable, but no advanced Milvus-specific publish behavior beyond no product-name rewrite.
- Dry-run publish plan.
- Guarded `document-replace` write path.
- Publish receipt after successful write.
- Live Feishu CI job for the slice.
- `md2feishu` remains a compatibility binary alias, but docs and new examples use `feishu-md-sync`.

Not included:
- Drive folder target creation.
- Wiki node target creation.
- Fine-grained block patch or section replace writes.
- New bidirectional `sync` command.
- Automatic merge on pull.
- Full public docs rewrite.
- Moving all legacy commands under `legacy`.

Those should be separate follow-up plans after this slice lands.

## File Structure

Create new-core files:
- `packages/cli/src/config/sync-config.ts`: load `feishu-md-sync.config.json`, validate profiles, resolve default profile.
- `packages/cli/src/profiles/publish-profile.ts`: profile names and profile resolution.
- `packages/cli/src/transform/include-tags.ts`: include-tag parsing helpers used by publish and future pull transforms.
- `packages/cli/src/transform/zilliz-publish.ts`: Zilliz publish transform rules.
- `packages/cli/src/adapters/feishu-adapter.ts`: interface for remote document operations.
- `packages/cli/src/adapters/lark-cli-adapter.ts`: shell boundary for `lark-cli`.
- `packages/cli/src/receipts/publish-receipt.ts`: new-core receipt read/write and hashing.
- `packages/cli/src/publish/publish-plan.ts`: plan types and planner.
- `packages/cli/src/publish/run-publish.ts`: orchestration for dry-run and guarded write.
- `packages/cli/src/cli/commands/publish.ts`: Commander command registration.

Modify existing files:
- `packages/cli/src/cli/index.ts`: register new publish command and program name.
- `packages/cli/package.json`: prefer `feishu-md-sync` in examples while keeping `md2feishu` alias.
- `README.md`: minimal first-slice quickstart only.

Tests:
- `packages/cli/test/sync-config.test.ts`
- `packages/cli/test/zilliz-publish-transform.test.ts`
- `packages/cli/test/publish-receipt.test.ts`
- `packages/cli/test/publish-plan.test.ts`
- `packages/cli/test/publish-cli.test.ts`
- `packages/cli/test/lark-cli-adapter.test.ts`
- `packages/cli/test/live-feishu-publish.test.ts`

CI:
- `.github/workflows/live-feishu.yml` or the repo's existing CI workflow if one already exists.

---

### Task 1: Add Publish Profile and Config Loading

**Files:**
- Create: `packages/cli/src/profiles/publish-profile.ts`
- Create: `packages/cli/src/config/sync-config.ts`
- Test: `packages/cli/test/sync-config.test.ts`

- [ ] **Step 1: Write failing profile/config tests**

Create `packages/cli/test/sync-config.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadSyncConfig, resolvePublishProfile } from '../src/config/sync-config.js';

describe('sync config', () => {
  it('falls back to none when no config and no CLI profile exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));

    await expect(loadSyncConfig({ cwd: dir })).resolves.toEqual({
      defaultProfile: undefined,
      profiles: {}
    });
    expect(resolvePublishProfile({ cliProfile: undefined, config: { profiles: {} } })).toBe('none');
  });

  it('loads defaultProfile from feishu-md-sync.config.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      defaultProfile: 'zilliz',
      profiles: {
        zilliz: { includeTargets: ['zilliz'], excludeTargets: ['milvus'] }
      }
    }), 'utf8');

    const config = await loadSyncConfig({ cwd: dir });

    expect(config.defaultProfile).toBe('zilliz');
    expect(resolvePublishProfile({ cliProfile: undefined, config })).toBe('zilliz');
    expect(resolvePublishProfile({ cliProfile: 'milvus', config })).toBe('milvus');
  });

  it('rejects unknown profile names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-config-'));
    await writeFile(join(dir, 'feishu-md-sync.config.json'), JSON.stringify({
      defaultProfile: 'cloud'
    }), 'utf8');

    await expect(loadSyncConfig({ cwd: dir })).rejects.toThrow('Invalid defaultProfile cloud. Expected zilliz, milvus, or none.');
    expect(() => resolvePublishProfile({ cliProfile: 'cloud', config: { profiles: {} } })).toThrow('Invalid --profile cloud. Expected zilliz, milvus, or none.');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `packages/cli`:

```bash
npm test -- test/sync-config.test.ts
```

Expected: FAIL because `../src/config/sync-config.js` does not exist.

- [ ] **Step 3: Implement profile types**

Create `packages/cli/src/profiles/publish-profile.ts`:

```ts
export const PUBLISH_PROFILES = ['zilliz', 'milvus', 'none'] as const;

export type PublishProfileName = typeof PUBLISH_PROFILES[number];

export type PublishProfileConfig = {
  includeTargets?: string[];
  excludeTargets?: string[];
  productNameMarkup?: boolean;
};

export function isPublishProfileName(value: string): value is PublishProfileName {
  return (PUBLISH_PROFILES as readonly string[]).includes(value);
}

export function parsePublishProfileName(value: string, label: string): PublishProfileName {
  if (isPublishProfileName(value)) return value;
  throw new Error(`Invalid ${label} ${value}. Expected zilliz, milvus, or none.`);
}
```

- [ ] **Step 4: Implement JSON config loading**

Create `packages/cli/src/config/sync-config.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parsePublishProfileName,
  type PublishProfileConfig,
  type PublishProfileName
} from '../profiles/publish-profile.js';

export type SyncConfig = {
  defaultProfile?: PublishProfileName;
  profiles: Record<string, PublishProfileConfig>;
};

export type LoadSyncConfigInput = {
  cwd: string;
};

export function resolvePublishProfile(input: {
  cliProfile?: string;
  config: SyncConfig;
}): PublishProfileName {
  if (input.cliProfile) return parsePublishProfileName(input.cliProfile, '--profile');
  return input.config.defaultProfile ?? 'none';
}

export async function loadSyncConfig(input: LoadSyncConfigInput): Promise<SyncConfig> {
  const path = join(input.cwd, 'feishu-md-sync.config.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('feishu-md-sync.config.json must contain a JSON object.');
  }

  const defaultProfile = typeof parsed.defaultProfile === 'string'
    ? parsePublishProfileName(parsed.defaultProfile, 'defaultProfile')
    : undefined;

  return {
    defaultProfile,
    profiles: parseProfiles(parsed.profiles)
  };
}

function parseProfiles(value: unknown): Record<string, PublishProfileConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('profiles must be a JSON object.');

  const profiles: Record<string, PublishProfileConfig> = {};
  for (const [name, rawProfile] of Object.entries(value)) {
    parsePublishProfileName(name, `profile name`);
    if (!isRecord(rawProfile)) throw new Error(`profiles.${name} must be a JSON object.`);
    profiles[name] = {
      includeTargets: parseStringArray(rawProfile.includeTargets, `profiles.${name}.includeTargets`),
      excludeTargets: parseStringArray(rawProfile.excludeTargets, `profiles.${name}.excludeTargets`),
      productNameMarkup: typeof rawProfile.productNameMarkup === 'boolean' ? rawProfile.productNameMarkup : undefined
    };
  }
  return profiles;
}

function parseStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5: Run the config tests**

Run from `packages/cli`:

```bash
npm test -- test/sync-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/profiles/publish-profile.ts packages/cli/src/config/sync-config.ts packages/cli/test/sync-config.test.ts
git commit -m "Add Feishu Markdown Sync config loading"
```

---

### Task 2: Implement Zilliz Publish Transform

**Files:**
- Create: `packages/cli/src/transform/include-tags.ts`
- Create: `packages/cli/src/transform/zilliz-publish.ts`
- Test: `packages/cli/test/zilliz-publish-transform.test.ts`

- [ ] **Step 1: Write failing transform tests**

Create `packages/cli/test/zilliz-publish-transform.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyZillizPublishTransform } from '../src/transform/zilliz-publish.js';

describe('Zilliz publish transform', () => {
  it('wraps ordinary Milvus product names in dual-product include tags', () => {
    expect(applyZillizPublishTransform('Milvus supports JSON indexing.')).toEqual({
      markdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports JSON indexing.',
      warnings: []
    });
  });

  it('wraps version-qualified Milvus sentences as Milvus-only', () => {
    expect(applyZillizPublishTransform('This option is available in Milvus 3.0 and later. Use it for new workloads.')).toEqual({
      markdown: '<include target="milvus">This option is available in Milvus 3.0 and later.</include> Use it for new workloads.',
      warnings: []
    });
  });

  it('does not rewrite code, links, or existing include tags', () => {
    const source = [
      '`Milvus` stays code.',
      '[Milvus link](milvus.md) stays link.',
      '<include target="milvus">Milvus</include> stays tagged.',
      '',
      '```',
      'Milvus 3.0 in code',
      '```'
    ].join('\n');

    expect(applyZillizPublishTransform(source).markdown).toBe(source);
  });

  it('warns on headings instead of rewriting them', () => {
    expect(applyZillizPublishTransform('# Configure Milvus\\n\\nMilvus stores vectors.')).toEqual({
      markdown: '# Configure Milvus\n\n<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      warnings: ['Heading contains Milvus product wording and was not rewritten: # Configure Milvus']
    });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run from `packages/cli`:

```bash
npm test -- test/zilliz-publish-transform.test.ts
```

Expected: FAIL because the transform module does not exist.

- [ ] **Step 3: Add include-tag helper**

Create `packages/cli/src/transform/include-tags.ts`:

```ts
export function protectInlineSpans(line: string): {
  protectedLine: string;
  restore(value: string): string;
} {
  const spans: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000${spans.length}\u0000`;
    spans.push(value);
    return token;
  };

  const protectedLine = line
    .replace(/<include\b[\s\S]*?<\/include>/g, protect)
    .replace(/`[^`]*`/g, protect)
    .replace(/\[[^\]]+\]\([^)]+\)/g, protect);

  return {
    protectedLine,
    restore: (value: string) => value.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)] ?? '')
  };
}

export function milvusOnly(value: string): string {
  return `<include target="milvus">${value}</include>`;
}

export function dualProductName(): string {
  return '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include>';
}
```

- [ ] **Step 4: Implement Zilliz transform**

Create `packages/cli/src/transform/zilliz-publish.ts`:

```ts
import { dualProductName, milvusOnly, protectInlineSpans } from './include-tags.js';

export type PublishTransformResult = {
  markdown: string;
  warnings: string[];
};

const VERSIONED_MILVUS_PATTERN = /\bMilvus\s+v?\d+(?:\.\d+)*(?:\.x)?\b/;
const ORDINARY_MILVUS_PATTERN = /\bMilvus(?!\s+v?\d)(?![-\w])/g;

export function applyZillizPublishTransform(markdown: string): PublishTransformResult {
  const warnings: string[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inCodeFence = false;

  const transformed = lines.map((line) => {
    if (/^```/.test(line.trim())) {
      inCodeFence = !inCodeFence;
      return line;
    }
    if (inCodeFence) return line;
    if (/^#{1,6}\s+/.test(line)) {
      if (/\bMilvus\b/.test(line)) warnings.push(`Heading contains Milvus product wording and was not rewritten: ${line}`);
      return line;
    }
    return transformLine(line);
  }).join('\n');

  return { markdown: transformed, warnings };
}

function transformLine(line: string): string {
  if (line.trim() === '') return line;

  const { protectedLine, restore } = protectInlineSpans(line);
  const withVersionSentences = protectedLine
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => VERSIONED_MILVUS_PATTERN.test(sentence) ? milvusOnly(sentence) : sentence)
    .join(' ');

  const withProductNames = withVersionSentences.replace(ORDINARY_MILVUS_PATTERN, dualProductName());
  return restore(withProductNames);
}
```

- [ ] **Step 5: Run transform tests**

Run from `packages/cli`:

```bash
npm test -- test/zilliz-publish-transform.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/transform/include-tags.ts packages/cli/src/transform/zilliz-publish.ts packages/cli/test/zilliz-publish-transform.test.ts
git commit -m "Add Zilliz publish transform"
```

---

### Task 3: Add Lark CLI Adapter Boundary

**Files:**
- Create: `packages/cli/src/adapters/feishu-adapter.ts`
- Create: `packages/cli/src/adapters/lark-cli-adapter.ts`
- Test: `packages/cli/test/lark-cli-adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests with injected executor**

Create `packages/cli/test/lark-cli-adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LarkCliAdapter } from '../src/adapters/lark-cli-adapter.js';

describe('LarkCliAdapter', () => {
  it('fetches an existing doc as markdown through lark-cli docs +fetch', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return {
          stdout: JSON.stringify({ ok: true, data: { content: '# Remote\n' } }),
          stderr: ''
        };
      }
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'doc_token' })).resolves.toEqual({
      markdown: '# Remote\n',
      revision: undefined
    });
    expect(calls).toEqual([['docs', '+fetch', '--doc', 'doc_token', '--doc-format', 'markdown', '--format', 'json']]);
  });

  it('overwrites an existing doc through lark-cli docs +update', async () => {
    const calls: string[][] = [];
    const adapter = new LarkCliAdapter({
      exec: async (args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ ok: true, data: { document_id: 'doc_token' } }), stderr: '' };
      }
    });

    await adapter.replaceDocument({ doc: 'doc_token', markdown: '# Local\n' });

    expect(calls).toEqual([[
      'docs',
      '+update',
      '--doc',
      'doc_token',
      '--command',
      'overwrite',
      '--doc-format',
      'markdown',
      '--content',
      '# Local\n',
      '--format',
      'json'
    ]]);
  });

  it('throws a concise error when lark-cli returns an error envelope', async () => {
    const adapter = new LarkCliAdapter({
      exec: async () => ({
        stdout: '',
        stderr: JSON.stringify({ ok: false, error: { message: 'permission denied' } })
      })
    });

    await expect(adapter.fetchDocMarkdown({ doc: 'doc_token' })).rejects.toThrow('lark-cli failed: permission denied');
  });
});
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Run from `packages/cli`:

```bash
npm test -- test/lark-cli-adapter.test.ts
```

Expected: FAIL because adapter files do not exist.

- [ ] **Step 3: Define adapter interface**

Create `packages/cli/src/adapters/feishu-adapter.ts`:

```ts
export type RemoteMarkdown = {
  markdown: string;
  revision?: string;
};

export type FeishuAdapter = {
  fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown>;
  replaceDocument(input: { doc: string; markdown: string }): Promise<void>;
};
```

- [ ] **Step 4: Implement Lark CLI adapter with injectable executor**

Create `packages/cli/src/adapters/lark-cli-adapter.ts`:

```ts
import { execFile } from 'node:child_process';
import type { FeishuAdapter, RemoteMarkdown } from './feishu-adapter.js';

export type LarkCliExecResult = {
  stdout: string;
  stderr: string;
};

export type LarkCliExecutor = (args: string[]) => Promise<LarkCliExecResult>;

export class LarkCliAdapter implements FeishuAdapter {
  private readonly exec: LarkCliExecutor;

  constructor(input: { exec?: LarkCliExecutor } = {}) {
    this.exec = input.exec ?? runLarkCli;
  }

  async fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown> {
    const result = await this.exec(['docs', '+fetch', '--doc', input.doc, '--doc-format', 'markdown', '--format', 'json']);
    const data = parseLarkCliJson(result);
    const content = data.data && typeof data.data === 'object' && 'content' in data.data
      ? (data.data as { content?: unknown }).content
      : undefined;
    if (typeof content !== 'string') {
      throw new Error('lark-cli docs +fetch did not return data.content.');
    }
    const revision = data.data && typeof data.data === 'object' && typeof (data.data as { revision?: unknown }).revision === 'string'
      ? (data.data as { revision: string }).revision
      : undefined;
    return { markdown: content, revision };
  }

  async replaceDocument(input: { doc: string; markdown: string }): Promise<void> {
    parseLarkCliJson(await this.exec([
      'docs',
      '+update',
      '--doc',
      input.doc,
      '--command',
      'overwrite',
      '--doc-format',
      'markdown',
      '--content',
      input.markdown,
      '--format',
      'json'
    ]));
  }
}

function runLarkCli(args: string[]): Promise<LarkCliExecResult> {
  return new Promise((resolve, reject) => {
    execFile('lark-cli', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || (error as Error).message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseLarkCliJson(result: LarkCliExecResult): { ok?: boolean; data?: unknown; error?: { message?: string } } {
  const raw = result.stdout.trim() || result.stderr.trim();
  let parsed: { ok?: boolean; data?: unknown; error?: { message?: string } };
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; data?: unknown; error?: { message?: string } };
  } catch {
    throw new Error(`lark-cli returned non-JSON output: ${raw}`);
  }
  if (parsed.ok === false) {
    throw new Error(`lark-cli failed: ${parsed.error?.message ?? 'unknown error'}`);
  }
  return parsed;
}
```

- [ ] **Step 5: Run adapter tests**

Run from `packages/cli`:

```bash
npm test -- test/lark-cli-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/adapters/feishu-adapter.ts packages/cli/src/adapters/lark-cli-adapter.ts packages/cli/test/lark-cli-adapter.test.ts
git commit -m "Add Lark CLI adapter boundary"
```

---

### Task 4: Add Publish Receipt Store

**Files:**
- Create: `packages/cli/src/receipts/publish-receipt.ts`
- Test: `packages/cli/test/publish-receipt.test.ts`

- [ ] **Step 1: Write failing receipt tests**

Create `packages/cli/test/publish-receipt.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { hashText, publishReceiptPath, readPublishReceipt, writePublishReceipt } from '../src/receipts/publish-receipt.js';

describe('publish receipt', () => {
  it('hashes text deterministically', () => {
    expect(hashText('hello')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('world'));
  });

  it('writes and reads a publish receipt for a target doc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-'));
    const receipt = {
      version: 1 as const,
      target: { kind: 'docx' as const, token: 'doc_token' },
      profile: 'zilliz' as const,
      localSourceHash: 'source',
      publishDraftHash: 'draft',
      remoteSnapshotHash: 'remote',
      remoteRevision: 'rev1',
      updatedAt: '2026-07-09T00:00:00.000Z'
    };

    await writePublishReceipt({ cwd: dir, receipt });

    const path = publishReceiptPath({ cwd: dir, target: receipt.target });
    await expect(readFile(path, 'utf8')).resolves.toContain('"remoteSnapshotHash": "remote"');
    await expect(readPublishReceipt({ cwd: dir, target: receipt.target })).resolves.toEqual(receipt);
  });

  it('returns undefined when a receipt does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-receipt-'));

    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'missing' } })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the receipt test and verify it fails**

Run from `packages/cli`:

```bash
npm test -- test/publish-receipt.test.ts
```

Expected: FAIL because `publish-receipt.ts` does not exist.

- [ ] **Step 3: Implement publish receipt storage**

Create `packages/cli/src/receipts/publish-receipt.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PublishProfileName } from '../profiles/publish-profile.js';

export type PublishReceiptTarget = {
  kind: 'docx';
  token: string;
};

export type PublishReceipt = {
  version: 1;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  remoteRevision?: string;
  updatedAt: string;
};

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publishReceiptPath(input: { cwd: string; target: PublishReceiptTarget }): string {
  return join(input.cwd, '.sync', 'feishu-md-sync', `${input.target.kind}-${input.target.token}.json`);
}

export async function readPublishReceipt(input: {
  cwd: string;
  target: PublishReceiptTarget;
}): Promise<PublishReceipt | undefined> {
  const path = publishReceiptPath(input);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(raw) as PublishReceipt;
}

export async function writePublishReceipt(input: {
  cwd: string;
  receipt: PublishReceipt;
}): Promise<void> {
  const path = publishReceiptPath({ cwd: input.cwd, target: input.receipt.target });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(input.receipt, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: Run receipt tests**

Run from `packages/cli`:

```bash
npm test -- test/publish-receipt.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/receipts/publish-receipt.ts packages/cli/test/publish-receipt.test.ts
git commit -m "Add publish receipts"
```

---

### Task 5: Add Publish Planner

**Files:**
- Create: `packages/cli/src/publish/publish-plan.ts`
- Test: `packages/cli/test/publish-plan.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `packages/cli/test/publish-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPublishPlan } from '../src/publish/publish-plan.js';

describe('publish plan', () => {
  it('plans no-op when desired draft matches remote content', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vectors.',
      publishDraft: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      remoteMarkdown: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      receipt: undefined,
      transformWarnings: []
    });

    expect(plan.strategy).toBe('no-op');
    expect(plan.safeToWrite).toBe(true);
    expect(plan.remoteChanged).toBe(false);
  });

  it('recommends guarded document replace when desired draft differs', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'Milvus stores vectors.',
      publishDraft: '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.',
      remoteMarkdown: 'Old content.',
      receipt: undefined,
      transformWarnings: []
    });

    expect(plan.strategy).toBe('document-replace');
    expect(plan.safeToWrite).toBe(false);
    expect(plan.risks).toContain('untracked remote: no publish receipt exists for this target');
    expect(plan.risks).toContain('document replace can affect comments, anchors, block identity, and collaboration context');
  });

  it('detects remote changes relative to the previous receipt', () => {
    const plan = buildPublishPlan({
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      localSource: 'New Milvus text.',
      publishDraft: 'New draft.',
      remoteMarkdown: 'Remote teammate edit.',
      receipt: {
        version: 1,
        target: { kind: 'docx', token: 'doc_token' },
        profile: 'zilliz',
        localSourceHash: 'old-source',
        publishDraftHash: 'old-draft',
        remoteSnapshotHash: 'old-remote',
        updatedAt: '2026-07-09T00:00:00.000Z'
      },
      transformWarnings: ['Heading contains Milvus product wording and was not rewritten: # Milvus']
    });

    expect(plan.remoteChanged).toBe(true);
    expect(plan.warnings).toContain('Heading contains Milvus product wording and was not rewritten: # Milvus');
    expect(plan.risks).toContain('remote changed since last publish receipt');
  });
});
```

- [ ] **Step 2: Run planner tests and verify they fail**

Run from `packages/cli`:

```bash
npm test -- test/publish-plan.test.ts
```

Expected: FAIL because `publish-plan.ts` does not exist.

- [ ] **Step 3: Implement plan types and planner**

Create `packages/cli/src/publish/publish-plan.ts`:

```ts
import type { PublishProfileName } from '../profiles/publish-profile.js';
import { hashText, type PublishReceipt, type PublishReceiptTarget } from '../receipts/publish-receipt.js';

export type PublishStrategy = 'no-op' | 'block-patch' | 'section-replace' | 'document-replace';

export type PublishPlan = {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  strategy: PublishStrategy;
  safeToWrite: boolean;
  remoteChanged: boolean;
  localSourceHash: string;
  publishDraftHash: string;
  remoteSnapshotHash: string;
  risks: string[];
  warnings: string[];
};

export function buildPublishPlan(input: {
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  localSource: string;
  publishDraft: string;
  remoteMarkdown: string;
  receipt: PublishReceipt | undefined;
  transformWarnings: string[];
}): PublishPlan {
  const localSourceHash = hashText(input.localSource);
  const publishDraftHash = hashText(input.publishDraft);
  const remoteSnapshotHash = hashText(input.remoteMarkdown);
  const remoteChanged = input.receipt ? input.receipt.remoteSnapshotHash !== remoteSnapshotHash : false;
  const risks: string[] = [];

  if (!input.receipt) risks.push('untracked remote: no publish receipt exists for this target');
  if (remoteChanged) risks.push('remote changed since last publish receipt');

  const strategy: PublishStrategy = publishDraftHash === remoteSnapshotHash ? 'no-op' : 'document-replace';
  if (strategy === 'document-replace') {
    risks.push('document replace can affect comments, anchors, block identity, and collaboration context');
  }

  return {
    target: input.target,
    profile: input.profile,
    strategy,
    safeToWrite: strategy === 'no-op',
    remoteChanged,
    localSourceHash,
    publishDraftHash,
    remoteSnapshotHash,
    risks,
    warnings: input.transformWarnings
  };
}
```

- [ ] **Step 4: Run planner tests**

Run from `packages/cli`:

```bash
npm test -- test/publish-plan.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/publish/publish-plan.ts packages/cli/test/publish-plan.test.ts
git commit -m "Add new-core publish planner"
```

---

### Task 6: Add Publish Runner

**Files:**
- Create: `packages/cli/src/publish/run-publish.ts`
- Test: `packages/cli/test/run-publish.test.ts`

- [ ] **Step 1: Write failing runner tests**

Create `packages/cli/test/run-publish.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { FeishuAdapter } from '../src/adapters/feishu-adapter.js';
import { readPublishReceipt } from '../src/receipts/publish-receipt.js';
import { runPublish } from '../src/publish/run-publish.js';

describe('runPublish', () => {
  it('returns a dry-run plan without writing remotely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old remote.' }),
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: false,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    });

    expect(result.mode).toBe('dry-run');
    expect(result.plan.strategy).toBe('document-replace');
    expect(writes).toEqual([]);
  });

  it('refuses document replace without explicit destructive strategy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: 'Old remote.' }),
      replaceDocument: async () => {}
    };

    await expect(runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: true,
      strategy: 'auto',
      confirmDestructive: false,
      adapter
    })).rejects.toThrow('document-replace requires --strategy document-replace');
  });

  it('writes guarded document replace and records a receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fms-run-'));
    const markdownPath = join(dir, 'doc.md');
    await writeFile(markdownPath, 'Milvus stores vectors.', 'utf8');
    const writes: string[] = [];
    const adapter: FeishuAdapter = {
      fetchDocMarkdown: async () => ({ markdown: writes.at(-1) ?? 'Old remote.', revision: 'rev1' }),
      replaceDocument: async ({ markdown }) => { writes.push(markdown); }
    };

    const result = await runPublish({
      cwd: dir,
      file: markdownPath,
      target: { kind: 'docx', token: 'doc_token' },
      profile: 'zilliz',
      write: true,
      strategy: 'document-replace',
      confirmDestructive: true,
      adapter
    });

    expect(result.mode).toBe('write');
    expect(writes).toEqual(['<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.']);
    await expect(readPublishReceipt({ cwd: dir, target: { kind: 'docx', token: 'doc_token' } })).resolves.toMatchObject({
      profile: 'zilliz',
      target: { kind: 'docx', token: 'doc_token' }
    });
  });
});
```

- [ ] **Step 2: Run runner tests and verify they fail**

Run from `packages/cli`:

```bash
npm test -- test/run-publish.test.ts
```

Expected: FAIL because `run-publish.ts` does not exist.

- [ ] **Step 3: Implement publish runner**

Create `packages/cli/src/publish/run-publish.ts`:

```ts
import { readFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  readPublishReceipt,
  writePublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { applyZillizPublishTransform } from '../transform/zilliz-publish.js';
import { buildPublishPlan, type PublishPlan, type PublishStrategy } from './publish-plan.js';

export type RunPublishResult = {
  mode: 'dry-run' | 'write';
  plan: PublishPlan;
};

export async function runPublish(input: {
  cwd: string;
  file: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  write: boolean;
  strategy: 'auto' | PublishStrategy;
  confirmDestructive: boolean;
  adapter: FeishuAdapter;
}): Promise<RunPublishResult> {
  const localSource = await readFile(input.file, 'utf8');
  const transform = applyPublishTransformForProfile(localSource, input.profile);
  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
  const plan = buildPublishPlan({
    target: input.target,
    profile: input.profile,
    localSource,
    publishDraft: transform.markdown,
    remoteMarkdown: remote.markdown,
    receipt,
    transformWarnings: transform.warnings
  });

  if (!input.write || plan.strategy === 'no-op') return { mode: 'dry-run', plan };

  if (plan.strategy === 'document-replace') {
    if (input.strategy !== 'document-replace') {
      throw new Error('document-replace requires --strategy document-replace');
    }
    if (!input.confirmDestructive) {
      throw new Error('document-replace requires --confirm-destructive in non-interactive mode');
    }
    await input.adapter.replaceDocument({ doc: input.target.token, markdown: transform.markdown });
    const after = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
    await writePublishReceipt({
      cwd: input.cwd,
      receipt: {
        version: 1,
        target: input.target,
        profile: input.profile,
        localSourceHash: plan.localSourceHash,
        publishDraftHash: plan.publishDraftHash,
        remoteSnapshotHash: plan.remoteSnapshotHash === plan.publishDraftHash ? plan.remoteSnapshotHash : hashRemote(after.markdown),
        remoteRevision: after.revision,
        updatedAt: new Date().toISOString()
      }
    });
    return { mode: 'write', plan };
  }

  throw new Error(`Write strategy ${plan.strategy} is not implemented in the first slice.`);
}

function applyPublishTransformForProfile(markdown: string, profile: PublishProfileName): { markdown: string; warnings: string[] } {
  if (profile === 'zilliz') return applyZillizPublishTransform(markdown);
  return { markdown, warnings: [] };
}

function hashRemote(markdown: string): string {
  return (buildPublishPlan({
    target: { kind: 'docx', token: 'hash-only' },
    profile: 'none',
    localSource: markdown,
    publishDraft: markdown,
    remoteMarkdown: markdown,
    receipt: undefined,
    transformWarnings: []
  })).remoteSnapshotHash;
}
```

- [ ] **Step 4: Replace the temporary hash helper with direct `hashText` import**

Modify `packages/cli/src/publish/run-publish.ts`:

```ts
import {
  hashText,
  readPublishReceipt,
  writePublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
```

Replace:

```ts
remoteSnapshotHash: plan.remoteSnapshotHash === plan.publishDraftHash ? plan.remoteSnapshotHash : hashRemote(after.markdown),
```

with:

```ts
remoteSnapshotHash: hashText(after.markdown),
```

Delete the `hashRemote` function from the bottom of the file.

- [ ] **Step 5: Run runner tests**

Run from `packages/cli`:

```bash
npm test -- test/run-publish.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/publish/run-publish.ts packages/cli/test/run-publish.test.ts
git commit -m "Add guarded publish runner"
```

---

### Task 7: Add `feishu-md-sync publish` CLI Command

**Files:**
- Create: `packages/cli/src/cli/commands/publish.ts`
- Modify: `packages/cli/src/cli/index.ts`
- Modify: `packages/cli/package.json`
- Test: `packages/cli/test/publish-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `packages/cli/test/publish-cli.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type CliResult = {
  stdout: string;
  stderr: string;
  status: number | null;
};

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, APP_ID: '', APP_SECRET: '' }
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}

describe('publish CLI', () => {
  it('shows publish in top-level help under the new command name', async () => {
    const result = await runCli(['--help']);

    expect(result.stdout).toContain('Usage: feishu-md-sync');
    expect(result.stdout).toContain('publish');
  });

  it('rejects document replace writes without confirm-destructive before calling lark-cli', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'zilliz',
      '--write',
      '--strategy',
      'document-replace'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--confirm-destructive is required with --strategy document-replace --write');
  });

  it('rejects unknown profile names', async () => {
    const result = await runCli([
      'publish',
      'missing.md',
      '--target',
      'doccn123456789012345678901234',
      '--profile',
      'cloud'
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid --profile cloud. Expected zilliz, milvus, or none.');
  });
});
```

- [ ] **Step 2: Run CLI tests and verify they fail**

Run from `packages/cli`:

```bash
npm test -- test/publish-cli.test.ts
```

Expected: FAIL because top-level help still uses `md2feishu` and no `publish` command exists.

- [ ] **Step 3: Add publish command registration**

Create `packages/cli/src/cli/commands/publish.ts`:

```ts
import path from 'node:path';
import type { Command } from 'commander';
import { LarkCliAdapter } from '../../adapters/lark-cli-adapter.js';
import { parseFeishuTarget } from '../../core/doc-id.js';
import { loadSyncConfig, resolvePublishProfile } from '../../config/sync-config.js';
import { runPublish } from '../../publish/run-publish.js';
import { printFormatted } from '../output.js';

type PublishCommandOptions = {
  target?: string;
  profile?: string;
  write?: boolean;
  strategy?: string;
  confirmDestructive?: boolean;
  format?: string;
};

export function registerPublishCommand(program: Command): void {
  program
    .command('publish')
    .description('publish local Markdown to an existing Feishu/Lark online document')
    .argument('<markdown-file>', 'local Markdown file')
    .requiredOption('--target <url-or-token>', 'existing Feishu/Lark docx URL or token')
    .option('--profile <profile>', 'publish profile: zilliz | milvus | none')
    .option('--write', 'write to Feishu/Lark; omitted means dry-run')
    .option('--strategy <strategy>', 'write strategy: auto | document-replace', 'auto')
    .option('--confirm-destructive', 'confirm destructive document replacement in non-interactive mode')
    .option('--format <format>', 'output format: pretty | json', 'pretty')
    .action(async (markdownFile: string, opts: PublishCommandOptions) => {
      if (opts.write && opts.strategy === 'document-replace' && !opts.confirmDestructive) {
        throw new Error('--confirm-destructive is required with --strategy document-replace --write');
      }

      const target = parseFeishuTarget(opts.target ?? '');
      if (target.kind !== 'docx') {
        throw new Error('First-slice publish only supports existing docx targets.');
      }

      const cwd = process.cwd();
      const config = await loadSyncConfig({ cwd });
      const profile = resolvePublishProfile({ cliProfile: opts.profile, config });
      const result = await runPublish({
        cwd,
        file: path.resolve(cwd, markdownFile),
        target,
        profile,
        write: opts.write === true,
        strategy: opts.strategy === 'document-replace' ? 'document-replace' : 'auto',
        confirmDestructive: opts.confirmDestructive === true,
        adapter: new LarkCliAdapter()
      });

      printFormatted(result, opts.format);
    });
}
```

- [ ] **Step 4: Register command and rename program**

Modify `packages/cli/src/cli/index.ts`:

```ts
import { registerPublishCommand } from './commands/publish.js';
```

Change:

```ts
program
  .name('md2feishu')
```

to:

```ts
program
  .name('feishu-md-sync')
```

After `registerSyncCommands(program, cliContext);`, add:

```ts
registerPublishCommand(program);
```

- [ ] **Step 5: Ensure package keeps both binaries**

Modify `packages/cli/package.json` so `bin` remains:

```json
"bin": {
  "feishu-md-sync": "./dist/cli/index.js",
  "md2feishu": "./dist/cli/index.js"
}
```

- [ ] **Step 6: Run CLI tests**

Run from `packages/cli`:

```bash
npm test -- test/publish-cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run existing help-surface test and update expected command name if needed**

Run from `packages/cli`:

```bash
npm test -- test/cli-help-surface.test.ts
```

Expected: PASS after adding `publish` to the top-level expected command list if the test asserts the full command set.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cli/commands/publish.ts packages/cli/src/cli/index.ts packages/cli/package.json packages/cli/test/publish-cli.test.ts packages/cli/test/cli-help-surface.test.ts
git commit -m "Add new-core publish command"
```

---

### Task 8: Add Live Feishu CI Smoke Test

**Files:**
- Create: `packages/cli/test/live-feishu-publish.test.ts`
- Create or modify: `.github/workflows/live-feishu.yml`
- Modify: `package.json`

- [ ] **Step 1: Write opt-in live test**

Create `packages/cli/test/live-feishu-publish.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const runLive = process.env.FEISHU_MD_SYNC_LIVE === '1';

describe.skipIf(!runLive)('live Feishu publish', () => {
  it('publishes a Zilliz draft to an existing test doc with guarded document replace', async () => {
    const target = requiredEnv('FEISHU_MD_SYNC_TEST_DOC');
    const dir = await mkdtemp(join(tmpdir(), 'fms-live-'));
    const file = join(dir, 'doc.md');
    await writeFile(file, 'Milvus stores vectors.', 'utf8');

    const dryRun = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--format',
      'json'
    ], dir);

    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('"strategy": "document-replace"');

    const write = await runCli([
      'publish',
      file,
      '--target',
      target,
      '--profile',
      'zilliz',
      '--write',
      '--strategy',
      'document-replace',
      '--confirm-destructive',
      '--format',
      'json'
    ], dir);

    expect(write.status).toBe(0);
    expect(write.stdout).toContain('"mode": "write"');
  });
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for live Feishu tests.`);
  return value;
}

function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', new URL('../src/cli/index.ts', import.meta.url).pathname, ...args], {
      cwd,
      env: process.env
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        status: error ? typeof error.code === 'number' ? error.code : 1 : 0
      });
    });
  });
}
```

- [ ] **Step 2: Add npm script for live tests**

Modify root `package.json`:

```json
"test:live:feishu": "npm run test:live:feishu --workspace=feishu-md-sync"
```

Modify `packages/cli/package.json`:

```json
"test:live:feishu": "vitest run test/live-feishu-publish.test.ts"
```

- [ ] **Step 3: Run live test locally without env and verify it skips**

Run from repo root:

```bash
npm run test:live:feishu
```

Expected: PASS with the live suite skipped because `FEISHU_MD_SYNC_LIVE` is not `1`.

- [ ] **Step 4: Add live CI workflow**

Create `.github/workflows/live-feishu.yml`:

```yaml
name: live-feishu

on:
  pull_request:
  push:
    branches: [main]

jobs:
  live-feishu:
    runs-on: ubuntu-latest
    env:
      FEISHU_MD_SYNC_LIVE: "1"
      FEISHU_MD_SYNC_TEST_DOC: ${{ secrets.FEISHU_MD_SYNC_TEST_DOC }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx @larksuite/cli@latest install
      - run: lark-cli auth status
      - run: npm run test:live:feishu
```

- [ ] **Step 5: Document required CI secrets in the plan PR description**

Add this exact note to the PR description:

```md
Live Feishu CI requires:
- `FEISHU_MD_SYNC_TEST_DOC`: isolated test docx URL or token.

The CI runner must have `lark-cli` authentication available before `npm run test:live:feishu` runs. If the hosted runner cannot persist interactive auth, replace `lark-cli auth status` with the repository-approved non-interactive auth bootstrap.
```

- [ ] **Step 6: Commit**

```bash
git add package.json packages/cli/package.json packages/cli/test/live-feishu-publish.test.ts .github/workflows/live-feishu.yml
git commit -m "Add live Feishu publish CI smoke test"
```

---

### Task 9: Update First-Slice README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README opening with new product identity**

Modify the top of `README.md`:

```md
# Feishu Markdown Sync

Feishu Markdown Sync is a sync bridge between local Markdown and Feishu/Lark online documents. The new core focuses on product documentation publishing: local Markdown is transformed into a Feishu/Lark publish draft, planned as a dry run, and written only when explicit safety gates are satisfied.

The first new-core slice supports publishing local Markdown to an existing Feishu/Lark online document with the `zilliz` profile. Historical workflow automation remains in the repository during migration, but the primary product surface is `feishu-md-sync publish`.
```

- [ ] **Step 2: Add first-slice quickstart**

Add this section near the top of `README.md`:

```md
## Quickstart

Install dependencies and build the CLI:

```bash
npm install
npm run build
```

Install and authenticate the official Lark CLI:

```bash
npx @larksuite/cli@latest install
lark-cli auth status
```

Preview a publish plan:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --profile zilliz
```

Execute guarded whole-document replacement only when you intentionally accept the risk:

```bash
feishu-md-sync publish ./doc.md --target <docx-url-or-token> --profile zilliz --write --strategy document-replace --confirm-destructive
```
```

- [ ] **Step 3: Add safety model summary**

Add this section after Quickstart:

```md
## Safety Model

Commands are dry-run by default. `--write` allows remote writes, but it does not allow destructive strategies by itself.

Existing-document whole replacement requires all of these gates:

- `--write`
- `--strategy document-replace`
- `--confirm-destructive`

This protects comments, anchors, block identity, and teammate edits from accidental replacement. Fine-grained block and section writes are planned follow-up work for the new core.
```

- [ ] **Step 4: Run docs-free verification**

Run from repo root:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document new publish slice"
```

---

### Task 10: Final Verification

**Files:**
- No new files unless fixes are required.

- [ ] **Step 1: Run focused test suite**

Run from repo root:

```bash
npm test --workspace=feishu-md-sync -- test/sync-config.test.ts test/zilliz-publish-transform.test.ts test/lark-cli-adapter.test.ts test/publish-receipt.test.ts test/publish-plan.test.ts test/run-publish.test.ts test/publish-cli.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full unit suite**

Run from repo root:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run from repo root:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run from repo root:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Run live Feishu suite in the configured CI environment**

Run from repo root with live env configured:

```bash
npm run test:live:feishu
```

Expected: PASS against isolated Feishu/Lark test resources.

- [ ] **Step 6: Review legacy boundary**

Run from repo root:

```bash
git diff -- README.md packages/cli/src/cli/index.ts packages/cli/src/cli/commands
```

Expected:
- New `publish` command is registered.
- Existing legacy commands still compile.
- README centers `feishu-md-sync publish`.
- No old workflow documentation is expanded in the README.

- [ ] **Step 7: Commit any final fixes**

```bash
git add README.md packages/cli/src packages/cli/test package.json packages/cli/package.json .github/workflows/live-feishu.yml
git commit -m "Complete first publish slice"
```

Skip this commit if there are no changes after Tasks 1-9.

---

## Follow-Up Plans

Write separate plans for these after the first slice lands:

1. Move legacy commands under `feishu-md-sync legacy ...` and remove legacy workflow docs from the public docs site.
2. Add Drive folder and Wiki node publish targets.
3. Add pull command with profile-specific local views.
4. Enable block patch writes after Lark CLI adapter contract and live tests prove stable block identity behavior.
5. Enable section replace writes after heading and section matching are stable across live Feishu documents.
6. Rewrite VitePress docs around the new core only.

---

## Self-Review

Spec coverage:
- Product identity and command naming are covered in Tasks 7 and 9.
- Lark CLI default adapter is covered in Task 3.
- Zilliz publish transform and include-tag behavior are covered in Task 2.
- Publish receipt is covered in Task 4.
- Dry-run planning and destructive guardrail are covered in Tasks 5 and 6.
- CLI integration is covered in Task 7.
- Live Feishu CI is covered in Task 8.
- First-slice documentation is covered in Task 9.

Placeholder scan:
- No task uses TBD, TODO, "similar to", or unspecified "add tests" language.
- Follow-up items are explicitly out of scope and do not block the first slice.

Type consistency:
- `PublishProfileName`, `PublishReceiptTarget`, `PublishPlan`, `FeishuAdapter`, and `RunPublishResult` names are introduced before use.
- The first-slice target type is consistently `docx`.
- The destructive strategy spelling is consistently `document-replace`.
