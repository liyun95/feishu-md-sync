import { describe, expect, it } from 'vitest';
import { extractUniqueMarkdownSection } from '../src/markdown/section-extract.js';

describe('extractUniqueMarkdownSection', () => {
  it('extracts a heading section including nested subsections', () => {
    const markdown = [
      '# Title',
      '',
      'Intro',
      '',
      '## FAQ',
      '',
      'A',
      '',
      '### Child',
      '',
      'B',
      '',
      '## Other',
      '',
      'C'
    ].join('\n');

    expect(extractUniqueMarkdownSection(markdown, 'FAQ')).toEqual({
      title: 'FAQ',
      level: 2,
      startLine: 4,
      endLine: 12,
      markdown: '## FAQ\n\nA\n\n### Child\n\nB\n'
    });
  });

  it('ignores headings inside fenced code blocks', () => {
    const markdown = [
      '```md',
      '## FAQ',
      '```',
      '',
      '## FAQ',
      '',
      'Visible'
    ].join('\n');

    expect(extractUniqueMarkdownSection(markdown, 'FAQ').markdown).toBe('## FAQ\n\nVisible\n');
  });

  it('fails when the section is missing or duplicated', () => {
    expect(() => extractUniqueMarkdownSection('# Title\n', 'FAQ')).toThrow(/Could not find local section "FAQ"/);
    expect(() => extractUniqueMarkdownSection('## FAQ\nA\n\n## FAQ\nB\n', 'FAQ')).toThrow(/Found 2 local sections named "FAQ"/);
  });
});
