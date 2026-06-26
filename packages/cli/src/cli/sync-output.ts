import type { AuthDoctorReport } from './env.js';
import type { SyncReceiptRunContext } from '../receipts/receipt.js';
import type { PublishTransformOptions } from '../markdown/publish-transform.js';
import type { SyncRunResult } from '../sync/run-sync.js';

export type SyncOutputContext = {
  appId: {
    present: boolean;
    preview?: string;
  };
  envFiles: AuthDoctorReport['envFiles'];
  feishuHost: string;
  activeTransforms: string[];
};

export function buildSyncOutputContext(input: {
  auth: AuthDoctorReport;
  publishTransform?: PublishTransformOptions;
}): SyncOutputContext {
  return {
    appId: input.auth.appId,
    envFiles: input.auth.envFiles,
    feishuHost: input.auth.feishuHost,
    activeTransforms: activeTransforms(input.publishTransform)
  };
}

export function syncReceiptRunContext(context: SyncOutputContext): SyncReceiptRunContext {
  return {
    appIdPreview: context.appId.preview,
    loadedEnvFiles: context.envFiles.filter((file) => file.loaded).map((file) => file.path),
    explicitEnvFile: context.envFiles.find((file) => file.explicit)?.path,
    feishuHost: context.feishuHost,
    activeTransforms: context.activeTransforms
  };
}

export function formatSyncResultPretty(result: SyncRunResult, context?: SyncOutputContext): string {
  const lines = [`${result.mode}: ${result.patchPlan.operation}`];
  if (context) {
    lines.push(`app id: ${formatAppId(context)}`);
    lines.push(`env files: ${formatEnvFiles(context.envFiles)}`);
    lines.push(`feishu host: ${context.feishuHost}`);
    lines.push(`active transforms: ${formatList(context.activeTransforms)}`);
  }
  lines.push(`source blocks: ${result.receipt.blockCounts.source}`);
  lines.push(`feishu blocks: ${result.receipt.blockCounts.feishuBefore} -> ${result.receipt.blockCounts.feishuAfter}`);
  lines.push(`desired hash: ${result.patchPlan.desiredHash}`);
  if (result.patchPlan.section) {
    const section = result.patchPlan.section;
    lines.push(`section: ${section.title}`);
    lines.push(`section range: remote ${section.remoteStartIndex}-${section.remoteEndIndex}, local ${section.localStartIndex}-${section.localEndIndex}`);
  }
  if (result.patchPlan.operation === 'replace-contiguous-blocks') {
    lines.push(`remote range: ${result.patchPlan.remoteStartIndex}..${result.patchPlan.remoteEndIndex}`);
    lines.push(`local range: ${result.patchPlan.localStartIndex}..${result.patchPlan.localEndIndex}`);
  }
  if (result.patchPlan.operation !== 'noop') {
    lines.push(`will delete: ${result.patchPlan.deleteCount}`);
    lines.push(`will create: ${result.patchPlan.createCount}`);
  }
  if (result.docxV2) {
    const verification = result.docxV2.verification;
    lines.push('write backend: docx-v2-overwrite');
    lines.push(`table readback: ${verification.tablesReadback}/${verification.tablesExpected}`);
    lines.push(`media readback: ${verification.mediaReadback}/${verification.mediaExpected}`);
  }
  if (result.mode === 'write' && result.receiptWritten) {
    lines.push(`receipt: ${result.receiptPath}`);
  }
  return lines.join('\n');
}

function activeTransforms(publishTransform: PublishTransformOptions | undefined): string[] {
  return publishTransform ? [`publish-profile:${publishTransform.profile}`] : [];
}

function formatAppId(context: SyncOutputContext): string {
  if (!context.appId.present) return 'missing';
  return context.appId.preview ?? 'present';
}

function formatEnvFiles(files: SyncOutputContext['envFiles']): string {
  if (files.length === 0) return 'none loaded';
  const formatted = files.map((file) => {
    const flags = [
      file.loaded ? 'loaded' : 'not loaded',
      file.explicit ? 'explicit' : ''
    ].filter(Boolean);
    return `${file.path} (${flags.join(', ')})`;
  });
  return formatted.join(', ');
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}
