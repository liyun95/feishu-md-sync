import { validationFailure } from '../core/cli-failure.js';

export type OutputFormat = 'pretty' | 'json';

export function parseOutputFormat(value: string): OutputFormat {
  if (value === 'pretty' || value === 'json') return value;
  throw validationFailure({ message: `Invalid --format ${value}. Expected pretty or json.` });
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printFormatted(value: unknown, format: string | undefined): void {
  if (format === 'json') {
    printJson(value);
    return;
  }
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  const pretty = prettyLines(value);
  if (pretty) {
    for (const line of pretty) console.log(line);
    return;
  }
  printJson(value);
}

export function setFailedExitCode(condition: boolean): void {
  if (condition) process.exitCode = 1;
}

function prettyLines(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const plan = asRecord(record.plan);
  if (plan) return publishPlanLines(record, plan);
  if (typeof record.confirmationFingerprint === 'string' && asRecord(record.sources)) {
    return baselineAdoptLines(record);
  }
  if (typeof record.state === 'string' && asRecord(record.recommendation)) {
    const recommendation = asRecord(record.recommendation)!;
    const lines = [
      `state: ${record.state}`,
      `dialect: ${String(record.dialect ?? 'gfm')}`,
      linkSummaryLine(record.linkResolution),
      `local changed: ${String(record.localChanged)}`,
      `remote changed: ${String(record.remoteChanged)}`,
      `recommendation: ${String(recommendation.action)} - ${String(recommendation.reason)}`
    ];
    const checkpoint = asRecord(record.partialWriteCheckpoint);
    if (checkpoint) {
      const completed = Array.isArray(checkpoint.completedOperations)
        ? checkpoint.completedOperations.length
        : 0;
      lines.push(
        `partial-write checkpoint: revision ${String(checkpoint.remoteRevision ?? '<unavailable>')}, ${completed} verified operations`
      );
    }
    for (const value of Array.isArray(record.whiteboards) ? record.whiteboards : []) {
      const whiteboard = asRecord(value);
      if (whiteboard) {
        lines.push(`whiteboard[${String(whiteboard.state)}]: ${String(whiteboard.assetKey)} - ${String(whiteboard.action)}`);
      }
    }
    appendCalloutSummaryLines(lines, record.callouts);
    appendCodeSummaryLines(lines, record.codeBlocks);
    appendZdocRoundTripLines(lines, record.zdocRoundTrip);
    for (const value of Array.isArray(record.calloutBlockers) ? record.calloutBlockers : []) {
      const blocker = asRecord(value);
      if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.message)}`);
    }
    for (const value of Array.isArray(record.codeBlockers) ? record.codeBlockers : []) {
      const blocker = asRecord(value);
      if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.message)}`);
    }
    for (const value of Array.isArray(record.whiteboardBlockers) ? record.whiteboardBlockers : []) {
      const blocker = asRecord(value);
      if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.assetKey)} - ${String(blocker.message)}`);
    }
    appendDialectDiagnostics(lines, record.dialectBlockers, 'blocker');
    appendDialectDiagnostics(lines, record.dialectWarnings, 'warning');
    return lines;
  }
  return undefined;
}

function baselineAdoptLines(record: Record<string, unknown>): string[] {
  const sources = asRecord(record.sources)!;
  const localBaseline = asRecord(sources.localBaseline);
  const localCurrent = asRecord(sources.localCurrent);
  const remote = asRecord(sources.remote);
  const divergence = asRecord(record.existingDivergence);
  const delta = asRecord(record.delta);
  const operations = Array.isArray(delta?.operations) ? delta.operations : [];
  const blockers = Array.isArray(record.blockers) ? record.blockers : [];
  const lines = [
    `mode: ${String(record.mode)}`,
    `safe to adopt: ${String(record.safeToAdopt)}`,
    `L0: ${String(localBaseline?.kind)} ${String(localBaseline?.ref ?? localBaseline?.path ?? '')}`.trim(),
    `L0 source hash: ${String(localBaseline?.sourceHash)}`,
    `L0 publish hash: ${String(localBaseline?.publishDraftHash)}`,
    `L1: ${String(localCurrent?.path)}`,
    `L1 source hash: ${String(localCurrent?.sourceHash)}`,
    `L1 publish hash: ${String(localCurrent?.publishDraftHash)}`,
    `R0 document: ${String(remote?.documentId)}`,
    `R0 revision: ${String(remote?.revision ?? '<unavailable>')}`,
    `R0 markdown hash: ${String(remote?.markdownHash)}`,
    `R0 semantic hash: ${String(remote?.semanticHash)}`,
    `existing divergence: ${String(divergence?.changed ?? 0)} changed, ${String(divergence?.localOnly ?? 0)} local-only, ${String(divergence?.remoteOnly ?? 0)} remote-only`,
    `prospective L0 -> L1 operations: ${operations.length}`
  ];
  for (const value of operations) {
    const operation = asRecord(value);
    if (operation) lines.push(`delta[${String(operation.kind)}]: ${locatorLabel(asRecord(operation.locator))}`);
  }
  for (const value of blockers) {
    const blocker = asRecord(value);
    if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.message)}`);
  }
  lines.push(`confirmation fingerprint: ${String(record.confirmationFingerprint)}`);
  if (record.receiptWritten === true) lines.push(`receipt: ${String(record.receiptPath)}`);
  return lines;
}

