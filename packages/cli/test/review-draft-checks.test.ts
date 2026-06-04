import { describe, expect, it } from 'vitest';
import { analyzeReviewDraftChecks, reviewDraftCheckSummaryLines } from '../src/sync/review-draft-checks.js';

describe('review draft checks', () => {
  it('detects frontmatter, raw HTML blocks, unwrapped Milvus prose, and local links', () => {
    const report = analyzeReviewDraftChecks([
      '---',
      'title: Pattern Matching',
      '---',
      '',
      '<div class="alert note">',
      'Use Milvus carefully.',
      '</div>',
      '',
      'See [NGRAM](ngram.md), [anchor](#local), and [external](https://milvus.io/docs/).',
      '',
      '`Milvus` in code is allowed.',
      '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> is allowed.'
    ].join('\n'));

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual([
      { kind: 'frontmatter', message: 'visible frontmatter remains in review draft' },
      { kind: 'raw-html-block', message: 'raw HTML block remains in review draft' },
      { kind: 'unwrapped-milvus', message: 'standalone Milvus remains outside include tags, links, and code' },
      { kind: 'local-link', message: 'local-only relative Markdown link remains in review draft: ngram.md' }
    ]);
  });

  it('passes sanitized Milvus review draft Markdown', () => {
    const report = analyzeReviewDraftChecks([
      '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> supports pattern matching.',
      '',
      'See [NGRAM](https://milvus.io/docs/ngram.md) and [anchor](#local).',
      '',
      '```python',
      'print("Milvus")',
      '```'
    ].join('\n'));

    expect(report).toEqual({ passed: true, issues: [] });
    expect(reviewDraftCheckSummaryLines(report)).toEqual(['Review draft checks: passed']);
  });

  it('formats concise failed check summary lines', () => {
    expect(reviewDraftCheckSummaryLines(analyzeReviewDraftChecks('Milvus text.\n'))).toEqual([
      'Review draft checks: failed',
      '- standalone Milvus remains outside include tags, links, and code'
    ]);
  });
});
