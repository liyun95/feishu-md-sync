import { loadReferenceManifest, type ReferenceAction, type ReferenceManifest } from './manifest.js';
import type { BitableField, BitableRecord, FeishuDriveFile } from '../feishu/types.js';

export type ReferenceAuditClient = {
  listFolder?(folderToken: string, type?: string): Promise<FeishuDriveFile[]>;
  listBitableRecords?(appToken: string, tableId: string): Promise<BitableRecord[]>;
  listBitableFields?(appToken: string, tableId: string): Promise<BitableField[]>;
};

export type ReferenceAuditReport = {
  passed: boolean;
  checked: {
    driveDocs: number;
    bitableRecords: number;
    trackerRows: number;
    postActions: number;
  };
  missingDocs: Array<{ actionId: string; documentId: string }>;
  missingRecords: Array<{ actionId: string; recordId: string }>;
  staleLinks: Array<{ actionId: string; recordId?: string; expectedDocumentId: string; actualLink?: string }>;
  schemaIssues: Array<{ baseToken?: string; tableName?: string; missingField: string }>;
  forbiddenFields: Array<{ actionId: string; field: string }>;
};

const REQUIRED_TRACKER_FIELDS = ['文档/接口', '当前状态'];

export async function auditReferenceManifest(
  client: ReferenceAuditClient,
  options: { manifestPath: string }
): Promise<ReferenceAuditReport> {
  const manifest = await loadReferenceManifest(options.manifestPath);
  const report: ReferenceAuditReport = {
    passed: true,
    checked: {
      driveDocs: 0,
      bitableRecords: 0,
      trackerRows: 0,
      postActions: manifest.postActions?.length ?? 0
    },
    missingDocs: [],
    missingRecords: [],
    staleLinks: [],
    schemaIssues: [],
    forbiddenFields: []
  };
  const driveFiles = client.listFolder && manifest.targets?.driveRootFolderToken
    ? await client.listFolder(manifest.targets.driveRootFolderToken, 'docx')
    : [];
  const recordsByTable = new Map<string, BitableRecord[]>();
  const fieldsByTable = new Map<string, BitableField[]>();

  for (const action of manifest.actions) {
    await auditAction(client, manifest, action, report, driveFiles, recordsByTable, fieldsByTable, action.id ?? action.action);
  }

  report.passed = report.missingDocs.length === 0 &&
    report.missingRecords.length === 0 &&
    report.staleLinks.length === 0 &&
    report.schemaIssues.length === 0 &&
    report.forbiddenFields.length === 0;
  return report;
}

async function auditAction(
  client: ReferenceAuditClient,
  manifest: ReferenceManifest,
  action: ReferenceAction,
  report: ReferenceAuditReport,
  driveFiles: FeishuDriveFile[],
  recordsByTable: Map<string, BitableRecord[]>,
  fieldsByTable: Map<string, BitableField[]>,
  actionId: string
): Promise<void> {
  if (action.documentId) {
    report.checked.driveDocs += 1;
    if (!driveFiles.some((file) => file.token === action.documentId || file.obj_token === action.documentId)) {
      report.missingDocs.push({ actionId, documentId: action.documentId });
    }
  }

  if (action.recordId && action.bitableToken && action.tableId) {
    const records = await tableRecords(client, recordsByTable, action.bitableToken, action.tableId);
    report.checked.bitableRecords += 1;
    const record = records.find((item) => item.record_id === action.recordId);
    if (!record) {
      report.missingRecords.push({ actionId, recordId: action.recordId });
    } else if (action.documentId) {
      const link = firstLink(record.fields);
      if (!link?.includes(action.documentId)) {
        report.staleLinks.push({ actionId, recordId: action.recordId, expectedDocumentId: action.documentId, actualLink: link });
      }
    }
  }

  if (action.tracker) {
    report.checked.trackerRows += 1;
    const baseToken = action.tracker.baseToken ?? manifest.targets?.releaseAuditBaseToken;
    const tableName = action.tracker.tableName ?? manifest.targets?.releaseAuditTableName;
    const key = `${baseToken ?? ''}:${tableName ?? ''}`;
    let fields = fieldsByTable.get(key);
    if (!fields && client.listBitableFields) {
      fields = await client.listBitableFields(baseToken ?? '', tableName ?? '');
      fieldsByTable.set(key, fields);
    }
    const fieldNames = new Set((fields ?? []).map((field) => field.field_name));
    for (const required of REQUIRED_TRACKER_FIELDS) {
      if (!fieldNames.has(required)) {
        report.schemaIssues.push({
          baseToken,
          tableName,
          missingField: required
        });
      }
    }
  }

  for (const child of action.then ?? []) {
    await auditAction(client, manifest, child, report, driveFiles, recordsByTable, fieldsByTable, actionId);
  }
}

async function tableRecords(
  client: ReferenceAuditClient,
  cache: Map<string, BitableRecord[]>,
  appToken: string,
  tableId: string
): Promise<BitableRecord[]> {
  const key = `${appToken}:${tableId}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const records = client.listBitableRecords ? await client.listBitableRecords(appToken, tableId) : [];
  cache.set(key, records);
  return records;
}

function firstLink(fields: Record<string, unknown> | undefined): string | undefined {
  if (!fields) return undefined;
  for (const value of Object.values(fields)) {
    const link = linkFromValue(value);
    if (link) return link;
  }
  return undefined;
}

function linkFromValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const link = linkFromValue(item);
      if (link) return link;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.link === 'string') return record.link;
    for (const child of Object.values(record)) {
      const link = linkFromValue(child);
      if (link) return link;
    }
  }
  return undefined;
}
