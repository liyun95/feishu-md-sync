import {
  canonicalHash,
  EngineExecutionError,
  LarkCliProviderError,
  PartialMutationError,
  providerBlocksToXml,
  type DesiredNode,
  type DesiredListChildNode,
  type DocxTransport,
  type DocumentSnapshot,
  type InlineContent,
  type MutationIntent,
} from 'feishu-docx-engine';
import type { FeishuAdapter } from '../adapters/feishu-adapter.js';
import type { CalloutConfig } from '../config/sync-config.js';
import { CliFailure, type CliFailureType } from '../core/cli-failure.js';
import type { FeishuBlock, TextElement } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import type {
  SemanticCallout,
  SemanticCell,
  SemanticCodeBlock,
  SemanticInline,
  SemanticTable,
} from '../semantic/types.js';
import type { WhiteboardOperation } from '../whiteboards/whiteboard-plan.js';
import { PartialWriteError, type PublishWriteOperationSummary } from './partial-write-error.js';
import type { ScopedPatchOperation } from './scoped-patch-plan.js';

export type ScopedOperationResolution = {
  resolvedParentBlockId?: string;
  resolvedInsertAfterBlockId?: string;
  resolvedInsertBeforeBlockId?: string;
  resolvedRemoteBlockId?: string;
};

const providerRevisionByAdapter = new WeakMap<object, string>();

export function lastDocxEngineProviderRevision(adapter: FeishuAdapter): string | undefined {
  return providerRevisionByAdapter.get(adapter);
}

