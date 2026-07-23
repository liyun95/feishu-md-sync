import { describe, expect, it } from 'vitest';
import {
  cellPlainText,
  normalizeHeading,
  normalizeRowKey,
  semanticHash,
  stripExecutionMetadata
} from '../src/semantic/normalize.js';
import type { SemanticCell } from '../src/semantic/types.js';

describe('semantic normalization', () => {
  it('normalizes headings case-insensitively and collapses whitespace', () => {
    expect(normalizeHeading('  Index   Params ')).toBe('index params');
  });

  it('uses visible first-cell content as a stable row key', () => {
    const cell: SemanticCell = {
      blocks: [{
        kind: 'paragraph',
        inlines: [
          { kind: 'text', value: 'num_random_' },
          { kind: 'text', value: 'samplings', marks: { code: true } }
        ]
      }]
    };

    expect(cellPlainText(cell)).toBe('num_random_samplings');
    expect(normalizeRowKey(cell)).toBe('num_random_samplings');
  });

  it('hashes semantically identical objects deterministically', () => {
    expect(semanticHash({ b: 2, a: 1 })).toBe(semanticHash({ a: 1, b: 2 }));
  });

  it('retains managed Code fields while stripping execution identity', () => {
    expect(stripExecutionMetadata({
      kind: 'code',
      content: 'print(1)\n',
      sourceLanguage: 'py',
      resolvedLanguage: 'python',
      caption: 'Example',
      remoteBlockId: 'code1'
    })).toEqual({
      kind: 'code',
      content: 'print(1)\n',
      sourceLanguage: 'py',
      resolvedLanguage: 'python',
      caption: 'Example'
    });
  });

  it('strips execution identity from protected authoring nodes', () => {
    expect(stripExecutionMetadata({
      kind: 'protected-resource',
      resourceKind: 'supademo',
      componentId: 'demo-id',
      isShowcase: true,
      remoteBlockId: 'isv1',
      remoteToken: 'token1',
      remoteShape: 'isv'
    })).toEqual({
      kind: 'protected-resource',
      resourceKind: 'supademo',
      componentId: 'demo-id',
      isShowcase: true,
      remoteShape: 'isv'
    });
  });
});
