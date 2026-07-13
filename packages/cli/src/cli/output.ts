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
    return [
      `state: ${record.state}`,
      `local changed: ${String(record.localChanged)}`,
      `remote changed: ${String(record.remoteChanged)}`,
      `recommendation: ${String(recommendation.action)} - ${String(recommendation.reason)}`
    ];
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
  for (const warning of Array.isArray(plan.warnings) ? plan.warnings : []) lines.push(`warning: ${String(warning)}`);
  if (plan.requiresUntrackedRemoteConfirmation === true) lines.push('requires: --confirm-untracked-remote');
  if (plan.requiresCollaborationRiskConfirmation === true) lines.push('requires: --confirm-collaboration-risk');
  return lines;
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
