import { describe, expect, it } from 'vitest';
import {
  buildReferenceSourceFreshness,
  latestMatchingTag,
  tagMatchesVersionLine
} from '../src/reference/freshness.js';

describe('reference source freshness', () => {
  it('selects the latest matching release-line tag', () => {
    expect(latestMatchingTag(['v3.0.0', 'v3.0.1', 'v2.6.20'], 'v3.0.x')).toBe('v3.0.1');
    expect(latestMatchingTag(['v2.6.9', 'v2.6.20', 'v2.5.99'], '2.6.x')).toBe('v2.6.20');
  });

  it('matches version-line tags with or without a leading v', () => {
    expect(tagMatchesVersionLine('v3.0.1', '3.0.x')).toBe(true);
    expect(tagMatchesVersionLine('3.0.1', 'v3.0.x')).toBe(true);
    expect(tagMatchesVersionLine('v3.1.0', 'v3.0.x')).toBe(false);
  });

  it('builds stale freshness evidence with a diff range and changed paths', () => {
    const freshness = buildReferenceSourceFreshness({
      sdk: 'java',
      repository: 'repos/milvus-sdk-java',
      versionLine: 'v3.0.x',
      baselineTag: 'v3.0.0',
      tags: ['v3.0.0', 'v3.0.1'],
      changedPaths: ['sdk-core/src/main/java/io/milvus/v2/service/vector/request/UpsertReq.java'],
      checkedAt: '2026-05-25T00:00:00.000Z'
    });

    expect(freshness).toEqual(expect.objectContaining({
      sdk: 'java',
      baselineTag: 'v3.0.0',
      latestTag: 'v3.0.1',
      upToDate: false,
      diffRange: 'v3.0.0..v3.0.1',
      changedPaths: ['sdk-core/src/main/java/io/milvus/v2/service/vector/request/UpsertReq.java']
    }));
  });
});
