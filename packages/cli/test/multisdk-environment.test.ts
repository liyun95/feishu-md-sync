import { describe, expect, it } from 'vitest';
import { parseMilvusTarget } from '../src/multisdk/environment.js';

describe('multisdk environment target', () => {
  it('parses a released Milvus version target', () => {
    expect(parseMilvusTarget({ milvusVersion: '2.6.0' })).toEqual({
      kind: 'released-version',
      version: '2.6.0'
    });
  });

  it('parses an unreleased source build target', () => {
    expect(parseMilvusTarget({
      milvusVersion: '2.7.0-dev',
      milvusSourceRepo: 'https://github.com/milvus-io/milvus.git',
      milvusSourceRef: 'feature/json-index'
    })).toEqual({
      kind: 'source-build',
      version: '2.7.0-dev',
      sourceRepo: 'https://github.com/milvus-io/milvus.git',
      sourceRef: 'feature/json-index'
    });
  });

  it('rejects source repo without a source ref', () => {
    expect(() => parseMilvusTarget({
      milvusVersion: '2.7.0-dev',
      milvusSourceRepo: 'https://github.com/milvus-io/milvus.git'
    })).toThrow(/--milvus-source-ref/);
  });

  it('tells agents to ask the user when the Milvus target is missing', () => {
    expect(() => parseMilvusTarget({})).toThrow(/Ask the user to confirm the Milvus target/);
  });
});
