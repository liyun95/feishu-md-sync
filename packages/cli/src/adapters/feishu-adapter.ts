export type RemoteMarkdown = {
  markdown: string;
  revision?: string;
};

export type CreatedDocument = {
  documentId: string;
  url?: string;
  revision?: string;
};

export type FeishuAdapter = {
  fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown>;
  replaceDocument(input: { doc: string; markdown: string }): Promise<void>;
  createDocument(input: { title: string; markdown: string; parentToken: string }): Promise<CreatedDocument>;
};
