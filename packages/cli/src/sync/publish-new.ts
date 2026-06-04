import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFeishuTarget } from '../core/doc-id.js';
import { hashBlocks, hashSource } from '../core/hash.js';
import type { FeishuBlock, FeishuDocClient, FeishuDriveFile } from '../feishu/types.js';
import { createMarkdownEngine, type MarkdownEngine } from '../markdown/engine.js';
import { applyPublishTransform, type PublishTransformOptions } from '../markdown/publish-transform.js';
import { receiptPathFor, writeReceipt, type SyncReceipt } from '../receipts/receipt.js';
import { comparableDirectChildBlocks, findPageBlock } from './block-state.js';
import { assertFeishuBlocksWritable } from './preflight.js';
import {
  buildPublishNewPlan,
  duplicateTitleError,
  resolvePublishDestination,
  resolvePublishTitle,
  type PublishDuplicateCandidate,
  type PublishNewPlan
} from './publish-new-plan.js';

export type PublishNewClient = FeishuDocClient & {
  createDocxDocument(title: string, folderToken?: string): Promise<FeishuDriveFile>;
  listFolder?(folderToken: string, type?: string): Promise<FeishuDriveFile[]>;
  listWikiChildren?(spaceId: string, parentNodeToken: string): Promise<PublishWikiNode[]>;
  getWikiNode?(wikiNodeToken: string): Promise<PublishWikiNode>;
  moveDocxToWiki?(input: {
    documentId: string;
    spaceId: string;
    parentNodeToken: string;
  }): Promise<PublishWikiMoveResult>;
};

export type PublishWikiNode = {
  title?: string;
  spaceId?: string;
  nodeToken?: string;
  objToken?: string;
  url?: string;
};

export type PublishWikiMoveResult = {
  nodeToken?: string;
  url?: string;
  taskId?: string;
};

export type PublishNewOptions = {
  sourcePath: string;
  rootDir?: string;
  receiptDir?: string;
  options: {
    title?: string;
    folderToken?: string;
    appOwned?: boolean;
    wikiSpaceId?: string;
    wikiSpaceIdSource?: string;
    wikiParent?: string;
    allowDuplicateTitle?: boolean;
  };
  env?: NodeJS.ProcessEnv;
  write?: boolean;
  yes?: boolean;
  publishTransform?: PublishTransformOptions;
  markdownEngine?: MarkdownEngine;
  confirm?: (question: string) => Promise<boolean>;
};

export type PublishNewRunResult = {
  mode: 'dry-run' | 'write';
  plan: PublishNewPlan;
  markdownEngineWarnings: string[];
  receiptPath: string;
  receiptWritten: boolean;
  document?: {
    documentId: string;
    docxUrl?: string;
    wikiUrl?: string;
    wikiNodeToken?: string;
    publishedUrl?: string;
  };
  verification: {
    ok: boolean;
    expectedHash: string;
    actualHash: string;
  };
};

export class PublishNewPartialFailureError extends Error {
  constructor(input: {
    documentId: string;
    docxUrl?: string;
    failedStep: string;
    cause: Error;
  }) {
    super([
      'A Feishu docx was created, but publish-new failed before verification finished.',
      '',
      `Created docx: ${input.docxUrl ?? input.documentId}`,
      `Failed step: ${input.failedStep}`,
      `Reason: ${input.cause.message}`,
      '',
      'Receipt: not written.',
      '',
      guidanceForPartialFailure(input.failedStep),
      '',
      'Nothing was rolled back automatically. Inspect the created docx before retrying.'
    ].join('\n'));
    this.name = 'PublishNewPartialFailureError';
  }
}

function guidanceForPartialFailure(failedStep: string): string {
  if (failedStep === 'move to wiki') {
    return 'Fix the destination parent node permission, or move the created docx manually before retrying.';
  }
  return 'Fix the failed step before retrying.';
}

