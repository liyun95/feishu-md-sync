import type { LinkAudit, ReleaseNotesAudit, VariablesAudit } from './audit.js';
import type { SdkTagMatrix } from './sdk-tags.js';
import type { ReleaseTaskSummary } from './task.js';

export type ReleaseReport = {
  kind: 'feishu-release-report';
  version: 1;
  generatedAt: string;
  task: ReleaseTaskSummary;
  sdkTags?: SdkTagMatrix;
  audits: {
    variables?: VariablesAudit;
    releaseNotes?: ReleaseNotesAudit;
    links?: LinkAudit;
  };
  summary: {
    passed: boolean;
    blocked: string[];
  };
};

export function serializeReleaseReportJson(report: ReleaseReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReleaseReportMarkdown(report: ReleaseReport): string {
  const lines = [
    '# Release Report',
    '',
    `Release: ${report.task.releaseVersion} (${report.task.releaseLine})`,
    `Status: ${report.task.status}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `Result: ${report.summary.passed ? 'passed' : 'blocked'}`
  ];

  if (report.summary.blocked.length > 0) {
    lines.push('', 'Blocked items:', '');
    for (const item of report.summary.blocked) {
      lines.push(`- ${item}`);
    }
  }

  if (report.sdkTags) {
    lines.push('', '## SDK Tags', '', '| SDK | Tag | Variables value | Status | Evidence |', '| --- | --- | --- | --- | --- |');
    for (const row of report.sdkTags.rows) {
      lines.push(
        `| ${row.label} | ${row.matchedTag ?? ''} | ${row.variablesValue ?? ''} | ${row.status} | ${
          row.reason ?? row.evidence
        } |`
      );
    }
  }

  if (report.audits.variables) {
    lines.push('', '## Variables', '', '| Variable | Current | Expected | Status |', '| --- | --- | --- | --- |');
    for (const change of report.audits.variables.changes) {
      lines.push(
        `| ${change.variable} | ${change.currentValue ?? ''} | ${change.expectedValue ?? ''} | ${change.status} |`
      );
    }
  }

  if (report.audits.releaseNotes) {
    lines.push('', '## Release Notes', '', report.audits.releaseNotes.message);
  }

  if (report.audits.links) {
    lines.push('', '## Links', '', '| Keyword | Path | Anchor | Status |', '| --- | --- | --- | --- |');
    for (const item of report.audits.links.items) {
      lines.push(`| ${item.keyword} | ${item.localPath} | ${item.anchor} | ${item.status} |`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
