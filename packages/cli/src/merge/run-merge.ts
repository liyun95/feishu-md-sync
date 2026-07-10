import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
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
  const merge = base.markdown === undefined
    ? mergeWithoutBase({ local, remote: remote.markdown })
    : mergeLines({ base: base.markdown, local, remote: remote.markdown });

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
  adapter: FeishuAdapter;
}): Promise<{
  markdown: string;
  warnings: string[];
  summary: NonNullable<RunMergeResult['remote']>;
}> {
  if (input.remotePath) {
    const raw = await readFile(input.remotePath, 'utf8');
    const transformed = applyPullTransformForProfile(raw, input.profile);
    return {
      markdown: transformed.markdown,
      warnings: transformed.warnings,
      summary: {
        source: 'remote-file',
        hash: hashText(transformed.markdown)
      }
    };
  }

  const fetched = await input.adapter.fetchDocMarkdown({ doc: input.target!.token });
  const transformed = applyPullTransformForProfile(fetched.markdown, input.profile);
  if (input.saveRemotePath) {
    await mkdir(dirname(input.saveRemotePath), { recursive: true });
    await writeFile(input.saveRemotePath, transformed.markdown, 'utf8');
  }
  return {
    markdown: transformed.markdown,
    warnings: transformed.warnings,
    summary: {
      source: 'target',
      hash: hashText(transformed.markdown),
      savedPath: input.saveRemotePath,
      revision: fetched.revision
    }
  };
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
