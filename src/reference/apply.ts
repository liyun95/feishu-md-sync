import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from '../core/hash.js';
import type { BitableRecord, FeishuBlock, FeishuDriveFile } from '../feishu/types.js';
import { markdownToFeishuBlocks } from '../markdown/blocks.js';
import { directChildBlocks, findPageBlock } from '../sync/block-state.js';
import { loadReferenceManifest, type ReferenceAction, type ReferenceManifest } from './manifest.js';

export type ReferenceApplyClient = {
  getDocumentBlocks?(documentId: string): Promise<FeishuBlock[]>;
  deleteChildren?(documentId: string, parentBlockId: string, startIndex: number, endIndex: number): Promise<void>;
  createDocxDocument?(title: string, folderToken: string): Promise<FeishuDriveFile>;
  createChildren?(documentId: string, parentBlockId: string, blocks: FeishuBlock[]): Promise<FeishuBlock[]>;
  copyFile?(token: string, targetFolderToken: string, name?: string, type?: string): Promise<FeishuDriveFile>;
  createBitableRecord?(appToken: string, tableId: string, fields: Record<string, unknown>): Promise<BitableRecord>;
  updateBitableRecord?(
    appToken: string,
    tableId: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<BitableRecord>;
};

export type ReferenceApplyReport = {
  mode: 'dry-run' | 'write';
  sdk: string;
  versionRange?: string;
  createdDocs: Array<{
    actionId: string;
    documentId?: string;
    url?: string;
    folderToken?: string;
    contentHash?: string;
  }>;
  patchedDocs: Array<{
    actionId: string;
    documentId?: string;
    contentHash?: string;
  }>;
  copiedDocs: Array<{
    actionId: string;
    sourceDocToken?: string;
    documentId?: string;
    url?: string;
  }>;
  records: Array<{
    actionId: string;
    operation: 'createRecord' | 'updateRecord';
    bitableToken?: string;
    tableId?: string;
    recordId?: string;
  }>;
  trackerRows: Array<{
    actionId: string;
    operation: 'createRecord' | 'updateRecord';
    baseToken?: string;
    tableName?: string;
    recordId?: string;
  }>;
  postActions: Array<{
    name: string;
    status: 'skipped';
    reason: string;
  }>;
  failed: Array<{
    actionId: string;
    action: string;
    message: string;
  }>;
};

type ApplyContext = {
  manifest: ReferenceManifest;
  manifestDir: string;
  activeDocId?: string;
  createdDocUrl?: string;
  copiedDocUrl?: string;
};

export async function applyReferenceManifest(
  client: ReferenceApplyClient,
  options: { manifestPath: string; write: boolean }
): Promise<ReferenceApplyReport> {
  const manifest = await loadReferenceManifest(options.manifestPath);
  const report: ReferenceApplyReport = {
    mode: options.write ? 'write' : 'dry-run',
    sdk: manifest.sdk,
    versionRange: manifest.versionRange,
    createdDocs: [],
    patchedDocs: [],
    copiedDocs: [],
    records: [],
    trackerRows: [],
    postActions: (manifest.postActions ?? []).map((action) => ({
      name: action.name,
      status: 'skipped',
      reason: options.write ? 'post-action execution is not enabled in V1 apply' : 'dry-run'
    })),
    failed: []
  };
  const context: ApplyContext = {
    manifest,
    manifestDir: dirname(resolve(options.manifestPath))
  };

  for (const action of manifest.actions) {
    await applyAction(client, action, options.write, report, context, action.id ?? action.action);
  }

  return report;
}

async function applyAction(
  client: ReferenceApplyClient,
  action: ReferenceAction,
  write: boolean,
  report: ReferenceApplyReport,
  context: ApplyContext,
  actionId: string
): Promise<void> {
  try {
    if (action.action === 'createDoc') {
      const markdown = await markdownForAction(action, context.manifestDir);
      let created: FeishuDriveFile = {};
      if (write) {
        created = await mustBind(client, client.createDocxDocument, 'createDocxDocument')(
          action.title ?? action.id ?? 'Untitled',
          action.folderToken ?? ''
        );
        const docId = docToken(created);
        if (docId && client.createChildren) {
          await client.createChildren(docId, docId, markdownToFeishuBlocks(markdown));
        }
      }
      const documentId = write ? docToken(created) : undefined;
      const url = write ? docUrl(created) : undefined;
      context.activeDocId = documentId;
      context.createdDocUrl = url;
      report.createdDocs.push({
        actionId,
        documentId,
        url,
        folderToken: action.folderToken,
        contentHash: `sha256:${sha256(markdown)}`
      });
      if (action.record) {
        await writeRecord(client, action.record, write, report, context, actionId, 'createRecord');
      }
      if (action.tracker) {
        await writeTracker(client, action, write, report, context, actionId);
      }
      return;
    }

    if (action.action === 'copyDoc') {
      let copied: FeishuDriveFile = {};
      if (write) {
        copied = await mustBind(client, client.copyFile, 'copyFile')(
          action.sourceDocToken ?? '',
          action.targetFolderToken ?? action.folderToken ?? '',
          action.title,
          'docx'
        );
      }
      const documentId = write ? docToken(copied) : undefined;
      const url = write ? docUrl(copied) : undefined;
      context.activeDocId = documentId;
      context.copiedDocUrl = url;
      report.copiedDocs.push({
        actionId,
        sourceDocToken: action.sourceDocToken,
        documentId,
        url
      });
      for (const child of action.then ?? []) {
        await applyAction(client, child, write, report, context, actionId);
      }
      return;
    }

    if (action.action === 'patchDoc') {
      const markdown = await markdownForAction(action, context.manifestDir);
      const documentId = action.documentId ?? context.activeDocId;
      if (write && documentId) {
        await replaceDocumentContent(client, documentId, markdownToFeishuBlocks(markdown));
      }
      report.patchedDocs.push({
        actionId,
        documentId,
        contentHash: `sha256:${sha256(markdown)}`
      });
      return;
    }

    if (action.action === 'createRecord') {
      await writeRecord(client, action, write, report, context, actionId, 'createRecord');
      return;
    }

    if (action.action === 'updateRecord') {
      await writeRecord(client, action, write, report, context, actionId, 'updateRecord');
      return;
    }

    throw new Error(`Unsupported reference action in apply: ${String(action.action)}`);
  } catch (error) {
    report.failed.push({
      actionId,
      action: action.action,
      message: (error as Error).message
    });
  }
}

async function writeRecord(
  client: ReferenceApplyClient,
  action: Pick<ReferenceAction, 'bitableToken' | 'tableId' | 'recordId' | 'fields'>,
  write: boolean,
  report: ReferenceApplyReport,
  context: ApplyContext,
  actionId: string,
  operation: 'createRecord' | 'updateRecord'
): Promise<void> {
  const fields = resolveFields(action.fields ?? {}, context);
  let recordId = action.recordId;
  if (write && operation === 'createRecord') {
    const record = await mustBind(client, client.createBitableRecord, 'createBitableRecord')(
      action.bitableToken ?? '',
      action.tableId ?? '',
      fields
    );
    recordId = record.record_id;
  }
  if (write && operation === 'updateRecord') {
    const record = await mustBind(client, client.updateBitableRecord, 'updateBitableRecord')(
      action.bitableToken ?? '',
      action.tableId ?? '',
      action.recordId ?? '',
      fields
    );
    recordId = record.record_id ?? recordId;
  }
  report.records.push({
    actionId,
    operation,
    bitableToken: action.bitableToken,
    tableId: action.tableId,
    recordId
  });
}

async function writeTracker(
  client: ReferenceApplyClient,
  action: ReferenceAction,
  write: boolean,
  report: ReferenceApplyReport,
  context: ApplyContext,
  actionId: string
): Promise<void> {
  const baseToken = action.tracker?.baseToken ?? context.manifest.targets?.releaseAuditBaseToken;
  const tableName = action.tracker?.tableName ?? context.manifest.targets?.releaseAuditTableName;
  const fields = resolveFields(action.tracker?.fields ?? {}, context);
  let recordId: string | undefined;

  if (write) {
    const record = await mustBind(client, client.createBitableRecord, 'createBitableRecord')(
      baseToken ?? '',
      tableName ?? '',
      fields
    );
    recordId = record.record_id;
  }

  report.trackerRows.push({
    actionId,
    operation: 'createRecord',
    baseToken,
    tableName,
    recordId
  });
}

async function replaceDocumentContent(
  client: ReferenceApplyClient,
  documentId: string,
  blocks: FeishuBlock[]
): Promise<void> {
  const getDocumentBlocks = mustBind(client, client.getDocumentBlocks, 'getDocumentBlocks');
  const deleteChildren = mustBind(client, client.deleteChildren, 'deleteChildren');
  const createChildren = mustBind(client, client.createChildren, 'createChildren');
  const existingBlocks = await getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(existingBlocks, documentId);
  const currentChildren = directChildBlocks(existingBlocks, pageBlock);

  if (currentChildren.length > 0) {
    await deleteChildren(documentId, pageBlock.block_id, 0, currentChildren.length);
  }
  if (blocks.length > 0) {
    await createChildren(documentId, pageBlock.block_id, blocks);
  }
}

function resolveFields(fields: Record<string, unknown>, context: ApplyContext): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, resolveFieldValue(value, context)]));
}

function resolveFieldValue(value: unknown, context: ApplyContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveFieldValue(item, context));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.fromCreatedDoc === true) {
    return { text: record.text ?? 'Document', link: context.createdDocUrl };
  }
  if (record.fromCopiedDoc === true) {
    return { text: record.text ?? 'Document', link: context.copiedDocUrl };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, resolveFieldValue(child, context)]));
}

async function markdownForAction(action: ReferenceAction, manifestDir: string): Promise<string> {
  if (!action.markdownFile) return '';
  return readFile(resolve(manifestDir, action.markdownFile), 'utf8');
}

function docToken(file: FeishuDriveFile): string | undefined {
  const token = file.token ?? file.document_id ?? file.obj_token;
  return typeof token === 'string' ? token : undefined;
}

function docUrl(file: FeishuDriveFile): string | undefined {
  if (typeof file.url === 'string') return file.url;
  const token = docToken(file);
  return token ? `https://zilliverse.feishu.cn/docx/${token}` : undefined;
}

function mustBind<T extends (...args: any[]) => any>(target: unknown, fn: T | undefined, name: string): T {
  if (!fn) throw new Error(`Reference apply client does not implement ${name}.`);
  return fn.bind(target) as T;
}
