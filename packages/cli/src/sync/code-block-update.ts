import type { FeishuBlock, FeishuBlockUpdateRequest, TextElement } from '../feishu/types.js';
import { sha256 } from '../core/hash.js';

export type CodeBlockUpdateClient = {
  batchUpdateBlocks(documentId: string, requests: FeishuBlockUpdateRequest[]): Promise<FeishuBlock[]>;
};

export type UpdateCodeBlockOptions = {
  documentId: string;
  blockId: string;
  content: string;
  language: string;
  dryRun?: boolean;
};

export type UpdateCodeBlockResult = {
  documentId: string;
  blockId: string;
  request: FeishuBlockUpdateRequest;
  mode: 'dry-run' | 'write';
  updatedBlocks: FeishuBlock[];
  contentHash: string;
};

export function buildCodeBlockUpdateRequest(blockId: string, content: string, language: string): FeishuBlockUpdateRequest {
  void language;
  return {
    block_id: blockId,
    update_text_elements: {
      elements: [plainTextElement(content)]
    }
  };
}

export async function updateCodeBlock(
  client: CodeBlockUpdateClient,
  options: UpdateCodeBlockOptions
): Promise<UpdateCodeBlockResult> {
  const request = buildCodeBlockUpdateRequest(options.blockId, options.content, options.language);
  const mode = options.dryRun === false ? 'write' : 'dry-run';
  const updatedBlocks = mode === 'write'
    ? await client.batchUpdateBlocks(options.documentId, [request])
    : [];

  return {
    documentId: options.documentId,
    blockId: options.blockId,
    request,
    mode,
    updatedBlocks,
    contentHash: `sha256:${sha256(options.content)}`
  };
}

function plainTextElement(content: string): TextElement {
  return {
    text_run: {
      content,
      text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false
      }
    }
  };
}
