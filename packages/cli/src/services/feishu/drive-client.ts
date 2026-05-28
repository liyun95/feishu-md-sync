import type { FeishuDriveFile } from '../../feishu/types.js';

export class FeishuDriveClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async listFolder(folderToken: string, type?: string): Promise<FeishuDriveFile[]> {
    const params = new URLSearchParams({ folder_token: folderToken });
    if (type) params.set('type', type);
    const data = await this.request<{ files?: FeishuDriveFile[]; items?: FeishuDriveFile[] }>(
      'GET',
      `/open-apis/drive/v1/files?${params.toString()}`
    );
    return data.files ?? data.items ?? [];
  }

  async createFolder(name: string, parentToken: string): Promise<FeishuDriveFile> {
    const data = await this.request<{ file?: FeishuDriveFile }>(
      'POST',
      '/open-apis/drive/v1/files/create_folder',
      { name, folder_token: parentToken }
    );
    return data.file ?? data;
  }

  async copyFile(token: string, targetFolderToken: string, name?: string, type?: string): Promise<FeishuDriveFile> {
    const data = await this.request<{ file?: FeishuDriveFile }>(
      'POST',
      `/open-apis/drive/v1/files/${token}/copy`,
      { folder_token: targetFolderToken, name, type }
    );
    return data.file ?? {};
  }

  async moveFile(token: string, targetFolderToken: string, type?: string): Promise<FeishuDriveFile> {
    const data = await this.request<{ file?: FeishuDriveFile }>(
      'POST',
      `/open-apis/drive/v1/files/${token}/move`,
      { folder_token: targetFolderToken, type }
    );
    return data.file ?? data;
  }
}