export function docxTransportForAdapter(
  adapter: FeishuAdapter,
  options: { whiteboardIdempotencyToken?: string } = {},
): DocxTransport {
  return adapter.docxTransport ?? {
    async resolveDocument(selector) {
      if (selector.kind === 'docx') return { documentId: selector.token };
      if (selector.kind === 'wiki' && adapter.resolveDocumentId) {
        return { documentId: await adapter.resolveDocumentId({ target: { kind: 'wiki', token: selector.token } }) };
      }
      if (selector.kind === 'url') {
        const match = selector.url.match(/\/(?:docx|docs)\/([A-Za-z0-9]+)/);
        if (match?.[1]) return { documentId: match[1] };
      }
      throw new Error('Configured Feishu adapter cannot resolve this Docx selector.');
    },
    async fetchBlocks(documentId) {
      if (!adapter.fetchDocBlocks) throw new Error('Configured Feishu adapter cannot fetch Docx blocks.');
      const blocks = await adapter.fetchDocBlocks({ doc: documentId });
      const normalized = blocks.blocks.map(normalizeLegacyProviderBlock);
      return {
        revision: canonicalHash(normalized),
        blocks: normalized,
      };
    },
    async replaceBlock(input) {
      providerRevisionByAdapter.delete(adapter);
      if (input.format === 'xml' && /^<whiteboard\s+type="svg">/.test(input.content) &&
        adapter.replaceImageWithWhiteboard) {
        const svg = input.content.replace(/^<whiteboard\s+type="svg">/, '').replace(/<\/whiteboard>$/, '');
        await adapter.replaceImageWithWhiteboard({
          doc: input.documentId,
          blockId: input.blockId,
          svg,
        });
        return {};
      }
      if (!adapter.replaceBlock) throw new Error('Configured Feishu adapter cannot replace Docx blocks.');
      const result = await adapter.replaceBlock({
        doc: input.documentId,
        blockId: input.blockId,
        ...legacyAdapterMutationPayload(input.content, input.format),
      });
      if (result?.revision !== undefined) providerRevisionByAdapter.set(adapter, result.revision);
      return {};
    },
    async insertAfter(input) {
      providerRevisionByAdapter.delete(adapter);
      if (!adapter.insertBlocksAfter) throw new Error('Configured Feishu adapter cannot insert Docx blocks.');
      const result = await adapter.insertBlocksAfter({
        doc: input.documentId,
        blockId: input.blockId,
        ...legacyAdapterMutationPayload(input.content, input.format),
      });
      if (result?.revision !== undefined) providerRevisionByAdapter.set(adapter, result.revision);
      return {};
    },
    async createChildren(input) {
      if (adapter.createChildBlocks) {
        return adapter.createChildBlocks({
          doc: input.documentId,
          parentBlockId: input.parentBlockId,
          index: input.index,
          blocks: input.blocks,
          clientToken: input.clientToken,
        });
      }
      if (!adapter.fetchDocBlocks || !adapter.insertBlocksAfter || input.blocks.some(hasProviderChildren)) {
        throw new Error('Configured Feishu adapter cannot create Docx child blocks.');
      }
      const before = await adapter.fetchDocBlocks({ doc: input.documentId });
      const parent = before.blocks.find((block) => block.block_id === input.parentBlockId);
      const childIds = Array.isArray(parent?.children)
        ? parent.children.filter((child): child is string => typeof child === 'string')
        : [];
      const anchorBlockId = input.index <= 0
        ? input.parentBlockId
        : childIds[Math.min(input.index, childIds.length) - 1] ?? input.parentBlockId;
      const payload = legacyAdapterMutationPayload(providerBlocksToXml(input.blocks), 'xml');
      await adapter.insertBlocksAfter({
        doc: input.documentId,
        blockId: anchorBlockId,
        ...payload,
      });
      const after = await adapter.fetchDocBlocks({ doc: input.documentId });
      const afterParent = after.blocks.find((block) => block.block_id === input.parentBlockId);
      const afterChildIds = Array.isArray(afterParent?.children)
        ? afterParent.children.filter((child): child is string => typeof child === 'string')
        : [];
      const createdIds = afterChildIds.slice(input.index, input.index + input.blocks.length);
      const createdBlocks = createdIds.flatMap((blockId) => {
        const block = after.blocks.find((candidate) => candidate.block_id === blockId);
        return block ? [block] : [];
      });
      if (createdBlocks.length !== input.blocks.length) {
        throw new Error('Configured Feishu adapter did not expose created Docx child identities.');
      }
      return { blocks: createdBlocks, clientToken: input.clientToken };
    },
    async moveAfter(input) {
      if (!adapter.moveBlocksAfter) throw new Error('Configured Feishu adapter cannot move Docx blocks.');
      await adapter.moveBlocksAfter({
        doc: input.documentId,
        blockId: input.anchorBlockId,
        sourceBlockIds: input.blockIds,
      });
    },
    async deleteBlocks(input) {
      if (!adapter.deleteBlocks) throw new Error('Configured Feishu adapter cannot delete Docx blocks.');
      await adapter.deleteBlocks({ doc: input.documentId, blockIds: input.blockIds });
    },
    async createDocument(input) {
      return adapter.createDocument(input);
    },
    async queryWhiteboard(token) {
      if (!adapter.queryWhiteboard) throw new Error('Configured Feishu adapter cannot query Whiteboards.');
      return (await adapter.queryWhiteboard({ whiteboardToken: token })).raw;
    },
    async overwriteWhiteboard(input) {
      if (!adapter.updateWhiteboard || input.format !== 'svg') {
        throw new Error('Configured Feishu adapter cannot overwrite this Whiteboard payload.');
      }
      await adapter.updateWhiteboard({
        whiteboardToken: input.token,
        svg: input.value,
        idempotencyToken: options.whiteboardIdempotencyToken ?? input.idempotencyToken,
      });
    },
  };
}

function normalizeLegacyProviderBlock<T extends Record<string, unknown>>(block: T): T {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((child) => normalize(child));
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const normalized = Object.fromEntries(Object.entries(record).map(([childKey, child]) => [
      childKey,
      normalize(child),
    ]));
    if ('content' in normalized && 'text_element_style' in normalized) {
      const style = asRecord(normalized.text_element_style) ?? {};
      normalized.text_element_style = {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false,
        ...style,
      };
    }
    return normalized;
  };
  const normalized = normalize(structuredClone(block)) as T;
  if (typeof normalized.block_type === 'number' && normalized.block_type >= 2 && normalized.block_type <= 8) {
    const key = normalized.block_type === 2 ? 'text' : `heading${normalized.block_type - 2}`;
    const payload = asRecord(normalized[key]);
    if (payload) payload.style = { align: 1, ...(asRecord(payload.style) ?? {}) };
  }
  return normalized;
}

