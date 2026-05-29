export type FeishuWikiNode = {
  space_id?: string;
  title?: string;
  node_token?: string;
  obj_token?: string;
  obj_type?: string;
  url?: string;
  [key: string]: unknown;
};

export type FeishuWikiMoveResult = {
  nodeToken?: string;
  url?: string;
  taskId?: string;
};

export class FeishuWikiClient {
  constructor(private readonly request: <T>(method: string, path: string, body?: unknown) => Promise<T>) {}

  async getNode(token: string): Promise<FeishuWikiNode> {
    const params = new URLSearchParams({ token });
    const data = await this.request<{ node?: FeishuWikiNode }>(
      'GET',
      `/open-apis/wiki/v2/spaces/get_node?${params.toString()}`
    );
    return data.node ?? {};
  }

  async moveDocxToWiki(input: {
    documentId: string;
    spaceId: string;
    parentNodeToken: string;
  }): Promise<FeishuWikiMoveResult> {
    const data = await this.request<{
      node?: FeishuWikiNode;
      task?: { task_id?: string };
      task_id?: string;
    }>(
      'POST',
      `/open-apis/wiki/v2/spaces/${input.spaceId}/nodes/move_docs_to_wiki`,
      {
        obj_token: input.documentId,
        obj_type: 'docx',
        parent_wiki_token: input.parentNodeToken
      }
    );
    return {
      nodeToken: data.node?.node_token,
      url: data.node?.url,
      taskId: data.task?.task_id ?? data.task_id
    };
  }

  async listChildrenPage(spaceId: string, parentNodeToken: string, pageToken?: string): Promise<{
    items?: FeishuWikiNode[];
    has_more?: boolean;
    page_token?: string;
  }> {
    const params = new URLSearchParams({
      page_size: '50',
      parent_node_token: parentNodeToken
    });
    if (pageToken) params.set('page_token', pageToken);
    return this.request('GET', `/open-apis/wiki/v2/spaces/${spaceId}/nodes?${params.toString()}`);
  }
}
