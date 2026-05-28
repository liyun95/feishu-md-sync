import { describe, expect, it } from 'vitest';
import { buildMarkdownPreflightReport } from '../src/services/markdown/preflight.js';

describe('Markdown publish preflight', () => {
  it('reports unsupported local links before Feishu writes', () => {
    const report = buildMarkdownPreflightReport('See [local](./local.md) and [anchor](#section).\n');
    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['unsupported-link-url', 'unsupported-link-url']);
  });

  it('accepts absolute http links', () => {
    const report = buildMarkdownPreflightReport('See [docs](https://milvus.io/docs/).\n');
    expect(report.passed).toBe(true);
  });
});
