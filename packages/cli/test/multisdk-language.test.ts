import { describe, expect, it } from 'vitest';
import { normalizeMultisdkLanguage, parseMultisdkLanguage } from '../src/multisdk/language.js';

describe('multisdk language normalization', () => {
  it('normalizes supported languages and javascript aliases', () => {
    expect(normalizeMultisdkLanguage('java')).toBe('java');
    expect(normalizeMultisdkLanguage('javascript')).toBe('javascript');
    expect(normalizeMultisdkLanguage('node')).toBe('javascript');
    expect(normalizeMultisdkLanguage('nodejs')).toBe('javascript');
    expect(normalizeMultisdkLanguage('js')).toBe('javascript');
    expect(normalizeMultisdkLanguage('go')).toBe('go');
    expect(normalizeMultisdkLanguage('restful')).toBe('restful');
  });

  it('rejects python and unknown languages for multisdk lanes', () => {
    expect(normalizeMultisdkLanguage('python')).toBeNull();
    expect(normalizeMultisdkLanguage('cpp')).toBeNull();
    expect(() => parseMultisdkLanguage('cpp')).toThrow(/Invalid --language cpp/);
  });
});