function hasProviderChildren(block: { children?: unknown }): boolean {
  return Array.isArray(block.children) && block.children.length > 0;
}

function legacyAdapterMutationPayload(
  content: string,
  format: 'markdown' | 'xml',
): { content: string; format: 'markdown' | 'xml' } {
  if (format !== 'xml' || /^<(?:table|callout|pre|whiteboard)\b/i.test(content) ||
    /^<p>&lt;\/?Procedures&gt;<\/p>$/.test(content)) {
    return { content, format };
  }
  const markdown = ordinaryXmlToMarkdown(content);
  return markdown === undefined
    ? { content, format }
    : { content: markdown, format: 'markdown' };
}

function ordinaryXmlToMarkdown(xml: string): string | undefined {
  const blocks = [...xml.matchAll(/<(p|h[1-6]|blockquote)>([\s\S]*?)<\/\1>/gi)];
  if (blocks.length === 0 || blocks.map((match) => match[0]).join('') !== xml) return undefined;
  return blocks.map((match) => {
    const tag = match[1]!.toLowerCase();
    const body = inlineXmlToMarkdown(match[2] ?? '');
    if (tag === 'p') return body;
    if (tag === 'blockquote') return `> ${body}`;
    return `${'#'.repeat(Number(tag.slice(1)))} ${body}`;
  }).join('\n\n');
}

function inlineXmlToMarkdown(value: string): string {
  return decodeXmlText(value
    .replace(/<br\s*\/>/gi, '\n')
    .replace(/<a\s+href="([^"]*)">([\s\S]*?)<\/a>/gi, (_match, url: string, text: string) =>
      `[${decodeXmlText(text)}](${decodeXmlText(url)})`)
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
    .replace(/<s>([\s\S]*?)<\/s>/gi, '$1'));
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function operationIdForScopedOperation(operation: ScopedPatchOperation): string {
  return `fms:${operation.kind}:${canonicalHash(operation).slice(0, 24)}`;
}

export function operationIdForWhiteboardOperation(operation: WhiteboardOperation): string {
  return `fms:${operation.kind}:${canonicalHash(operation).slice(0, 24)}`;
}

