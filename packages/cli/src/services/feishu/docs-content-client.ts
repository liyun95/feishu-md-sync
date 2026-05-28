export type DocsContentClient = {
  getMarkdownContent(documentId: string): Promise<string>;
};

export class FeishuDocsContentClient implements DocsContentClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async getMarkdownContent(documentId: string): Promise<string> {
    const params = new URLSearchParams({
      doc_token: documentId,
      doc_type: 'docx',
      content_type: 'markdown'
    });
    const data = await this.request<{ content?: string }>('GET', `/open-apis/docs/v1/content?${params.toString()}`);
    if (typeof data.content !== 'string') {
      throw new Error(`Feishu Markdown export returned no content for ${documentId}.`);
    }
    return data.content;
  }
}
