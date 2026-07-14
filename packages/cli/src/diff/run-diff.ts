import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { PublishProfileName } from '../profiles/publish-profile.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';
import { unifiedDiff } from '../core/diff.js';
import {
  loadPublishStatusContext,
  statusFromContext,
  statusWithWhiteboards,
  type PublishStatusResult
} from '../status/run-status.js';
import { analyzeExistingPublish } from '../publish/run-publish.js';
import type { ScopedPatchBlocker } from '../publish/scoped-patch-plan.js';
import type { TableRowAddition, TableRowUpdate } from '../publish/table-diff.js';
import type { SemanticLocator } from '../semantic/types.js';
import type { WhiteboardAssetPlan, WhiteboardPlanBlocker } from '../whiteboards/whiteboard-plan.js';
import type { CalloutConfig } from '../config/sync-config.js';
import {
  calloutBlockTypeLabel,
  summarizeCalloutChanges,
  type CalloutChangeSummary
} from '../callouts/callout-summary.js';

export type RunDiffResult = {
  mode: 'read-only';
  target: PublishReceiptTarget;
  sourcePath: string;
  profile: PublishProfileName;
  left: 'remote-current';
  right: 'publish-draft';
  hasDiff: boolean;
  diff: string;
  scoped: {
    text: Array<{ kind: 'update' | 'create' | 'delete'; locator: SemanticLocator; desiredMarkdown?: string }>;
    callouts: CalloutChangeSummary[];
    tables: Array<{
      locator: SemanticLocator;
      additions: TableRowAddition[];
      updates: TableRowUpdate[];
    }>;
    whiteboards: WhiteboardAssetPlan[];
    blockers: Array<ScopedPatchBlocker | WhiteboardPlanBlocker>;
    warnings: string[];
  };
  status: PublishStatusResult;
};

export async function runDiff(input: {
  cwd: string;
  sourcePath: string;
  target: PublishReceiptTarget;
  profile: PublishProfileName;
  syncWhiteboards?: boolean;
  callouts?: CalloutConfig;
  adapter: FeishuAdapter;
}): Promise<RunDiffResult> {
  const context = await loadPublishStatusContext(input);
  let status = statusFromContext(context);
  let scoped: RunDiffResult['scoped'] = { text: [], callouts: [], tables: [], whiteboards: [], blockers: [], warnings: [] };
  if (input.syncWhiteboards ||
    context.localSource.includes('<table') ||
    /<div\s+class=["'][^"']*\balert\b[^"']*\b(?:note|warning)\b/i.test(context.localSource) ||
    context.receipt?.version === 2 ||
    context.receipt?.version === 3) {
    try {
      const analysis = await analyzeExistingPublish({
        cwd: input.cwd,
        file: input.sourcePath,
        target: input.target,
        profile: input.profile,
        strategy: 'auto',
        adapter: input.adapter,
        localSource: context.localSource,
        syncWhiteboards: input.syncWhiteboards,
        callouts: input.callouts
      });
      const patch = analysis.plan.scopedPatch;
      const whiteboardPlan = analysis.plan.whiteboards;
      const whiteboards = whiteboardPlan?.assets ?? [];
      status = {
        ...statusWithWhiteboards(status, whiteboards),
        whiteboardBlockers: whiteboardPlan?.blockers ?? []
      };
      if (patch) status = { ...status, scopeSummary: patch.scopeSummary };
      scoped = {
        text: (patch?.operations ?? []).flatMap((operation) => {
          if (operation.kind !== 'update' && operation.kind !== 'create' && operation.kind !== 'delete') return [];
          return [{
            kind: operation.kind,
            locator: operation.locator,
            ...('desiredMarkdown' in operation ? { desiredMarkdown: operation.desiredMarkdown } : {})
          }];
        }),
        callouts: summarizeCalloutChanges({
          operations: patch?.operations ?? [],
          local: analysis.localCurrent,
          remote: analysis.remoteCurrent
        }),
        tables: (patch?.operations ?? []).flatMap((operation) => operation.kind === 'table-replace' ? [{
          locator: operation.locator,
          additions: operation.diff.additions,
          updates: operation.diff.updates
        }] : []),
        whiteboards,
        blockers: [...(patch?.blockers ?? []), ...(whiteboardPlan?.blockers ?? [])],
        warnings: [...(patch?.warnings ?? []), ...(whiteboardPlan?.warnings ?? [])]
      };
    } catch (error) {
      if (input.syncWhiteboards) throw error;
      // Preserve the raw Markdown diff when scope-aware analysis is unavailable.
    }
  }
  const hasScopedDiff = scoped.text.length > 0 || scoped.callouts.length > 0 || scoped.tables.length > 0 || scoped.whiteboards.some((asset) => asset.state !== 'clean') || scoped.blockers.length > 0;
  const hasDiff = context.remoteCanonical !== context.publishDraftCanonical || hasScopedDiff;
  return {
    mode: 'read-only',
    target: input.target,
    sourcePath: input.sourcePath,
    profile: input.profile,
    left: 'remote-current',
    right: 'publish-draft',
    hasDiff,
    diff: hasDiff ? unifiedDiff('remote-current', 'publish-draft', context.remoteCanonical, context.publishDraftCanonical) : '',
    scoped,
    status
  };
}

export function diffSummaryLines(result: RunDiffResult): string[] {
  const lines = [
    `state: ${result.status.state}`,
    `local changed: ${result.status.localChanged}`,
    `remote changed: ${result.status.remoteChanged}`,
    `content matches remote: ${result.status.contentMatchesRemote}`,
    `recommendation: ${result.status.recommendation.action} - ${result.status.recommendation.reason}`,
    ''
  ];

  if (!result.hasDiff) {
    lines.push('no diff');
    return lines;
  }

  for (const callout of result.scoped.callouts) {
    const label = `${callout.locator.sectionPath.join(' > ') || '<root>'} [${callout.locator.ordinal}]`;
    lines.push(`callout[${callout.type}]: ${label}`);
    for (const child of callout.childChanges) {
      const marker = child.action === 'create' ? '+' : child.action === 'delete' ? '-' : '~';
      lines.push(`  ${marker} ${calloutBlockTypeLabel(child.blockType)} ${child.ordinal + 1}`);
    }
  }

  for (const table of result.scoped.tables) {
    const label = `${table.locator.sectionPath.join(' > ') || '<root>'} [${table.locator.ordinal}]`;
    lines.push(`table: ${label}`);
    for (const addition of table.additions) lines.push(`  + row ${addition.key}`);
    for (const update of table.updates) {
      lines.push(`  ~ row ${update.key}: columns ${update.changedCellIndexes.map((index) => index + 1).join(', ')}`);
    }
  }
  for (const whiteboard of result.scoped.whiteboards) {
    lines.push(`whiteboard[${whiteboard.state}]: ${whiteboard.assetKey} - ${whiteboard.action}`);
  }
  for (const blocker of result.scoped.blockers) lines.push(`blocker[${blocker.code}]: ${blocker.message}`);
  for (const warning of result.scoped.warnings) lines.push(`warning: ${warning}`);
  if (result.scoped.callouts.length > 0 || result.scoped.tables.length > 0 || result.scoped.whiteboards.length > 0 || result.scoped.blockers.length > 0 || result.scoped.warnings.length > 0) lines.push('');

  lines.push(result.diff.trimEnd());
  return lines;
}
