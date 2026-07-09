import { describe, expect, it } from 'vitest';
import { applyPullTransformForProfile } from '../src/transform/zilliz-pull.js';

describe('Zilliz pull transform', () => {
  it('keeps raw include and exclude tags for the none profile', () => {
    const markdown = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';

    expect(applyPullTransformForProfile(markdown, 'none')).toEqual({
      markdown,
      warnings: []
    });
  });

  it('filters include tags for the milvus profile', () => {
    const markdown = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';

    expect(applyPullTransformForProfile(markdown, 'milvus')).toEqual({
      markdown: 'Milvus stores vectors.',
      warnings: []
    });
  });

  it('filters include tags for the zilliz profile', () => {
    const markdown = '<include target="milvus">Milvus</include><include target="zilliz">Zilliz Cloud</include> stores vectors.';

    expect(applyPullTransformForProfile(markdown, 'zilliz')).toEqual({
      markdown: 'Zilliz Cloud stores vectors.',
      warnings: []
    });
  });

  it('supports exclude tags and multiple target separators', () => {
    const markdown = [
      '<exclude target="zilliz">Milvus-only note.</exclude>',
      '<include target="milvus,zilliz">Shared note.</include>',
      '<include target="milvus zilliz">Another shared note.</include>'
    ].join('\n');

    expect(applyPullTransformForProfile(markdown, 'zilliz')).toEqual({
      markdown: '\nShared note.\nAnother shared note.',
      warnings: []
    });
  });

  it('keeps unknown targets and reports a warning', () => {
    const markdown = '<include target="enterprise">Enterprise note.</include>';

    expect(applyPullTransformForProfile(markdown, 'milvus')).toEqual({
      markdown,
      warnings: ['Unsupported include target "enterprise"; left tag unchanged.']
    });
  });

  it('keeps malformed include tags and reports a warning', () => {
    const markdown = '<include>Tagged note.</include>';

    expect(applyPullTransformForProfile(markdown, 'zilliz')).toEqual({
      markdown,
      warnings: ['include tag without target attribute was left unchanged.']
    });
  });
});
