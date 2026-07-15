import { describe, expect, it } from 'vitest';
import { preprocessDialect } from '../src/dialects/preprocess.js';

describe('gfm dialect', () => {
  it('preserves portable Markdown byte-for-byte', async () => {
    const markdown = '# Title\n\n| A | B |\n|-|-|\n| 1 | 2 |\n';
    const result = await preprocessDialect({
      cwd: '/workspace',
      sourcePath: '/workspace/doc.md',
      markdown,
      dialect: 'gfm',
      config: {}
    });

    expect(result.markdown).toBe(markdown);
    expect(result.blockers).toEqual([]);
  });

  it('warns instead of silently stripping frontmatter or rewriting relative links', async () => {
    const result = await preprocessDialect({
      cwd: '/workspace',
      sourcePath: '/workspace/doc.md',
      markdown: '---\ntitle: Demo\n---\n\n[Next](./next.md)\n',
      dialect: 'gfm',
      config: {}
    });

    expect(result.markdown).toContain('title: Demo');
    expect(result.warnings.map(({ code }) => code)).toEqual([
      'dialect-suggestion',
      'relative-link-unresolved'
    ]);
  });

  it('ignores Markdown-looking content inside fenced code', async () => {
    const result = await preprocessDialect({
      cwd: '/workspace',
      sourcePath: '/workspace/doc.md',
      markdown: '```md\n[Next](./next.md)\n<Tabs>\n```\n',
      dialect: 'gfm',
      config: {}
    });

    expect(result.warnings).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it('blocks an unsupported structural component outside code', async () => {
    const result = await preprocessDialect({
      cwd: '/workspace',
      sourcePath: '/workspace/doc.md',
      markdown: '<Tabs>\nBody\n</Tabs>\n',
      dialect: 'gfm',
      config: {}
    });

    expect(result.blockers[0].code).toBe('unsupported-mdx-component');
  });
});
