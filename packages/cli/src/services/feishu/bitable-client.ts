import type { BitableField, BitableRecord, BitableTable } from '../../feishu/types.js';

export class FeishuBitableClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async listTables(appToken: string): Promise<BitableTable[]> {
    const data = await this.request<{ items?: BitableTable[] }>(
      'GET',
      `/open-apis/bitable/v1/apps/${appToken}/tables`
    );
    return data.items ?? [];
  }

  async listFields(appToken: string, tableId: string): Promise<BitableField[]> {
    const data = await this.request<{ items?: BitableField[] }>(
      'GET',
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`
    );
    return data.items ?? [];
  }

  async listRecordsPage(appToken: string, tableId: string, pageToken?: string): Promise<{
    items?: BitableRecord[];
    has_more?: boolean;
    page_token?: string;
  }> {
    const params = new URLSearchParams({ page_size: '500' });
    if (pageToken) params.set('page_token', pageToken);
    return this.request('GET', `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`);
  }

  async createRecord(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<BitableRecord> {
    const data = await this.request<{ record?: BitableRecord }>(
      'POST',
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      { fields }
    );
    return data.record ?? {};
  }

  async updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<BitableRecord> {
    const data = await this.request<{ record?: BitableRecord }>(
      'PUT',
      `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
      { fields }
    );
    return data.record ?? {};
  }
}
