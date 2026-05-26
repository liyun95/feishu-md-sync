import { describe, expect, it } from 'vitest';
import { buildSdkTagMatrix, renderSdkTagMatrixMarkdown, type SdkSourceReader } from '../src/release/sdk-tags.js';

describe('release SDK tag matrix', () => {
  it('selects the highest matching release-line tag per SDK', async () => {
    const reader: SdkSourceReader = async (source) => {
      const tags: Record<string, string[]> = {
        python: ['v2.5.9', 'v2.6.16', 'v2.6.17'],
        java: ['v2.6.16', 'v2.6.17'],
        nodejs: ['v2.6.15', 'v2.6.17'],
        go: ['v2.6.16', 'v2.6.17'],
        rest: ['v2.6.17']
      };
      return tags[source.sdk];
    };

    const matrix = await buildSdkTagMatrix({ releaseLine: '2.6.x', reader });

    expect(matrix.rows.map((row) => [row.sdk, row.matchedTag, row.variablesValue])).toEqual([
      ['python', 'v2.6.17', '2.6.17'],
      ['java', 'v2.6.17', '2.6.17'],
      ['nodejs', 'v2.6.17', '2.6.17'],
      ['go', 'v2.6.17', '2.6.17'],
      ['rest', 'v2.6.17', '2.6.17']
    ]);
    expect(matrix.blocked).toEqual([]);
  });

  it('marks unavailable source rows as blocked', async () => {
    const matrix = await buildSdkTagMatrix({
      releaseLine: '3.0.x',
      reader: async (source) => {
        if (source.sdk === 'java') throw new Error('network unavailable');
        return ['v3.0.0'];
      }
    });

    expect(matrix.rows.find((row) => row.sdk === 'java')?.status).toBe('blocked');
    expect(matrix.blocked[0].sdk).toBe('java');
    expect(renderSdkTagMatrixMarkdown(matrix)).toContain('| java |');
  });
});