function publishPlanLines(result: Record<string, unknown>, plan: Record<string, unknown>): string[] {
  const lines = [
    `mode: ${String(result.mode)}`,
    `strategy: ${String(plan.strategy)}`,
    `dialect: ${String(plan.dialect ?? 'gfm')}`,
    linkSummaryLine(plan.linkResolution)
  ];
  appendDialectDiagnostics(lines, plan.dialectBlockers, 'blocker');
  appendDialectDiagnostics(lines, plan.dialectWarnings, 'warning');
  appendZdocRoundTripLines(lines, plan.zdocRoundTrip);
  const scoped = asRecord(plan.scopedPatch);
  const operations = Array.isArray(scoped?.operations) ? scoped.operations : [];
  for (const value of operations) {
    const operation = asRecord(value);
    if (!operation) continue;
    const locator = asRecord(operation.locator);
    const label = locatorLabel(locator);
    if (String(operation.kind).startsWith('callout-')) {
      lines.push(`${String(operation.kind)}: ${label}`);
      continue;
    }
    if (String(operation.kind).startsWith('code-')) {
      const desired = asRecord(operation.desiredCode);
      lines.push(`code[${String(desired?.resolvedLanguage ?? 'plaintext')}]: ${label} (${String(operation.kind)})`);
      continue;
    }
    if (operation.kind === 'table-replace') {
      lines.push(`table: ${label}`);
      const diff = asRecord(operation.diff);
      if (diff?.headerChanged === true) lines.push('  ~ headers');
      for (const additionValue of Array.isArray(diff?.additions) ? diff.additions : []) {
        const addition = asRecord(additionValue);
        if (addition) lines.push(`  + row ${String(addition.key)}`);
      }
      for (const updateValue of Array.isArray(diff?.updates) ? diff.updates : []) {
        const update = asRecord(updateValue);
        const indexes = Array.isArray(update?.changedCellIndexes) ? update.changedCellIndexes : [];
        if (update) lines.push(`  ~ row ${String(update.key)}: columns ${indexes.map((index) => Number(index) + 1).join(', ')}`);
      }
      continue;
    }
    lines.push(`${String(operation.kind)}: ${label}`);
  }
  for (const blockerValue of Array.isArray(scoped?.blockers) ? scoped.blockers : []) {
    const blocker = asRecord(blockerValue);
    if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.message)}`);
  }
  const whiteboards = asRecord(plan.whiteboards);
  for (const value of Array.isArray(whiteboards?.assets) ? whiteboards.assets : []) {
    const whiteboard = asRecord(value);
    if (whiteboard) {
      lines.push(`whiteboard[${String(whiteboard.state)}]: ${String(whiteboard.assetKey)} - ${String(whiteboard.action)}`);
    }
  }
  for (const value of Array.isArray(whiteboards?.blockers) ? whiteboards.blockers : []) {
    const blocker = asRecord(value);
    if (blocker) {
      lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.assetKey)} - ${String(blocker.message)}`);
    }
  }
  for (const warning of Array.isArray(plan.warnings) ? plan.warnings : []) lines.push(`warning: ${String(warning)}`);
  if (plan.requiresUntrackedRemoteConfirmation === true) lines.push('requires: --confirm-untracked-remote');
  if (plan.requiresCollaborationRiskConfirmation === true) lines.push('requires: --confirm-collaboration-risk');
  for (const assetKey of Array.isArray(plan.requiredRemoteWhiteboardOverwrites) ? plan.requiredRemoteWhiteboardOverwrites : []) {
    lines.push(`requires: --confirm-remote-whiteboard-overwrite ${String(assetKey)}`);
  }
  return lines;
}