export function scopedOperationToMutationIntents(input: {
  operation: ScopedPatchOperation;
  snapshot: DocumentSnapshot;
  callouts: CalloutConfig;
} & ScopedOperationResolution): MutationIntent[] {
  const operation = input.operation;
  const operationId = operationIdForScopedOperation(operation);
  const targetId = input.resolvedRemoteBlockId ?? remoteBlockId(operation);
  const parentBlockId = input.resolvedParentBlockId ?? operationParent(operation, input.snapshot, targetId);
  const insertAfterBlockId = input.resolvedInsertAfterBlockId ?? operationInsertAfter(operation);
  const insertBeforeBlockId = input.resolvedInsertBeforeBlockId ?? operationInsertBefore(operation);

  switch (operation.kind) {
    case 'update':
    case 'callout-title-update':
    case 'callout-child-update': {
      const desired = singleDesiredNode(operation.desiredMarkdown);
      return [{
        operationId,
        kind: 'replace',
        targetBlockId: requireValue(targetId, `${operation.kind} target block`),
        expectedHash: nodeHash(input.snapshot, requireValue(targetId, `${operation.kind} target block`)),
        desired,
      }];
    }
    case 'create':
      return [insertIntent({
        operationId,
        parentBlockId: requireValue(parentBlockId, 'create parent block'),
        insertAfterBlockId: requireValue(insertAfterBlockId, 'create insertion anchor'),
        insertBeforeBlockId,
        desired: desiredNodesFromMarkdown(operation.desiredMarkdown),
      })];
    case 'delete':
    case 'callout-child-delete':
    case 'callout-delete': {
      const blockIds = [...operation.blockIds];
      return [deleteIntent(operationId, requireValue(parentBlockId, `${operation.kind} parent block`), blockIds, input.snapshot)];
    }
    case 'table-replace':
      return [{
        operationId,
        kind: 'replace',
        targetBlockId: operation.remoteBlockId,
        expectedHash: nodeHash(input.snapshot, operation.remoteBlockId),
        desired: desiredTable(operation.desiredTable),
      }];
    case 'table-create':
      return [insertIntent({
        operationId,
        parentBlockId: operation.parentBlockId,
        insertAfterBlockId: input.resolvedInsertAfterBlockId ?? operation.insertAfterBlockId,
        insertBeforeBlockId: input.resolvedInsertBeforeBlockId ?? operation.insertBeforeBlockId,
        desired: [desiredTable(operation.desiredTable)],
      })];
    case 'callout-create':
      return [insertIntent({
        operationId,
        parentBlockId: operation.parentBlockId,
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Callout insertion anchor'),
        insertBeforeBlockId,
        desired: [desiredCallout(operation.desiredCallout, input.callouts)],
      })];
    case 'callout-child-create':
      return [insertIntent({
        operationId,
        parentBlockId: operation.calloutBlockId,
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Callout child insertion anchor'),
        insertBeforeBlockId,
        desired: desiredNodesFromMarkdown(operation.desiredMarkdown),
      })];
    case 'code-update': {
      const blockId = requireValue(targetId, 'Code update target block');
      return [{
        operationId,
        kind: 'replace',
        targetBlockId: blockId,
        expectedHash: nodeHash(input.snapshot, blockId),
        desired: desiredCode(operation.desiredCode, preservedCodeCaption(input.snapshot, blockId)),
      }];
    }
    case 'code-create':
      return [insertIntent({
        operationId,
        parentBlockId: requireValue(parentBlockId, 'Code create parent block'),
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Code create insertion anchor'),
        insertBeforeBlockId,
        desired: [desiredCode(operation.desiredCode)],
      })];
    case 'code-move': {
      const blockId = requireValue(targetId, 'Code move target block');
      return [{
        operationId,
        kind: 'move',
        parentBlockId: requireValue(parentBlockId, 'Code move parent block'),
        blockIds: [blockId],
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Code move insertion anchor'),
      }];
    }
    case 'code-delete': {
      const blockId = requireValue(targetId, 'Code delete target block');
      return [deleteIntent(operationId, requireValue(parentBlockId, 'Code delete parent block'), [blockId], input.snapshot)];
    }
    case 'code-section-reconcile':
      throw new Error('Code section reconcile must be expanded against the current semantic document before engine translation.');
    case 'authoring-token-create':
      return [insertIntent({
        operationId,
        parentBlockId: operation.parentBlockId,
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Procedures token insertion anchor'),
        insertBeforeBlockId,
        desired: [{ kind: 'paragraph', content: [{ kind: 'text', text: operation.token }] }],
      })];
    case 'authoring-token-move':
      return [{
        operationId,
        kind: 'move',
        parentBlockId: requireValue(parentBlockId, 'Procedures token parent block'),
        blockIds: [operation.remoteBlockId],
        insertAfterBlockId: requireValue(insertAfterBlockId, 'Procedures token insertion anchor'),
      }];
    case 'authoring-token-delete':
      return [deleteIntent(operationId, operation.parentBlockId, [operation.remoteBlockId], input.snapshot)];
  }
}

export function whiteboardOperationToMutationIntent(input: {
  operation: WhiteboardOperation;
  snapshot: DocumentSnapshot;
  svg: string;
}): MutationIntent {
  const targetBlockId = input.operation.kind === 'whiteboard-create'
    ? input.operation.remoteImageBlockId
    : input.operation.blockId;
  return {
    operationId: operationIdForWhiteboardOperation(input.operation),
    kind: 'whiteboard-overwrite',
    targetBlockId,
    ...(input.operation.kind !== 'whiteboard-create'
      ? { targetToken: input.operation.whiteboardToken }
      : {}),
    expectedTargetHash: nodeHash(input.snapshot, targetBlockId),
    desired: { kind: 'svg', value: input.svg },
  };
}

