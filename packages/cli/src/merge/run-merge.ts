import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import {
  canonicalizeFencedCodeLanguages,
  rewriteFencedCodeLanguages
} from '../code-blocks/code-markdown.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  hashText,
  readLocalBaseSnapshot,
  readPublishReceipt,
  type PublishReceiptTarget
} from '../receipts/publish-receipt.js';
import { applyPullTransformForProfile } from '../transform/zilliz-pull.js';
import { mergeLines, mergeWithoutBase, type MergeState } from './line-merge.js';
import { assertNoMergeState, restoreMergeState, writeMergeState } from './merge-state.js';
import { localSemanticDocument } from '../semantic/local-document.js';
import type { SemanticCodeBlock } from '../semantic/types.js';

export type RunMergeMode = 'write' | 'check' | 'dry-run' | 'abort';
export type RunMergeState = MergeState | 'aborted';

export type RunMergeResult = {
  mode: RunMergeMode;
  state: RunMergeState;
  file: string;
  profile: PublishProfileName;
  base?: {
    source: 'explicit' | 'receipt' | 'current-local' | 'none';
    hash?: string;
  };
  remote?: {
    source: 'target' | 'remote-file';
    hash: string;
    savedPath?: string;
    revision?: string;
  };
  summary: {
    conflicts: number;
    changed: boolean;
  };
  warnings: string[];
};