function appendZdocRoundTripLines(lines: string[], value: unknown): void {
  const report = asRecord(value);
  for (const itemValue of Array.isArray(report?.items) ? report.items : []) {
    const item = asRecord(itemValue);
    if (!item) continue;
    lines.push(
      `zdoc[${String(item.severity)}][${String(item.code)}]: ${String(item.message)}`
    );
  }
}

function appendDialectDiagnostics(
  lines: string[],
  value: unknown,
  label: 'blocker' | 'warning'
): void {
  for (const item of Array.isArray(value) ? value : []) {
    const diagnostic = asRecord(item);
    if (!diagnostic) continue;
    const location = asRecord(diagnostic.location);
    const suffix = location
      ? ` at ${String(location.file)}:${String(location.line)}${location.column ? `:${String(location.column)}` : ''}`
      : '';
    lines.push(`${label}[${String(diagnostic.code)}]: ${String(diagnostic.message)}${suffix}`);
  }
}

function linkSummaryLine(value: unknown): string {
  const summary = asRecord(value);
  const feishu = Number(summary?.resolvedToFeishu ?? 0);
  const publicFallback = Number(summary?.resolvedToPublicSite ?? 0);
  const unresolved = Number(summary?.unresolved ?? 0);
  return `links: ${feishu} Feishu, ${publicFallback} public fallback, ${unresolved} unresolved`;
}

function appendCodeSummaryLines(lines: string[], value: unknown): void {
  for (const item of Array.isArray(value) ? value : []) {
    const code = asRecord(item);
    const locator = asRecord(code?.locator);
    if (!code || !locator) continue;
    if (code.action === 'reconcile') {
      lines.push(`code-section: ${locatorLabel(locator)} [reconcile]`);
      lines.push(`  + ${String(code.additions ?? 0)} code blocks`);
      lines.push(`  - ${String(code.deletions ?? 0)} code blocks`);
      continue;
    }
    lines.push(`code[${String(code.language ?? 'plaintext')}]: ${locatorLabel(locator)}`);
    if (code.contentChanged === true) lines.push('  ~ content');
    const language = asRecord(code.languageChange);
    if (language) lines.push(`  → language: ${String(language.from)} -> ${String(language.to)}`);
    const move = asRecord(code.move);
    if (move) {
      const from = Array.isArray(move.from) ? move.from.map(String).join(' > ') : '';
      const to = Array.isArray(move.to) ? move.to.map(String).join(' > ') : '';
      lines.push(`  → move: ${from || '<root>'} -> ${to || '<root>'}`);
    }
  }
}

function appendCalloutSummaryLines(lines: string[], value: unknown): void {
  for (const item of Array.isArray(value) ? value : []) {
    const callout = asRecord(item);
    const locator = asRecord(callout?.locator);
    if (!callout || !locator) continue;
    lines.push(`callout[${String(callout.type)}]: ${locatorLabel(locator)}`);
    for (const childValue of Array.isArray(callout.childChanges) ? callout.childChanges : []) {
      const child = asRecord(childValue);
      if (!child) continue;
      const action = String(child.action);
      const marker = action === 'create' ? '+' : action === 'delete' ? '-' : '~';
      const label = blockTypeLabel(typeof child.blockType === 'number' ? child.blockType : undefined);
      lines.push(`  ${marker} ${label} ${Number(child.ordinal) + 1}`);
    }
  }
}

function blockTypeLabel(blockType: number | undefined): string {
  if (blockType === 2) return 'paragraph';
  if (blockType && blockType >= 3 && blockType <= 8) return `heading${blockType - 2}`;
  if (blockType === 12) return 'bullet';
  if (blockType === 13) return 'ordered';
  return 'block';
}

function locatorLabel(locator: Record<string, unknown> | undefined): string {
  if (!locator) return '<unknown>';
  const path = Array.isArray(locator.sectionPath) ? locator.sectionPath.map(String).join(' > ') : '';
  return `${path || '<root>'} [${String(locator.ordinal ?? 0)}]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
