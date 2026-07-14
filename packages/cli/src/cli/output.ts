export type OutputFormat = 'pretty' | 'json';

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
  if (typeof record.state === 'string' && asRecord(record.recommendation)) {
    const recommendation = asRecord(record.recommendation)!;
    const lines = [
      `state: ${record.state}`,
      `local changed: ${String(record.localChanged)}`,
      `remote changed: ${String(record.remoteChanged)}`,
      `recommendation: ${String(recommendation.action)} - ${String(recommendation.reason)}`
    ];
    for (const value of Array.isArray(record.whiteboards) ? record.whiteboards : []) {
      const whiteboard = asRecord(value);
      if (whiteboard) {
        lines.push(`whiteboard[${String(whiteboard.state)}]: ${String(whiteboard.assetKey)} - ${String(whiteboard.action)}`);
      }
    }
    appendCalloutSummaryLines(lines, record.callouts);
    for (const value of Array.isArray(record.calloutBlockers) ? record.calloutBlockers : []) {
      const blocker = asRecord(value);
      if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.message)}`);
    }
    for (const value of Array.isArray(record.whiteboardBlockers) ? record.whiteboardBlockers : []) {
      const blocker = asRecord(value);
      if (blocker) lines.push(`blocker[${String(blocker.code)}]: ${String(blocker.assetKey)} - ${String(blocker.message)}`);
    }
    return lines;
  }
  return undefined;
}

function publishPlanLines(result: Record<string, unknown>, plan: Record<string, unknown>): string[] {
  const lines = [
    `mode: ${String(result.mode)}`,
    `strategy: ${String(plan.strategy)}`
  ];
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
    if (operation.kind === 'table-replace') {
      lines.push(`table: ${label}`);
      const diff = asRecord(operation.diff);
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
