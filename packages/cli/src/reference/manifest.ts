import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type ReferenceActionName =
  | 'createDoc'
  | 'patchDoc'
  | 'copyDoc'
  | 'createRecord'
  | 'updateRecord';

export type ReferenceAction = {
  id?: string;
  action: ReferenceActionName;
  title?: string;
  folderToken?: string;
  targetFolderToken?: string;
  sourceDocToken?: string;
  documentId?: string;
  markdownFile?: string;
  bitableToken?: string;
  tableId?: string;
  tableName?: string;
  recordId?: string;
  fields?: Record<string, unknown>;
  record?: {
    bitableToken?: string;
    tableId?: string;
    fields?: Record<string, unknown>;
  };
  tracker?: {
    baseToken?: string;
    tableName?: string;
    fields?: Record<string, unknown>;
  };
  then?: ReferenceAction[];
  [key: string]: unknown;
};

export type ReferenceManifest = {
  kind: 'sdk-reference-publish-manifest';
  sdk: string;
  versionRange?: string;
  sourceReport?: string;
  targets?: {
    driveRootFolderToken?: string;
    sdkReferenceBitableToken?: string;
    releaseAuditBaseToken?: string;
    releaseAuditTableName?: string;
  };
  actions: ReferenceAction[];
  postActions?: Array<{ name: string; [key: string]: unknown }>;
};

const SUPPORTED_ACTIONS = new Set<ReferenceActionName>([
  'createDoc',
  'patchDoc',
  'copyDoc',
  'createRecord',
  'updateRecord'
]);

export async function loadReferenceManifest(path: string): Promise<ReferenceManifest> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as unknown;
  await validateReferenceManifest(manifest, dirname(resolve(path)));
  return manifest as ReferenceManifest;
}

export async function validateReferenceManifest(value: unknown, baseDir: string): Promise<void> {
  if (!isRecord(value) || value.kind !== 'sdk-reference-publish-manifest') {
    throw new Error('Reference manifest kind must be sdk-reference-publish-manifest.');
  }

  const actions = value.actions;
  if (!Array.isArray(actions)) {
    throw new Error('Reference manifest actions must be an array.');
  }

  let trackerRequested = false;
  for (const action of actions) {
    validateTopLevelAction(action);
    trackerRequested = await validateActionTree(action, baseDir) || trackerRequested;
  }

  const targets = isRecord(value.targets) ? value.targets : {};
  if (trackerRequested && typeof targets.releaseAuditBaseToken !== 'string') {
    throw new Error(
      'Manifest tracker rows require targets.releaseAuditBaseToken. Create or select the shared release audit Base, grant the Feishu app access, then rerun with targets.releaseAuditBaseToken.'
    );
  }
}

function validateTopLevelAction(value: unknown): void {
  if (!isRecord(value)) throw new Error('Manifest action must be an object.');
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error('Every reference manifest action must have a stable id.');
  }
}

async function validateActionTree(value: unknown, baseDir: string): Promise<boolean> {
  if (!isRecord(value)) throw new Error('Manifest action must be an object.');
  if (!isSupportedAction(value.action)) {
    throw new Error(`Unsupported reference action: ${String(value.action)}`);
  }

  validateFields(value.fields);
  if (isRecord(value.record)) validateFields(value.record.fields);
  if (isRecord(value.tracker)) validateFields(value.tracker.fields);

  const markdownFile = value.markdownFile;
  if (typeof markdownFile === 'string') {
    await voidReadableMarkdown(resolve(baseDir, markdownFile));
  }

  let trackerRequested = Boolean(value.tracker);
  if (Array.isArray(value.then)) {
    for (const child of value.then) {
      trackerRequested = await validateActionTree(child, baseDir) || trackerRequested;
    }
  }

  return trackerRequested;
}

function validateFields(fields: unknown): void {
  if (fields === undefined) return;
  if (!isRecord(fields)) throw new Error('fields must be an object.');

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'Slug') {
      throw new Error('Reference publishing must never write the SDK reference Bitable Slug field.');
    }
    validateFieldValue(value);
  }
}

function validateFieldValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) validateFieldValue(item);
    return;
  }
  if (!isRecord(value)) return;

  const urlLike = 'text' in value || 'link' in value || 'fromCreatedDoc' in value || 'fromCopiedDoc' in value;
  if (urlLike) {
    const hasExplicitLink = typeof value.text === 'string' && typeof value.link === 'string';
    const fromCreated = value.fromCreatedDoc === true;
    const fromCopied = value.fromCopiedDoc === true;
    if (!hasExplicitLink && !fromCreated && !fromCopied) {
      throw new Error('URL field objects must use { text, link }, { fromCreatedDoc: true }, or { fromCopiedDoc: true }.');
    }
    return;
  }

  validateFields(value);
}

function isSupportedAction(value: unknown): value is ReferenceActionName {
  return typeof value === 'string' && SUPPORTED_ACTIONS.has(value as ReferenceActionName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function voidReadableMarkdown(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Manifest markdownFile is not readable: ${path}`);
  }
}
