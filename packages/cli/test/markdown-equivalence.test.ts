import { describe, expect, it } from 'vitest';
import { canonicalizeMarkdownSemantics } from '../src/semantic/markdown-equivalence.js';

describe('Markdown semantic equivalence', () => {
  it('normalizes verified Feishu serialization differences', () => {
    expect(canonicalizeMarkdownSemantics(
      '| A | B |\n|-|-|\n| x | y |'
    )).toBe(
      '| A | B |\n| --- | --- |\n| x | y |'
    );

    expect(canonicalizeMarkdownSemantics('1. one\n2. two'))
      .toBe(canonicalizeMarkdownSemantics('1. one\n1. two'));

    expect(canonicalizeMarkdownSemantics('Provider\u00a0name'))
      .toBe(canonicalizeMarkdownSemantics('Provider name'));
  });

  it('preserves fenced Code content byte-for-byte', () => {
    expect(canonicalizeMarkdownSemantics(
      '```md\n|-|-|\n2. literal\nA\u00a0B\n```'
    )).toContain('|-|-|\n2. literal\nA\u00a0B');
  });
});
