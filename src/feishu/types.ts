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
  text_run: {
    content: string;
    text_element_style: TextElementStyle;
  };
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

export type WriteResult = {
  deleted: number;
  created: number;
  skipped: boolean;
};

export interface FeishuDocClient {
  getDocumentBlocks(documentId: string): Promise<FeishuBlock[]>;
  deleteChildren(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
  createChildren(documentId: string, parentBlockId: string, blocks: FeishuBlock[]): Promise<FeishuBlock[]>;
}
