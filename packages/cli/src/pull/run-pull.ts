import { readFile, writeFile } from 'node:fs/promises';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import {
  DEFAULT_CODE_BLOCK_CONFIG,
  type CodeBlockConfig
} from '../code-blocks/code-language.js';
import { canonicalizeFencedCodeLanguages } from '../code-blocks/code-markdown.js';
import { canonicalizeRemoteCalloutMarkdown } from '../callouts/callout-markdown.js';
import { DEFAULT_CALLOUT_CONFIG, type CalloutConfig } from '../config/sync-config.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import {
  normalizeReceiptOutputPath,
  pullReceiptPath,
  writePullReceipt
} from '../receipts/pull-receipt.js';
import { hashText, type PublishReceiptTarget } from '../receipts/publish-receipt.js';
import { applyPullTransformForProfile } from '../transform/zilliz-pull.js';

export type RunPullResult = {
  mode: 'write';
  target: PublishReceiptTarget;
  outputPath: string;
  profile: PublishProfileName;
  remoteRevision?: string;
  remoteRawHash: string;
  outputHash: string;
  receiptPath?: string;
  warnings: string[];
};

export async function runPull(input: {
  cwd: string;
  target: PublishReceiptTarget;
  outputPath: string;
  profile: PublishProfileName;
  overwrite: boolean;
  writeReceipt: boolean;
  callouts?: CalloutConfig;
  codeBlocks?: CodeBlockConfig;
  adapter: FeishuAdapter;
}): Promise<RunPullResult> {
  await assertPullOutputWritable(input.outputPath, input.overwrite);

  const remote = await input.adapter.fetchDocMarkdown({ doc: input.target.token });
  const normalized = canonicalizeRemoteCalloutMarkdown({
    markdown: remote.markdown,
    config: input.callouts ?? DEFAULT_CALLOUT_CONFIG
  });
  const codeCanonical = canonicalizeFencedCodeLanguages(
    normalized.markdown,
    input.codeBlocks ?? DEFAULT_CODE_BLOCK_CONFIG
  );
  const transform = applyPullTransformForProfile(codeCanonical, input.profile);
  await writeFile(input.outputPath, transform.markdown, 'utf8');

  const written = await readFile(input.outputPath, 'utf8');
  const outputHash = hashText(transform.markdown);
  const writtenHash = hashText(written);
  if (writtenHash !== outputHash) {
    throw new Error(`pull local write verification failed: expected ${outputHash}, got ${writtenHash}`);
  }

  const remoteRawHash = hashText(remote.markdown);
  const result: RunPullResult = {
    mode: 'write',
    target: input.target,
    outputPath: input.outputPath,
    profile: input.profile,
    remoteRevision: remote.revision,
    remoteRawHash,
    outputHash,
    warnings: [...normalized.warnings, ...transform.warnings]
  };

  if (input.writeReceipt) {
    const receipt = {
      version: 1 as const,
      kind: 'pull-snapshot' as const,
      target: input.target,
      outputPath: normalizeReceiptOutputPath({ cwd: input.cwd, outputPath: input.outputPath }),
      profile: input.profile,
      remoteRevision: remote.revision,
      remoteRawHash,
      outputHash,
      pulledAt: new Date().toISOString()
    };
    await writePullReceipt({ cwd: input.cwd, receipt });
    result.receiptPath = pullReceiptPath({ cwd: input.cwd, outputPath: receipt.outputPath, target: input.target });
  }

  return result;
}

async function assertPullOutputWritable(outputPath: string, overwrite: boolean): Promise<void> {
  try {
    await readFile(outputPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  if (!overwrite) {
    throw new Error(
      `Refusing to overwrite existing output without --overwrite: ${outputPath}\n` +
      'Pull writes remote snapshots only; choose a new *.remote.md output or rerun with --overwrite after review.'
    );
  }
}