export async function runMerge(input: {
  cwd: string;
  filePath: string;
  profile: PublishProfileName;
  mode: RunMergeMode;
  target?: PublishReceiptTarget;
  remotePath?: string;
  basePath?: string;
  saveRemotePath?: string;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<RunMergeResult> {
  if (input.mode === 'abort') {
    await restoreMergeState({ cwd: input.cwd, filePath: input.filePath });
    return {
      mode: 'abort',
      state: 'aborted',
      file: input.filePath,
      profile: input.profile,
      summary: { conflicts: 0, changed: true },
      warnings: []
    };
  }

  if (!input.target && !input.remotePath) {
    throw new Error('merge requires either --target or --remote');
  }
  if (input.target && input.remotePath) {
    throw new Error('merge accepts only one of --target or --remote');
  }

  const local = await readFile(input.filePath, 'utf8');
  assertNoConflictMarkers(local);
  await assertNoMergeState({ cwd: input.cwd, filePath: input.filePath });

  const remote = await resolveRemoteMarkdown(input);
  const base = await resolveBaseMarkdown({ ...input, localMarkdown: local });
  const remoteForMerge = base.markdown === undefined
    ? remote.markdown
    : preserveLocalCodeAliases({
      base: base.markdown,
      local,
      remote: remote.markdown,
      config: input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG
    });
  const merge = base.markdown === undefined
    ? mergeWithoutBase({ local, remote: remoteForMerge })
    : mergeLines({ base: base.markdown, local, remote: remoteForMerge });

  if (input.mode === 'write' && merge.changed) {
    await writeMergeState({
      cwd: input.cwd,
      filePath: input.filePath,
      originalMarkdown: local,
      target: input.target,
      profile: input.profile
    });
    await writeFile(input.filePath, merge.markdown, 'utf8');
  }

  return {
    mode: input.mode,
    state: merge.state,
    file: input.filePath,
    profile: input.profile,
    base: base.summary,
    remote: remote.summary,
    summary: {
      conflicts: merge.conflicts,
      changed: merge.changed
    },
    warnings: [...base.warnings, ...remote.warnings]
  };
}

function assertNoConflictMarkers(markdown: string): void {
  if (/^<<<<<<< |^=======\s*$|^>>>>>>> /m.test(markdown)) {
    throw new Error('Refusing to merge because the local file contains unresolved conflict markers.');
  }
}

async function resolveRemoteMarkdown(input: {
  target?: PublishReceiptTarget;
  remotePath?: string;
  saveRemotePath?: string;
  profile: PublishProfileName;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<{
  markdown: string;
  warnings: string[];
  summary: NonNullable<RunMergeResult['remote']>;
}> {
  if (input.remotePath) {
    const raw = await readFile(input.remotePath, 'utf8');
    const normalized = canonicalizeRemoteCalloutMarkdown({
      markdown: raw,
      config: input.callouts ?? DEFAULT_CALLOUT_CONFIG
    });
    const codeCanonical = canonicalizeFencedCodeLanguages(
      normalized.markdown,
      input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG
    );
    const transformed = applyPullTransformForProfile(codeCanonical, input.profile);
    return {
      markdown: transformed.markdown,
      warnings: [...normalized.warnings, ...transformed.warnings],
      summary: {
        source: 'remote-file',
        hash: hashText(transformed.markdown)
      }
    };
  }

  const fetched = await input.adapter.fetchDocMarkdown({ doc: input.target!.token });
  const normalized = canonicalizeRemoteCalloutMarkdown({
    markdown: fetched.markdown,
    config: input.callouts ?? DEFAULT_CALLOUT_CONFIG
  });
  const codeCanonical = canonicalizeFencedCodeLanguages(
    normalized.markdown,
    input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG
  );
  const transformed = applyPullTransformForProfile(codeCanonical, input.profile);
  if (input.saveRemotePath) {
    await mkdir(dirname(input.saveRemotePath), { recursive: true });
    await writeFile(input.saveRemotePath, transformed.markdown, 'utf8');
  }
  return {
    markdown: transformed.markdown,
    warnings: [...normalized.warnings, ...transformed.warnings],
    summary: {
      source: 'target',
      hash: hashText(transformed.markdown),
      savedPath: input.saveRemotePath,
      revision: fetched.revision
    }
  };
}

function preserveLocalCodeAliases(input: {
  base: string;
  local: string;
  remote: string;
  config: CodeBlockConfig;
}): string {
  const baseCodes = codeNodes(localSemanticDocument(input.base, input.config));
  const localCodes = codeNodes(localSemanticDocument(input.local, input.config));
  const remoteCodes = codeNodes(localSemanticDocument(input.remote, input.config));
  const localMatches = matchCodeBlocks(baseCodes, localCodes);
  const remoteMatches = matchCodeBlocks(baseCodes, remoteCodes);
  const aliasByRemote = new Map<SemanticCodeBlock, string>();
  for (const base of baseCodes) {
    const local = localMatches.get(base);
    const remote = remoteMatches.get(base);
    if (local && remote &&
      base.resolvedLanguage === local.resolvedLanguage &&
      base.resolvedLanguage === remote.resolvedLanguage) {
      aliasByRemote.set(remote, local.sourceLanguage);
    }
  }
  return rewriteFencedCodeLanguages(input.remote, (match, index) => {
    const remote = remoteCodes[index];
    const alias = remote ? aliasByRemote.get(remote) : undefined;
    if (alias !== undefined) return alias;
    return match.resolvedLanguage;
  });
}

function codeNodes(document: ReturnType<typeof localSemanticDocument>): SemanticCodeBlock[] {
  return document.nodes.filter((node): node is SemanticCodeBlock => node.kind === 'code');
}

function matchCodeBlocks(
  baseline: SemanticCodeBlock[],
  current: SemanticCodeBlock[]
): Map<SemanticCodeBlock, SemanticCodeBlock> {
  const result = new Map<SemanticCodeBlock, SemanticCodeBlock>();
  const used = new Set<SemanticCodeBlock>();
  for (const base of baseline) {
    const available = current.filter((code) => !used.has(code));
    const fingerprintMatches = available.filter((code) => codeFingerprint(code) === codeFingerprint(base));
    const match = fingerprintMatches.length === 1
      ? fingerprintMatches[0]
      : available.find((code) => locatorKey(code.locator) === locatorKey(base.locator));
    if (match) {
      result.set(base, match);
      used.add(match);
    }
  }
  return result;
}

function codeFingerprint(code: SemanticCodeBlock): string {
  return `${code.resolvedLanguage}\u0000${code.content}`;
}

function locatorKey(locator: SemanticCodeBlock['locator']): string {
  return `${locator.kind}:${JSON.stringify(locator.sectionPath)}:${locator.ordinal}`;
}

async function resolveBaseMarkdown(input: {
  cwd: string;
  target?: PublishReceiptTarget;
  basePath?: string;
  localMarkdown: string;
}): Promise<{
  markdown?: string;
  summary: NonNullable<RunMergeResult['base']>;
  warnings: string[];
}> {
  if (input.basePath) {
    const markdown = await readFile(input.basePath, 'utf8');
    return {
      markdown,
      summary: {
        source: 'explicit',
        hash: hashText(markdown)
      },
      warnings: []
    };
  }

  if (input.target) {
    const receipt = await readPublishReceipt({ cwd: input.cwd, target: input.target });
    if (receipt?.localBaseSnapshot) {
      const markdown = await readLocalBaseSnapshot({ cwd: input.cwd, snapshot: receipt.localBaseSnapshot });
      if (markdown !== undefined) {
        return {
          markdown,
          summary: {
            source: 'receipt',
            hash: hashText(markdown)
          },
          warnings: []
        };
      }
    }
    if (receipt?.localSourceHash === hashText(input.localMarkdown)) {
      return {
        markdown: input.localMarkdown,
        summary: {
          source: 'current-local',
          hash: hashText(input.localMarkdown)
        },
        warnings: [
          'receipt has no readable local base snapshot; using current local file as merge base because it still matches the last published source'
        ]
      };
    }
  }

  return {
    markdown: undefined,
    summary: {
      source: 'none'
    },
    warnings: []
  };
}
