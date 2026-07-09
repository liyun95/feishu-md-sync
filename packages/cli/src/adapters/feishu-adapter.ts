export type RemoteMarkdown = {
  markdown: string;
  revision?: string;
};

export type FeishuAdapter = {
  fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown>;
  replaceDocument(input: { doc: string; markdown: string }): Promise<void>;
};
