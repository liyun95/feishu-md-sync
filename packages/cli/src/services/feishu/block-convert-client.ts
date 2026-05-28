import type { FeishuBlock } from '../../feishu/types.js';

export type BlockConvertClient = {
  markdownToBlocks(markdown: string): Promise<FeishuBlock[]>;
};

export class FeishuBlockConvertClient implements BlockConvertClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async markdownToBlocks(markdown: string): Promise<FeishuBlock[]> {
    const data = await this.request<{ blocks?: FeishuBlock[] }>(
      'POST',
      '/open-apis/docx/v1/documents/blocks/convert',
      {
        content_type: 'markdown',
        content: markdown
      }
    );
    return data.blocks ?? [];
  }
}
