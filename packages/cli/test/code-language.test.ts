import { describe, expect, it } from 'vitest';
import {
  codeLanguageForId,
  codeLanguageId,
  resolveCodeLanguage
} from '../src/code-blocks/code-language.js';

describe('Code block languages', () => {
  it.each([
    ['plaintext', 1],
    ['bash', 7],
    ['go', 22],
    ['json', 28],
    ['java', 29],
    ['javascript', 30],
    ['python', 49],
    ['sql', 57],
    ['scala', 58],
    ['shell', 62],
    ['typescript', 64],
    ['xml', 66],
    ['yaml', 67],
    ['diff', 69]
  ])('round-trips canonical %s', (language, id) => {
    expect(codeLanguageId(language)).toBe(id);
    expect(codeLanguageForId(id)).toBe(language);
  });

  it('accepts the alternate Feishu Python language ID', () => {
    expect(codeLanguageForId(50)).toBe('python');
  });

  it.each([
    ['', 'plaintext'],
    ['py', 'python'],
    ['js', 'javascript'],
    ['golang', 'go'],
    ['yml', 'yaml'],
    ['curl', 'bash'],
    ['conf', 'plaintext'],
    ['log', 'plaintext'],
    ['promql', 'plaintext'],
    ['rest', 'bash']
  ])('resolves %j to %s', (source, expected) => {
    expect(resolveCodeLanguage(source).resolvedLanguage).toBe(expected);
  });

  it('applies workspace aliases before built-in aliases', () => {
    expect(resolveCodeLanguage('console', {
      languageAliases: {
        console: 'shell',
        shell: 'bash'
      }
    })).toMatchObject({
      sourceLanguage: 'console',
      resolvedLanguage: 'bash',
      languageId: 7
    });
  });

  it('fails closed for unknown languages', () => {
    expect(() => resolveCodeLanguage('milvusql')).toThrow('unsupported Code block language: milvusql');
  });

  it('fails closed for alias cycles', () => {
    expect(() => resolveCodeLanguage('a', {
      languageAliases: { a: 'b', b: 'a' }
    })).toThrow('Code block language alias cycle: a -> b -> a');
  });
});
