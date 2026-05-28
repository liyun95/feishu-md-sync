export type TextElementStyle = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inline_code?: boolean;
  background_color?: number;
  link?: { url: string };
};

export type TextElement = {
  text_run?: {
    content: string;
    text_element_style: TextElementStyle;
  };
  mention_doc?: {
    title?: string;
    url?: string;
    token?: string;
    obj_type?: number;
    text_element_style?: TextElementStyle;
  };
  [key: string]: unknown;
};

export type FeishuBlock = {
  block_id?: string;
  block_type: number;
  children?: string[] | FeishuBlock[];
  [key: string]: unknown;
};

export type FeishuBlocksState = {
  documentId: string;
  blocks: FeishuBlock[];
};

export type FeishuBlockUpdateRequest = {
  block_id: string;
  update_text_elements?: {
    elements: TextElement[];
  };
  update_text_style?: {
    fields: string;
    style: {
      language?: number;
    };
  };
};

export type WriteResult = {
  deleted: number;
  created: number;
  updated?: number;
  skipped: boolean;
};

export type FeishuDriveFile = {
  token?: string;
  document_id?: string;
  obj_token?: string;
  revision_id?: number;
  name?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

export type BitableTable = {
  table_id?: string;
  name?: string;
  [key: string]: unknown;
};

export type BitableField = {
  field_id?: string;
  field_name?: string;
  type?: number;
  [key: string]: unknown;
};

export type BitableRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface FeishuDocClient {
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
  deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
  createChildren(
    documentId: string,
    parentBlockId: string,
    blocks: FeishuBlock[],
    options?: { index?: number }
  ): Promise<FeishuBlock[]>;
  batchUpdateBlocks?(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
}