export function enginePartialWriteError<T extends ScopedPatchOperation | WhiteboardOperation>(input: {
  error: PartialMutationError;
  operationsById: ReadonlyMap<string, T>;
  completedOperations: PublishWriteOperationSummary[];
  pendingAfter?: PublishWriteOperationSummary[];
  recoveryCheckpoint?: { written: boolean; revision?: string };
  summarize: (operation: T) => PublishWriteOperationSummary;
  readbackSummary?: PublishWriteOperationSummary;
  unplannedAsCheckpointFailure?: boolean;
  createdSummary?: (
    operation: T,
    createdBlockIds: string[],
  ) => PublishWriteOperationSummary;
  cause?: unknown;
}): PartialWriteError {
  const evidence = input.error.evidence;
  const completed = [...input.completedOperations];
  for (const verified of evidence.completedOperations) {
    const operation = input.operationsById.get(verified.operationId);
    if (operation) appendSummary(completed, input.summarize(operation));
  }
  const failed = input.operationsById.get(evidence.failedOperation.operationId);
  const failedSummary = failed ? input.summarize(failed) : { kind: 'scoped-readback' as const };
  let completedFailedSummary = failedSummary;
  if (evidence.createdBlockIds.length > 0 && failed) {
    if (input.createdSummary) {
      completedFailedSummary = input.createdSummary(failed, [...evidence.createdBlockIds]);
      appendSummary(completed, completedFailedSummary);
    } else if (failedSummary.kind === 'create') {
      completedFailedSummary = {
        ...failedSummary,
        blockIds: [...evidence.createdBlockIds],
        ...(
          'parentBlockId' in failed && typeof failed.parentBlockId === 'string'
            ? { parentBlockId: failed.parentBlockId }
            : {}
        ),
      };
      appendSummary(completed, completedFailedSummary);
    }
  }
  if (evidence.failedOperation.kind === 'journal') appendSummary(completed, completedFailedSummary);
  if (evidence.failedOperation.kind === 'verification' && input.readbackSummary) {
    appendSummary(completed, completedFailedSummary);
  }
  const bridgedCause = bridgeEngineCause(input.error.cause ?? evidence.failedOperation.cause ?? input.error);
  const engineCode = input.error.cause instanceof EngineExecutionError
    ? input.error.cause.code
    : undefined;
  const failedOperation = evidence.failedOperation.kind === 'journal' ||
    (input.unplannedAsCheckpointFailure && engineCode === 'unplanned_remote_change')
    ? { kind: 'receipt-write' as const }
    : (evidence.failedOperation.kind === 'verification' || evidence.createdBlockIds.length > 0) && input.readbackSummary
      ? input.readbackSummary
      : failedSummary;
  const pending = evidence.pendingOperationIds.flatMap((operationId) => {
    const operation = input.operationsById.get(operationId);
    return operation ? [input.summarize(operation)] : [];
  });
  return new PartialWriteError({
    completedOperations: completed,
    failedOperation,
    pendingOperations: [...pending, ...(input.pendingAfter ?? [])],
    recoveryCheckpointWritten: input.recoveryCheckpoint?.written,
    recoveryCheckpointRevision: input.recoveryCheckpoint?.revision,
    cause: input.cause ?? (
      failedOperation.kind === 'scoped-readback'
        ? scopedReadbackCause(bridgedCause)
        : bridgedCause
    ),
  });
}

function scopedReadbackCause(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`scoped readback verification failed: ${message}`) as Error & {
    causeDetails?: unknown;
  };
  if (cause && typeof cause === 'object' && 'details' in cause) {
    error.causeDetails = (cause as { details?: unknown }).details;
  }
  return error;
}

