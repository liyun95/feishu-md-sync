import type { FeishuBlock, FeishuBlockUpdateRequest, FeishuDriveFile } from '../../feishu/types.js';

export class FeishuDocxClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async getDocumentBlocksPage(documentId: string, pageToken?: string): Promise<{
    items?: FeishuBlock[];
    has_more?: boolean;
    page_token?: string;
  }> {
    const params = new URLSearchParams({
      page_size: '500',
      document_revision_id: '-1'
    });
    if (pageToken) params.set('page_token', pageToken);
    return this.request('GET', `/open-apis/docx/v1/documents/${documentId}/blocks?${params.toString()}`);
  }

  async deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void> {
    await this.request(
      'DELETE',
      `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children/batch_delete`,
      { start_index: startIndex, end_index: endIndex }
    );
  }

  async createChildren(documentId: string, parentBlockId: string, body: { children: FeishuBlock[]; index?: number }): Promise<{ children?: FeishuBlock[] }> {
    return this.request('POST', `/open-apis/docx/v1/documents/${documentId}/blocks/${parentBlockId}/children`, body);
  }

  async batchUpdateBlocks(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<{ blocks?: FeishuBlock[] }> {
    return this.request('PATCH', `/open-apis/docx/v1/documents/${documentId}/blocks/batch_update`, { requests });
  }

  async createDocument(title: string, folderToken?: string): Promise<FeishuDriveFile> {
    const data = await this.request<{ document?: FeishuDriveFile; file?: FeishuDriveFile }>(
      'POST',
      '/open-apis/docx/v1/documents',
      folderToken ? { title, folder_token: folderToken } : { title }
    );
    return data.document ?? data.file ?? {};
  }
}
