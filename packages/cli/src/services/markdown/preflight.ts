import { markdownToFeishuBlocks } from '../../markdown/blocks.js';
import { validateFeishuBlocksForWrite, type FeishuPreflightIssue } from '../../sync/preflight.js';

export type MarkdownPreflightReport = {
  kind: 'markdown-publish-preflight';
  version: 1;
  passed: boolean;
  issues: FeishuPreflightIssue[];
};

export function buildMarkdownPreflightReport(markdown: string): MarkdownPreflightReport {
  const issues = validateFeishuBlocksForWrite(markdownToFeishuBlocks(markdown));
  return {
    kind: 'markdown-publish-preflight',
    version: 1,
    passed: issues.length === 0,
    issues
  };
}