export function bridgeEngineCause(error: unknown): unknown {
  if (error instanceof CliFailure) return error;
  if (error instanceof LarkCliProviderError) {
    const details = error.details;
    return new CliFailure({
      type: mapProviderFailureType(details.type),
      subtype: details.subtype,
      message: details.message,
      hint: details.hint,
      retryable: details.retryable,
      ...(details.providerCode !== undefined ? { providerCode: details.providerCode } : {}),
      ...(details.missingScopes ? { missingScopes: details.missingScopes } : {}),
      ...(details.consoleUrl ? { consoleUrl: details.consoleUrl } : {}),
    }, { cause: error });
  }
  if (error instanceof EngineExecutionError) {
    if (error.cause instanceof CliFailure || error.cause instanceof LarkCliProviderError ||
      error.cause instanceof EngineExecutionError) {
      return bridgeEngineCause(error.cause);
    }
    return new CliFailure({
      type: engineFailureType(error),
      subtype: `docx_engine_${error.code}`,
      message: error.message,
      retryable: false,
    }, { cause: error });
  }
  return error;
}

function desiredNodesFromMarkdown(markdown: string): DesiredNode[] {
  const blocks = markdownToFeishuBlocks(markdown);
  const desired: DesiredNode[] = [];
  for (let index = 0; index < blocks.length;) {
    const block = blocks[index]!;
    if (block.block_type === 12 || block.block_type === 13) {
      const ordered = block.block_type === 13;
      const items: Extract<DesiredNode, { kind: 'list' }>['items'] = [];
      while (index < blocks.length && blocks[index]!.block_type === block.block_type) {
        items.push(desiredListItem(blocks[index]!));
        index += 1;
      }
      desired.push({ kind: 'list', ordered, items });
      continue;
    }
    desired.push(desiredNodeFromBlock(block));
    index += 1;
  }
  if (desired.length === 0) {
    return [{ kind: 'paragraph', content: [{ kind: 'text', text: '' }] }];
  }
  return desired;
}

function singleDesiredNode(markdown: string): DesiredNode {
  const desired = desiredNodesFromMarkdown(markdown);
  if (desired.length !== 1) {
    throw new Error(`Scoped replacement requires exactly one desired Docx node; received ${desired.length}.`);
  }
  return desired[0]!;
}

function desiredNodeFromBlock(block: FeishuBlock): DesiredNode {
  if (block.block_type === 2) return { kind: 'paragraph', content: inlineContent(block, 'text') };
  if (block.block_type >= 3 && block.block_type <= 8) {
    const level = block.block_type - 2 as 1 | 2 | 3 | 4 | 5 | 6;
    return { kind: 'heading', level, content: inlineContent(block, `heading${level}`) };
  }
  if (block.block_type === 12 || block.block_type === 13) {
    return { kind: 'list', ordered: block.block_type === 13, items: [desiredListItem(block)] };
  }
  if (block.block_type === 14) {
    const value = asRecord(block.code);
    const style = asRecord(value?.style);
    return {
      kind: 'code',
      language: String(style?.language ?? 'plaintext'),
      text: textElements(value?.elements).map((element) => element.text_run?.content ?? '').join(''),
      ...(typeof style?.caption === 'string' ? { caption: style.caption } : {}),
    };
  }
  throw new Error(`Markdown produced unsupported Docx block_type ${block.block_type}.`);
}

function desiredListItem(block: FeishuBlock): Extract<DesiredNode, { kind: 'list' }>['items'][number] {
  const key = block.block_type === 13 ? 'ordered' : 'bullet';
  const children = Array.isArray(block.children) ? block.children.filter(isFeishuBlock) : [];
  const desiredChildren: DesiredListChildNode[] = [];
  for (let index = 0; index < children.length;) {
    const child = children[index]!;
    if (child.block_type === 2) {
      desiredChildren.push(desiredNodeFromBlock(child) as Extract<DesiredNode, { kind: 'paragraph' }>);
      index += 1;
      continue;
    }
    if (child.block_type !== 12 && child.block_type !== 13) {
      throw new Error(`Nested list item contains unsupported child block_type ${child.block_type}.`);
    }
    const ordered = child.block_type === 13;
    const items: Extract<DesiredNode, { kind: 'list' }>['items'] = [];
    while (index < children.length && children[index]!.block_type === child.block_type) {
      items.push(desiredListItem(children[index]!));
      index += 1;
    }
    desiredChildren.push({ kind: 'list', ordered, items });
  }
  return { content: inlineContent(block, key), children: desiredChildren };
}