export async function runPublishNew(client: PublishNewClient, input: PublishNewOptions): Promise<PublishNewRunResult> {
  const rootDir = input.rootDir ?? process.cwd();
  const absoluteSourcePath = path.resolve(input.sourcePath);
  const sourceContent = await readFile(absoluteSourcePath, 'utf8');
  const transformedSourceContent = applyPublishTransform(sourceContent, input.publishTransform);
  const publishOptions = await resolvePublishOptions(client, input.options, input.env ?? process.env);
  resolvePublishDestination({
    sourcePath: absoluteSourcePath,
    options: publishOptions,
    env: input.env ?? process.env
  });
  const markdownEngine = input.markdownEngine ?? createMarkdownEngine({ mode: 'local' });
  const imported = await markdownEngine.importMarkdown({ markdown: transformedSourceContent });
  const desiredBlocks = imported.blocks;
  assertFeishuBlocksWritable(desiredBlocks);

  const title = resolvePublishTitle({
    sourcePath: absoluteSourcePath,
    markdown: transformedSourceContent,
    title: publishOptions.title
  }).title;
  const duplicateCandidates = await findDuplicateCandidates(client, {
    title,
    sourcePath: absoluteSourcePath,
    markdown: transformedSourceContent,
    blockCount: desiredBlocks.length,
    options: publishOptions,
    env: input.env ?? process.env
  });
  const dryRunReceiptPath = receiptPathFor(rootDir, input.receiptDir, absoluteSourcePath, '<new-doc-id>');
  const plan = buildPublishNewPlan({
    sourcePath: absoluteSourcePath,
    markdown: transformedSourceContent,
    blockCount: desiredBlocks.length,
    receiptPath: dryRunReceiptPath,
    duplicateCandidates,
    options: publishOptions,
    env: input.env ?? process.env
  });

  if (duplicateCandidates.length > 0 && !publishOptions.allowDuplicateTitle) {
    throw duplicateTitleError(absoluteSourcePath, plan.title, duplicateCandidates);
  }

  const expectedHash = hashBlocks(desiredBlocks);
  if (!input.write) {
    return {
      mode: 'dry-run',
      plan,
      markdownEngineWarnings: imported.warnings,
      receiptPath: dryRunReceiptPath,
      receiptWritten: false,
      verification: {
        ok: true,
        expectedHash,
        actualHash: expectedHash
      }
    };
  }

  if (!input.yes) {
    const confirm = input.confirm;
    if (!confirm) {
      throw new Error('Publish-new write mode requires --yes or an interactive confirmation callback.');
    }
    const accepted = await confirm(`Create a new Feishu document named "${plan.title}"?`);
    if (!accepted) throw new Error('Publish-new cancelled.');
  }

  const createdDocument = await client.createDocxDocument(
    plan.title,
    plan.destination.kind === 'app-owned' ? undefined : plan.destination.folderToken
  );
  const documentId = createdDocument.document_id ?? createdDocument.token ?? createdDocument.obj_token;
  if (!documentId) {
    throw new Error('Feishu docx creation did not return a document id.');
  }
  const docxUrl = stringValue(createdDocument.url) ?? fallbackDocxUrl(documentId, input.env ?? process.env);
  const writeReceiptPath = receiptPathFor(rootDir, input.receiptDir, absoluteSourcePath, documentId);
  const writePlan: PublishNewPlan = { ...plan, receiptPath: writeReceiptPath };

  let failedStep = 'write blocks';
  try {
    const createdBlocks = await writeInitialBlocks(client, documentId, desiredBlocks);
    let wikiUrl: string | undefined;
    let wikiNodeToken: string | undefined;
    if (writePlan.destination.kind === 'wiki') {
      if (!client.moveDocxToWiki) {
        throw new Error('Feishu client does not support moving docx documents into wiki.');
      }
      failedStep = 'move to wiki';
      const moved = await client.moveDocxToWiki({
        documentId,
        spaceId: writePlan.destination.spaceId,
        parentNodeToken: writePlan.destination.parentNodeToken
      });
      wikiUrl = moved.url;
      wikiNodeToken = moved.nodeToken;
      if (!wikiNodeToken || !wikiUrl) {
        const resolved = await resolveMovedWikiNode(client, {
          documentId,
          title: writePlan.title,
          spaceId: writePlan.destination.spaceId,
          parentNodeToken: writePlan.destination.parentNodeToken,
          env: input.env ?? process.env
        });
        wikiNodeToken = wikiNodeToken ?? resolved.nodeToken;
        wikiUrl = wikiUrl ?? resolved.url;
      }
    }

    failedStep = 'verify readback';
    const readbackBlocks = await client.getDocumentBlocks(documentId);
    const readbackPage = findPageBlock(readbackBlocks, documentId);
    const readbackChildren = comparableDirectChildBlocks(readbackBlocks, readbackPage);
    const actualHash = hashBlocks(readbackChildren);
    if (actualHash !== expectedHash) {
      throw new Error(`Verification mismatch after publish-new. Expected ${expectedHash}, got ${actualHash}.`);
    }
    const exported = await markdownEngine.exportMarkdown({
      documentId,
      fallbackBlocks: readbackChildren
    });
    const receipt: SyncReceipt = {
      sourcePath: absoluteSourcePath,
      sourceHash: hashSource(transformedSourceContent),
      sourceSnapshot: transformedSourceContent,
      feishuDocId: documentId,
      feishuStateHash: actualHash,
      feishuMarkdownSnapshot: exported.markdown,
      timestamp: new Date().toISOString(),
      blockCounts: {
        source: desiredBlocks.length,
        feishuBefore: 0,
        feishuAfter: readbackChildren.length
      },
      warnings: [...imported.warnings, ...exported.warnings],
      writeResult: {
        mode: 'write',
        deleted: 0,
        created: createdBlocks.length,
        skipped: false
      },
      verificationResult: {
        ok: true,
        expectedHash,
        actualHash
      },
      publish: {
        workflow: 'publish-new',
        title: writePlan.title,
        documentUrl: docxUrl,
        wikiUrl,
        wikiNodeToken,
        destination: writePlan.destination,
        creationStrategy: writePlan.creationStrategy
      }
    };
    failedStep = 'write receipt';
    await writeReceipt(writeReceiptPath, receipt);

    return {
      mode: 'write',
      plan: writePlan,
      markdownEngineWarnings: imported.warnings,
      receiptPath: writeReceiptPath,
      receiptWritten: true,
      document: {
        documentId,
        docxUrl,
        wikiUrl,
        wikiNodeToken,
        publishedUrl: wikiUrl ?? docxUrl
      },
      verification: {
        ok: true,
        expectedHash,
        actualHash
      }
    };
  } catch (error) {
    throw new PublishNewPartialFailureError({
      documentId,
      docxUrl,
      failedStep,
      cause: error as Error
    });
  }
}

