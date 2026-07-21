import type { DocumentSelector } from './model.js';

export interface ProviderBlock {
  block_id?: string;
  parent_id?: string;
  block_type: number;
  children?: string[] | ProviderBlock[];
  [key: string]: unknown;
}

export interface ProviderMutationInput {
  documentId: string;
  blockId: string;
  content: string;
  format: 'markdown' | 'xml';
}

export interface CreateChildrenInput {
  documentId: string;
  parentBlockId: string;
  index: number;
  blocks: ProviderBlock[];
  clientToken: string;
}

export interface ProviderMutationResult {
  revision?: string;
}

export interface CreatedChildrenResult extends ProviderMutationResult {
  blocks: ProviderBlock[];
  clientToken?: string;
}

export interface CreateDocumentInput {
  title: string;
  markdown: string;
  parentToken: string;
}

export interface CreatedDocumentResult extends ProviderMutationResult {
  documentId: string;
  url?: string;
}

export type OverwriteWhiteboardInput =
  | {
      token: string;
      format: 'raw';
      value: unknown;
      idempotencyToken: string;
    }
  | {
      token: string;
      format: 'svg';
      value: string;
      idempotencyToken: string;
    };

export interface DocxTransport {
  resolveDocument(selector: DocumentSelector): Promise<{ documentId: string }>;
  fetchBlocks(documentId: string): Promise<{
    revision: string;
    blocks: ProviderBlock[];
  }>;
  replaceBlock(input: ProviderMutationInput): Promise<ProviderMutationResult>;
  insertAfter(input: ProviderMutationInput): Promise<ProviderMutationResult>;
  createChildren(input: CreateChildrenInput): Promise<CreatedChildrenResult>;
  moveAfter(input: {
    documentId: string;
    anchorBlockId: string;
    blockIds: string[];
  }): Promise<void>;
  deleteBlocks(input: {
    documentId: string;
    blockIds: string[];
  }): Promise<void>;
  createDocument(input: CreateDocumentInput): Promise<CreatedDocumentResult>;
  queryWhiteboard(token: string): Promise<unknown>;
  overwriteWhiteboard(input: OverwriteWhiteboardInput): Promise<void>;
}
