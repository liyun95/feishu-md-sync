import type { FeishuBlock } from '../feishu/types.js';
import type { PublishReceiptTarget } from '../receipts/publish-receipt.js';

export type RemoteMarkdown = {
  markdown: string;
  revision?: string;
};

export type RemoteBlocks = {
  blocks: FeishuBlock[];
};

export type CreatedDocument = {
  documentId: string;
  url?: string;
  revision?: string;
};

export type CreatedWhiteboard = {
  blockId: string;
  whiteboardToken: string;
};

export type RemoteWhiteboard = {
  raw: unknown;
};

export type FeishuAdapter = {
  resolveDocumentId?(input: { target: PublishReceiptTarget }): Promise<string>;
  fetchDocMarkdown(input: { doc: string }): Promise<RemoteMarkdown>;
  fetchDocBlocks?(input: { doc: string }): Promise<RemoteBlocks>;
  replaceDocument(input: { doc: string; markdown: string }): Promise<void>;
  replaceBlock?(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<void>;
  insertBlocksAfter?(input: {
    doc: string;
    blockId: string;
    content: string;
    format: 'markdown' | 'xml';
  }): Promise<void>;
  moveBlocksAfter?(input: {
    doc: string;
    blockId: string;
    sourceBlockIds: string[];
  }): Promise<void>;
  deleteBlocks?(input: { doc: string; blockIds: string[] }): Promise<void>;
  replaceImageWithWhiteboard?(input: {
    doc: string;
    blockId: string;
    svg: string;
  }): Promise<CreatedWhiteboard>;
  queryWhiteboard?(input: { whiteboardToken: string }): Promise<RemoteWhiteboard>;
  updateWhiteboard?(input: {
    whiteboardToken: string;
    svg: string;
    idempotencyToken: string;
  }): Promise<void>;
  createDocument(input: { title: string; markdown: string; parentToken: string }): Promise<CreatedDocument>;
};