function desiredTable(table: SemanticTable): Extract<DesiredNode, { kind: 'table' }> {
  if (table.unsupported.length > 0) {
    throw new Error(`Cannot translate unsupported table: ${table.unsupported.join('; ')}`);
  }
  return {
    kind: 'table',
    rows: [table.headers, ...table.rows.map((row) => row.cells)].map((cells) => ({
      cells: cells.map((cell) => ({ content: desiredCell(cell) })),
    })),
  };
}

function desiredCell(cell: SemanticCell): DesiredNode[] {
  return cell.blocks.map((block) => block.kind === 'paragraph'
    ? { kind: 'paragraph', content: semanticInlines(block.inlines) }
    : {
        kind: 'list',
        ordered: block.ordered,
        items: block.items.map((item) => ({ content: semanticInlines(item), children: [] })),
      });
}

function desiredCallout(
  callout: SemanticCallout,
  callouts: CalloutConfig,
): Extract<DesiredNode, { kind: 'callout' }> {
  if (callout.unsupported.length > 0) {
    throw new Error(`Cannot translate unsupported Callout content: ${callout.unsupported.join('; ')}`);
  }
  if (!callout.calloutType) throw new Error('Cannot translate a Callout without a known type.');
  const title = callout.titleManaged && callout.title
    ? callout.title.markdown
    : callout.calloutType === 'note' ? callouts.noteTitle : callouts.warningTitle;
  return {
    kind: 'callout',
    calloutType: callout.calloutType,
    title,
    children: callout.children.flatMap((child) => desiredNodesFromMarkdown(child.markdown)),
  };
}

function desiredCode(code: SemanticCodeBlock, preservedCaption?: string): Extract<DesiredNode, { kind: 'code' }> {
  if (code.issues.length > 0) {
    throw new Error(`Cannot translate unsupported Code block: ${code.issues.map((issue) => issue.message).join('; ')}`);
  }
  const caption = code.caption ?? preservedCaption;
  return {
    kind: 'code',
    language: code.resolvedLanguage,
    text: code.content,
    ...(caption !== undefined ? { caption } : {}),
  };
}

function preservedCodeCaption(snapshot: DocumentSnapshot, blockId: string): string | undefined {
  const raw = snapshot.nodes.find((node) => node.blockId === blockId)?.raw;
  const style = asRecord(asRecord(raw?.code)?.style);
  return typeof style?.caption === 'string' ? style.caption : undefined;
}

function inlineContent(block: FeishuBlock, key: string): InlineContent[] {
  const value = asRecord(block[key]);
  return textElements(value?.elements).map((element): InlineContent => {
    const run = element.text_run;
    if (!run) throw new Error('Markdown desired content contains a non-text inline element.');
    const style = run.text_element_style ?? {};
    if (style.link?.url) return { kind: 'link', text: run.content, url: style.link.url };
    if (style.inline_code) return { kind: 'code', text: run.content };
    return {
      kind: 'text',
      text: run.content,
      ...(style.bold ? { bold: true } : {}),
      ...(style.italic ? { italic: true } : {}),
      ...(style.underline ? { underline: true } : {}),
      ...(style.strikethrough ? { strike: true } : {}),
    };
  });
}

function semanticInlines(inlines: SemanticInline[]): InlineContent[] {
  return inlines.map((inline): InlineContent => {
    if (inline.kind === 'break') return { kind: 'text', text: '\n' };
    if (inline.marks?.link) return { kind: 'link', text: inline.value, url: inline.marks.link };
    if (inline.marks?.code) return { kind: 'code', text: inline.value };
    return {
      kind: 'text',
      text: inline.value,
      ...(inline.marks?.bold ? { bold: true } : {}),
      ...(inline.marks?.italic ? { italic: true } : {}),
    };
  });
}

