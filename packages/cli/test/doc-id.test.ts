import { describe, expect, it } from 'vitest';
import { parseFeishuDocId, parseFeishuTarget } from '../src/core/doc-id.js';

describe('parseFeishuDocId', () => {
  it('accepts raw doc tokens', () => {
    expect(parseFeishuDocId('F8lCdDCa3oD48WxWyURcmfoznYt')).toBe('F8lCdDCa3oD48WxWyURcmfoznYt');
  });

  it('extracts docx tokens from URLs', () => {
    expect(parseFeishuDocId('https://zilliverse.feishu.cn/docx/F8lCdDCa3oD48WxWyURcmfoznYt?from=from_copylink')).toBe(
      'F8lCdDCa3oD48WxWyURcmfoznYt'
    );
  });

  it('extracts legacy docs tokens from URLs', () => {
    expect(parseFeishuDocId('https://zilliverse.feishu.cn/docs/F8lCdDCa3oD48WxWyURcmfoznYt')).toBe(
      'F8lCdDCa3oD48WxWyURcmfoznYt'
    );
  });

  it('extracts wiki node tokens as wiki targets', () => {
    expect(parseFeishuTarget('https://zilliverse.feishu.cn/wiki/Kz5rwMmxCixx78kWWnnc5teanzd?renamingWikiNode=true')).toEqual({
      kind: 'wiki',
      token: 'Kz5rwMmxCixx78kWWnnc5teanzd'
    });
  });

  it('does not return wiki node tokens as docx IDs', () => {
    expect(() => parseFeishuDocId('https://zilliverse.feishu.cn/wiki/Kz5rwMmxCixx78kWWnnc5teanzd')).toThrow(/Wiki URL/);
  });

  it('rejects empty values', () => {
    expect(() => parseFeishuDocId('')).toThrow(/required/);
  });

  it('rejects malformed values', () => {
    expect(() => parseFeishuDocId('not a url')).toThrow(/Invalid Feishu/);
  });

  it('rejects URLs without doc tokens', () => {
    expect(() => parseFeishuDocId('https://zilliverse.feishu.cn/drive/home')).toThrow(/Could not find/);
  });
});
