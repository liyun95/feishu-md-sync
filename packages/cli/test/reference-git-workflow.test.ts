import { describe, expect, it } from 'vitest';
import { buildReferencePrBody, buildReferencePrCommand, formatShellCommand } from '../src/reference/git-workflow.js';

describe('reference git workflow', () => {
  it('builds a reviewable PR body from workflow reports', () => {
    const body = buildReferencePrBody({
      sdk: 'java',
      versionRange: 'v2.6.19 -> v3.0.0',
      feishuReportPath: 'reports/reference-apply.json',
      webContentSummary: 'Written: API_Reference/milvus-sdk-java/v2.6.x/v2/MilvusClient/Collections/describeCollection.md',
      risks: ['Feishu sync latency may delay web-content export freshness.']
    });

    expect(body).toContain('SDK: java');
    expect(body).toContain('Version range: v2.6.19 -> v3.0.0');
    expect(body).toContain('reports/reference-apply.json');
    expect(body).toContain('Feishu sync latency');
  });

  it('builds a gh pr create command without executing it', () => {
    const command = buildReferencePrCommand({
      base: 'master',
      branch: 'docs/java-v2.6.19-reference',
      title: 'Update Java SDK reference for v2.6.19',
      bodyFile: 'reports/pr-body.md'
    });

    expect(command).toEqual([
      'gh',
      'pr',
      'create',
      '--base',
      'master',
      '--head',
      'docs/java-v2.6.19-reference',
      '--title',
      'Update Java SDK reference for v2.6.19',
      '--body-file',
      'reports/pr-body.md'
    ]);
  });

  it('formats PR commands with shell-safe quoting for copy-paste handoff', () => {
    const command = buildReferencePrCommand({
      base: 'master',
      branch: 'docs/java-v2.6.19-reference',
      title: 'Update Java SDK reference for v2.6.19',
      bodyFile: 'reports/pr body.md'
    });

    expect(formatShellCommand(command)).toBe(
      "gh pr create --base master --head docs/java-v2.6.19-reference --title 'Update Java SDK reference for v2.6.19' --body-file 'reports/pr body.md'"
    );
  });

  it('escapes single quotes in shell handoff commands', () => {
    expect(formatShellCommand(['gh', 'pr', 'create', '--title', 'Bob\'s SDK update'])).toBe(
      "gh pr create --title 'Bob'\\''s SDK update'"
    );
  });
});