function insertIntent(input: {
  operationId: string;
  parentBlockId: string;
  insertAfterBlockId: string;
  insertBeforeBlockId?: string;
  desired: DesiredNode[];
}): Extract<MutationIntent, { kind: 'insert' }> {
  return {
    operationId: input.operationId,
    kind: 'insert',
    parentBlockId: input.parentBlockId,
    insertAfterBlockId: input.insertAfterBlockId,
    ...(input.insertBeforeBlockId ? { insertBeforeBlockId: input.insertBeforeBlockId } : {}),
    desired: input.desired,
  };
}

function deleteIntent(
  operationId: string,
  parentBlockId: string,
  blockIds: string[],
  snapshot: DocumentSnapshot,
): Extract<MutationIntent, { kind: 'delete' }> {
  return {
    operationId,
    kind: 'delete',
    parentBlockId,
    blockIds,
    expectedHashes: blockIds.map((blockId) => nodeHash(snapshot, blockId)),
  };
}

function remoteBlockId(operation: ScopedPatchOperation): string | undefined {
  return 'remoteBlockId' in operation && typeof operation.remoteBlockId === 'string'
    ? operation.remoteBlockId
    : undefined;
}

function operationParent(
  operation: ScopedPatchOperation,
  snapshot: DocumentSnapshot,
  targetId?: string,
): string | undefined {
  if ('parentBlockId' in operation && typeof operation.parentBlockId === 'string') return operation.parentBlockId;
  if ('calloutBlockId' in operation && operation.kind === 'callout-child-create') return operation.calloutBlockId;
  if ('blockIds' in operation && operation.blockIds.length > 0) {
    return snapshot.nodes.find((node) => node.blockId === operation.blockIds[0])?.parentBlockId;
  }
  return targetId ? snapshot.nodes.find((node) => node.blockId === targetId)?.parentBlockId : undefined;
}

function operationInsertAfter(operation: ScopedPatchOperation): string | undefined {
  return 'insertAfterBlockId' in operation && typeof operation.insertAfterBlockId === 'string'
    ? operation.insertAfterBlockId
    : undefined;
}

function operationInsertBefore(operation: ScopedPatchOperation): string | undefined {
  return 'insertBeforeBlockId' in operation && typeof operation.insertBeforeBlockId === 'string'
    ? operation.insertBeforeBlockId
    : undefined;
}

function nodeHash(snapshot: DocumentSnapshot, blockId: string): string {
  const node = snapshot.nodes.find((candidate) => candidate.blockId === blockId);
  if (!node) throw new Error(`Docx engine snapshot does not contain block ${blockId}.`);
  return node.canonicalHash;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is unresolved.`);
  return value;
}

function textElements(value: unknown): TextElement[] {
  return Array.isArray(value) ? value.filter((item): item is TextElement => Boolean(item && typeof item === 'object')) : [];
}

function isFeishuBlock(value: unknown): value is FeishuBlock {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as { block_type?: unknown }).block_type === 'number');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function appendSummary(
  summaries: PublishWriteOperationSummary[],
  summary: PublishWriteOperationSummary,
): void {
  if (!summaries.some((candidate) => canonicalHash(candidate) === canonicalHash(summary))) {
    summaries.push(summary);
  }
}

function mapProviderFailureType(type: string): CliFailureType {
  if (type === 'authentication') return 'authentication';
  if (type === 'authorization' || type === 'policy') return 'authorization';
  if (type === 'config') return 'config';
  if (type === 'network') return 'network';
  if (type === 'confirmation' || type === 'confirmation_required') return 'confirmation_required';
  if (type === 'validation') return 'validation';
  return 'internal';
}

function engineFailureType(error: EngineExecutionError): CliFailureType {
  if (error.code === 'preflight_assertion_failed' || error.code === 'stale_revision' ||
    error.code === 'stale_snapshot' || error.code === 'unplanned_remote_change') return 'conflict';
  if (error.code === 'readback_assertion_failed' || error.code === 'snapshot_failure') return 'verification';
  return 'internal';
}