async function resolvePublishOptions(
  client: PublishNewClient,
  options: PublishNewOptions['options'],
  env: NodeJS.ProcessEnv
): Promise<PublishNewOptions['options']> {
  if (clean(options.wikiSpaceId) || clean(env.FEISHU_PUBLISH_SPACE_ID)) return options;

  const wikiParent = clean(options.wikiParent) ?? clean(env.FEISHU_PUBLISH_PARENT_NODE_TOKEN);
  if (!wikiParent || !client.getWikiNode) return options;

  const parentNodeToken = wikiParentToken(wikiParent);
  const node = await client.getWikiNode(parentNodeToken);
  if (!node.spaceId) return options;

  return {
    ...options,
    wikiSpaceId: node.spaceId,
    wikiSpaceIdSource: 'resolved from wiki parent'
  };
}

async function writeInitialBlocks(
  client: PublishNewClient,
  documentId: string,
  desiredBlocks: FeishuBlock[]
): Promise<FeishuBlock[]> {
  const initialBlocks = await client.getDocumentBlocks(documentId);
  const pageBlock = findPageBlock(initialBlocks, documentId);
  const createdBlocks = await client.createChildren(documentId, pageBlock.block_id, desiredBlocks);
  if (createdBlocks.length < desiredBlocks.length) {
    throw new Error(`Feishu created ${createdBlocks.length} of ${desiredBlocks.length} initial blocks.`);
  }
  return createdBlocks;
}

async function resolveMovedWikiNode(
  client: PublishNewClient,
  input: {
    documentId: string;
    title: string;
    spaceId: string;
    parentNodeToken: string;
    env: NodeJS.ProcessEnv;
  }
): Promise<{ nodeToken?: string; url?: string }> {
  if (!client.listWikiChildren) return {};

  const nodes = await client.listWikiChildren(input.spaceId, input.parentNodeToken);
  const match = nodes.find((node) => node.objToken === input.documentId) ??
    nodes.find((node) => node.title === input.title);
  const nodeToken = match?.nodeToken;
  return {
    nodeToken,
    url: match?.url ?? (nodeToken ? fallbackWikiUrl(nodeToken, input.env) : undefined)
  };
}

async function findDuplicateCandidates(
  client: PublishNewClient,
  input: Parameters<typeof buildPublishNewPlan>[0] & { title: string }
): Promise<PublishDuplicateCandidate[]> {
  const destination = buildPublishNewPlan(input).destination;
  if (destination.kind === 'folder') {
    const files = client.listFolder ? await client.listFolder(destination.folderToken, 'docx') : [];
    return files
      .filter((file) => titleOf(file) === input.title)
      .map((file) => ({
        title: titleOf(file) ?? input.title,
        url: stringValue(file.url),
        token: stringValue(file.document_id ?? file.token ?? file.obj_token)
      }));
  }

  if (destination.kind === 'app-owned') {
    return [];
  }

  const nodes = client.listWikiChildren
    ? await client.listWikiChildren(destination.spaceId, destination.parentNodeToken)
    : [];
  return nodes
    .filter((node) => node.title === input.title)
    .map((node) => ({
      title: node.title ?? input.title,
      url: node.url,
      token: node.nodeToken ?? node.objToken
    }));
}

function titleOf(file: FeishuDriveFile): string | undefined {
  return stringValue(file.name ?? file.title);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function wikiParentToken(value: string): string {
  if (!value.startsWith('http://') && !value.startsWith('https://')) return value;
  const target = parseFeishuTarget(value);
  if (target.kind !== 'wiki') {
    throw new Error(`--wiki-parent must be a wiki node token or wiki URL, got ${value}`);
  }
  return target.token;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fallbackDocxUrl(documentId: string, env: NodeJS.ProcessEnv): string | undefined {
  const baseUrl = stringValue(env.FEISHU_WEB_BASE_URL)?.replace(/\/+$/, '');
  return baseUrl ? `${baseUrl}/docx/${documentId}` : undefined;
}

function fallbackWikiUrl(nodeToken: string, env: NodeJS.ProcessEnv): string | undefined {
  const baseUrl = stringValue(env.FEISHU_WEB_BASE_URL)?.replace(/\/+$/, '');
  return baseUrl ? `${baseUrl}/wiki/${nodeToken}` : undefined;
}
